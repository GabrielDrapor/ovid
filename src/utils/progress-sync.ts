/**
 * Sends reading progress to the server and keeps trying until it lands.
 *
 * Before this, every save was a fire-and-forget fetch: a 401 (session
 * expired) or a 5xx was dropped without a word, and the position only lived
 * in this device's localStorage. Now:
 * - only the newest position is kept; saves never run in parallel, so an
 *   older one can't land after a newer one;
 * - a network error, 429 or 5xx is retried with a growing delay (and right
 *   away when the browser comes back online);
 * - a 401 stops syncing and calls `onSignedOut` once;
 * - other 4xx answers are dropped (sending the same body again can't help).
 */

export interface ProgressBody {
  readingProgress: number;
  chapterNumber?: number;
  paragraphXpath?: string | null;
  showOriginal?: boolean;
}

export interface ProgressSyncOptions {
  /** The server says the session is gone. Called once. */
  onSignedOut?: () => void;
  /** Saving has failed this many times in a row (and keeps retrying). */
  onFailing?: () => void;
  /** Failures in a row before `onFailing` is called. */
  failingAfter?: number;
  /** Retry delays in ms; the last one repeats. */
  retryDelays?: number[];
  fetchImpl?: typeof fetch;
}

export interface ProgressSync {
  save(body: ProgressBody): void;
  /** Page is going away: hand the unsaved position to sendBeacon. */
  flushWithBeacon(body?: ProgressBody): void;
  dispose(): void;
}

const DEFAULT_DELAYS = [5_000, 15_000, 30_000, 60_000];

export function createProgressSync(
  bookUuid: string,
  options: ProgressSyncOptions = {}
): ProgressSync {
  const url = `/api/book/${bookUuid}/progress`;
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const delays = options.retryDelays ?? DEFAULT_DELAYS;
  const failingAfter = options.failingAfter ?? 3;

  let pending: ProgressBody | null = null;
  let inFlight = false;
  let failures = 0;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    clearRetry();
    const delay = delays[Math.min(failures - 1, delays.length - 1)];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void send();
    }, delay);
  };

  async function send(): Promise<void> {
    if (stopped || inFlight || !pending) return;
    clearRetry();
    const body = pending;
    inFlight = true;
    let outcome: 'ok' | 'retry' | 'drop' | 'signed-out';
    try {
      const res = await doFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) outcome = 'ok';
      else if (res.status === 401) outcome = 'signed-out';
      else if (res.status === 429 || res.status >= 500) outcome = 'retry';
      else outcome = 'drop';
    } catch {
      outcome = 'retry';
    }
    inFlight = false;
    if (stopped) return;

    if (outcome === 'signed-out') {
      stopped = true;
      pending = null;
      options.onSignedOut?.();
      return;
    }
    if (outcome === 'retry') {
      failures++;
      if (failures === failingAfter) options.onFailing?.();
      scheduleRetry();
      return;
    }
    failures = 0;
    // A newer position arrived while this one was in flight: send that too.
    if (pending === body) pending = null;
    else void send();
  }

  const onOnline = () => {
    if (pending && !inFlight) void send();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
  }

  return {
    save(body) {
      if (stopped) return;
      // Keep a showOriginal choice that hasn't reached the server yet.
      pending = { ...(pending ?? {}), ...body };
      if (retryTimer) return; // a retry is already waiting; it sends the newest
      void send();
    },
    flushWithBeacon(body) {
      if (stopped) return;
      const latest = body ? { ...(pending ?? {}), ...body } : pending;
      if (!latest || typeof navigator === 'undefined' || !navigator.sendBeacon)
        return;
      // The server takes POST for this, which is what sendBeacon sends.
      navigator.sendBeacon(
        url,
        new Blob([JSON.stringify(latest)], { type: 'application/json' })
      );
    },
    dispose() {
      stopped = true;
      clearRetry();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
      }
    },
  };
}
