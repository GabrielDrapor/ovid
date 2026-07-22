/**
 * Reading progress sync utilities.
 *
 * Handles merging local (localStorage) and cloud (D1) reading progress
 * with correct UTC timestamp handling for cross-device sync.
 */

export interface ReadingProgress {
  chapter: number;
  xpath?: string;
  showOriginal?: boolean; // Undefined means "use default" (true)
  timestamp: number; // UTC milliseconds (Date.now())
}

export interface CloudProgress {
  chapter_number: number | null;
  paragraph_xpath: string | null;
  show_original: number | null;
  updated_at: string | null;
}

export const PROGRESS_KEY = (uuid: string) => `ovid_progress_v2_${uuid}`;

/**
 * Parse a D1 CURRENT_TIMESTAMP string as UTC milliseconds.
 *
 * D1/SQLite returns timestamps like "2024-03-24 13:00:00" (UTC, no timezone
 * indicator). JavaScript's `new Date()` parses these as **local time**, which
 * causes cloud timestamps to appear older than they really are by the user's
 * timezone offset. This breaks cross-device sync for anyone not in UTC.
 *
 * Fix: normalize to ISO 8601 with explicit 'Z' suffix before parsing.
 */
export function parseCloudTimestamp(ts: string | null | undefined): number {
  if (!ts) return 0;
  // Already has timezone info (e.g. ends with Z or +00:00)
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(ts)) {
    return new Date(ts).getTime() || 0;
  }
  // D1 format: "2024-03-24 13:00:00" → "2024-03-24T13:00:00Z"
  return new Date(ts.replace(' ', 'T') + 'Z').getTime() || 0;
}

/** Read progress from localStorage */
export function getLocalProgress(uuid: string): ReadingProgress {
  try {
    const saved = localStorage.getItem(PROGRESS_KEY(uuid));
    if (saved) {
      const progress = JSON.parse(saved) as ReadingProgress;
      if (progress.chapter >= 1) return progress;
    }
  } catch {
    // Ignore parse errors
  }

  // Fall back to old format for migration. Unknown save time → epoch so any
  // real cloud record beats it during merge.
  try {
    const oldSaved = localStorage.getItem(`ovid_progress_${uuid}`);
    if (oldSaved) {
      const chapter = parseInt(oldSaved, 10);
      if (chapter >= 1) return { chapter, timestamp: 0 };
    }
  } catch {
    // Ignore
  }

  // No local progress at all — timestamp 0 so cloud progress (if any) always wins.
  // Date.now() here would defeat cross-device sync on first open of a new device.
  return { chapter: 1, timestamp: 0 };
}

/**
 * Compute whole-book reading progress (0-100) with chapters weighted by
 * text length, so a long chapter advances the bar proportionally to how
 * much of the book it actually contains.
 *
 * `fraction` is how far through the current chapter the reader is (0-1).
 * When length data is missing or all-zero (older API responses, books
 * without translations yet), falls back to equal per-chapter weighting.
 */
export function computeReadingProgress(
  chapters: ReadonlyArray<{ text_length?: number | null }>,
  currentChapter: number,
  fraction: number
): number {
  const n = chapters.length;
  if (n === 0) return 0;
  const idx = Math.min(n, Math.max(1, currentChapter)) - 1;
  const f = Math.min(1, Math.max(0, fraction));

  const lengths = chapters.map((c) => c.text_length ?? 0);
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return Math.min(100, Math.round(((idx + f) / n) * 100));
  }

  let before = 0;
  for (let i = 0; i < idx; i++) before += lengths[i];
  return Math.min(100, Math.round(((before + f * lengths[idx]) / total) * 100));
}

/**
 * Merge local and cloud progress — the more recent one wins.
 *
 * Pure function (no side effects) for testability. The caller is responsible
 * for persisting the merged result to localStorage.
 */
export function mergeProgress(
  local: ReadingProgress,
  cloud: CloudProgress | null
): { merged: ReadingProgress; source: 'local' | 'cloud' } {
  if (!cloud?.chapter_number) {
    return { merged: local, source: 'local' };
  }

  const cloudTimestamp = parseCloudTimestamp(cloud.updated_at);

  if (cloudTimestamp > local.timestamp) {
    return {
      merged: {
        chapter: cloud.chapter_number,
        xpath: cloud.paragraph_xpath || undefined,
        showOriginal:
          cloud.show_original === null ? undefined : cloud.show_original === 1,
        timestamp: cloudTimestamp,
      },
      source: 'cloud',
    };
  }

  return { merged: local, source: 'local' };
}
