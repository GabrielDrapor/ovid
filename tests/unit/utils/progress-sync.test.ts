import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProgressSync } from '../../../src/utils/progress-sync';

const res = (status: number) =>
  ({ ok: status >= 200 && status < 300, status }) as Response;
const bodies = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('createProgressSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves with PUT to the book progress endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200));
    const sync = createProgressSync('b1', { fetchImpl });
    sync.save({
      readingProgress: 10,
      chapterNumber: 2,
      paragraphXpath: '/p[1]',
    });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/book/b1/progress');
    expect(fetchImpl.mock.calls[0][1].method).toBe('PUT');
    sync.dispose();
  });

  it('retries a 5xx or network error until it lands, and says so after 3 failures', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(res(500))
      .mockResolvedValue(res(200));
    const onFailing = vi.fn();
    const sync = createProgressSync('b1', {
      fetchImpl,
      onFailing,
      retryDelays: [100, 200],
    });
    sync.save({ readingProgress: 10, chapterNumber: 2 });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(onFailing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onFailing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // Nothing left to send once it landed.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    sync.dispose();
  });

  it('sends only the newest position after a failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(502))
      .mockResolvedValue(res(200));
    const sync = createProgressSync('b1', { fetchImpl, retryDelays: [100] });
    sync.save({ readingProgress: 10, chapterNumber: 2 });
    await flush();
    sync.save({ readingProgress: 20, chapterNumber: 3 });
    sync.save({ readingProgress: 30, chapterNumber: 4 });
    await vi.advanceTimersByTimeAsync(100);
    expect(bodies(fetchImpl).map((b) => b.chapterNumber)).toEqual([2, 4]);
    sync.dispose();
  });

  it('never runs two saves at once; a save made meanwhile follows', async () => {
    let release!: (r: Response) => void;
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
      .mockResolvedValue(res(200));
    const sync = createProgressSync('b1', { fetchImpl });
    sync.save({ readingProgress: 10, chapterNumber: 2 });
    sync.save({ readingProgress: 20, chapterNumber: 3 });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(res(200));
    await flush();
    expect(bodies(fetchImpl).map((b) => b.chapterNumber)).toEqual([2, 3]);
    sync.dispose();
  });

  it('keeps an unsent showOriginal choice when a position save follows', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(500))
      .mockResolvedValue(res(200));
    const sync = createProgressSync('b1', { fetchImpl, retryDelays: [100] });
    sync.save({ readingProgress: 10, chapterNumber: 2, showOriginal: false });
    await flush();
    sync.save({ readingProgress: 12, chapterNumber: 2 });
    await vi.advanceTimersByTimeAsync(100);
    expect(bodies(fetchImpl)[1]).toMatchObject({
      readingProgress: 12,
      showOriginal: false,
    });
    sync.dispose();
  });

  it('stops on 401 and reports it once', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(401));
    const onSignedOut = vi.fn();
    const sync = createProgressSync('b1', {
      fetchImpl,
      onSignedOut,
      retryDelays: [100],
    });
    sync.save({ readingProgress: 10, chapterNumber: 2 });
    await flush();
    sync.save({ readingProgress: 20, chapterNumber: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it('drops a body the server rejects as invalid instead of retrying it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(400));
    const sync = createProgressSync('b1', { fetchImpl, retryDelays: [100] });
    sync.save({ readingProgress: 10, chapterNumber: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it('retries right away when the browser comes back online', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(res(200));
    const sync = createProgressSync('b1', { fetchImpl, retryDelays: [60_000] });
    sync.save({ readingProgress: 10, chapterNumber: 2 });
    await flush();
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    sync.dispose();
  });

  it('hands a save still waiting for a retry to sendBeacon when the page hides', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beacon,
      configurable: true,
    });
    const fetchImpl = vi.fn().mockResolvedValue(res(503));
    const sync = createProgressSync('b1', { fetchImpl, retryDelays: [60_000] });
    sync.save({ readingProgress: 10, chapterNumber: 2, showOriginal: true });
    await flush();
    sync.flushWithBeacon({
      readingProgress: 15,
      chapterNumber: 2,
      paragraphXpath: '/p[3]',
    });
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe('/api/book/b1/progress');
    expect(JSON.parse(await blob.text())).toEqual({
      readingProgress: 15,
      chapterNumber: 2,
      paragraphXpath: '/p[3]',
      showOriginal: true,
    });
    sync.dispose();
  });
});
