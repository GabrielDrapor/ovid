import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseCloudTimestamp,
  getLocalProgress,
  mergeProgress,
  PROGRESS_KEY,
  type ReadingProgress,
  type CloudProgress,
} from '../../../src/utils/reading-progress';

describe('reading-progress', () => {
  describe('parseCloudTimestamp', () => {
    it('returns 0 for null/undefined/empty', () => {
      expect(parseCloudTimestamp(null)).toBe(0);
      expect(parseCloudTimestamp(undefined)).toBe(0);
      expect(parseCloudTimestamp('')).toBe(0);
    });

    it('parses D1 CURRENT_TIMESTAMP format as UTC', () => {
      // D1 returns "2024-03-24 13:00:00" — this is UTC
      const ts = parseCloudTimestamp('2024-03-24 13:00:00');
      const expected = Date.UTC(2024, 2, 24, 13, 0, 0); // March = month 2
      expect(ts).toBe(expected);
    });

    it('parses ISO 8601 with Z suffix correctly', () => {
      const ts = parseCloudTimestamp('2024-03-24T13:00:00Z');
      const expected = Date.UTC(2024, 2, 24, 13, 0, 0);
      expect(ts).toBe(expected);
    });

    it('parses ISO 8601 with timezone offset correctly', () => {
      const ts = parseCloudTimestamp('2024-03-24T21:00:00+08:00');
      const expected = Date.UTC(2024, 2, 24, 13, 0, 0); // 21:00 +08:00 = 13:00 UTC
      expect(ts).toBe(expected);
    });

    it('handles D1 format consistently regardless of local timezone', () => {
      // The core bug: "2024-03-24 13:00:00" must always parse to the same
      // UTC millisecond value, no matter what timezone the browser is in.
      const ts1 = parseCloudTimestamp('2024-03-24 13:00:00');
      const ts2 = parseCloudTimestamp('2024-03-24T13:00:00Z');
      expect(ts1).toBe(ts2);
    });

    it('returns 0 for garbage input', () => {
      expect(parseCloudTimestamp('not-a-date')).toBe(0);
    });
  });

  describe('getLocalProgress', () => {
    const uuid = 'test-uuid-123';

    beforeEach(() => {
      localStorage.clear();
    });

    it('returns chapter 1 when no saved progress', () => {
      const progress = getLocalProgress(uuid);
      expect(progress.chapter).toBe(1);
      expect(progress.timestamp).toBeGreaterThan(0);
    });

    it('reads new format from localStorage', () => {
      const saved: ReadingProgress = { chapter: 5, xpath: '/body[1]/p[3]', timestamp: 1000 };
      localStorage.setItem(PROGRESS_KEY(uuid), JSON.stringify(saved));

      const progress = getLocalProgress(uuid);
      expect(progress.chapter).toBe(5);
      expect(progress.xpath).toBe('/body[1]/p[3]');
      expect(progress.timestamp).toBe(1000);
    });

    it('falls back to old format', () => {
      localStorage.setItem(`ovid_progress_${uuid}`, '7');

      const progress = getLocalProgress(uuid);
      expect(progress.chapter).toBe(7);
    });

    it('prefers new format over old format', () => {
      localStorage.setItem(PROGRESS_KEY(uuid), JSON.stringify({ chapter: 5, timestamp: 1000 }));
      localStorage.setItem(`ovid_progress_${uuid}`, '3');

      const progress = getLocalProgress(uuid);
      expect(progress.chapter).toBe(5);
    });

    it('ignores invalid JSON', () => {
      localStorage.setItem(PROGRESS_KEY(uuid), 'not-json');

      const progress = getLocalProgress(uuid);
      expect(progress.chapter).toBe(1);
    });

    it('ignores chapter < 1', () => {
      localStorage.setItem(PROGRESS_KEY(uuid), JSON.stringify({ chapter: 0, timestamp: 1000 }));

      const progress = getLocalProgress(uuid);
      expect(progress.chapter).toBe(1);
    });
  });

  describe('mergeProgress', () => {
    const makeLocal = (chapter: number, timestamp: number, xpath?: string): ReadingProgress => ({
      chapter,
      timestamp,
      xpath,
    });

    const makeCloud = (
      chapter: number | null,
      updatedAt: string | null,
      xpath?: string | null
    ): CloudProgress => ({
      chapter_number: chapter,
      paragraph_xpath: xpath ?? null,
      updated_at: updatedAt,
    });

    it('returns local when cloud is null', () => {
      const local = makeLocal(4, 1000);
      const { merged, source } = mergeProgress(local, null);
      expect(source).toBe('local');
      expect(merged.chapter).toBe(4);
    });

    it('returns local when cloud has no chapter', () => {
      const local = makeLocal(4, 1000);
      const cloud = makeCloud(null, '2024-03-24 13:00:00');
      const { merged, source } = mergeProgress(local, cloud);
      expect(source).toBe('local');
      expect(merged.chapter).toBe(4);
    });

    it('returns cloud when cloud timestamp is newer', () => {
      // Local saved at a specific UTC time
      const localTs = Date.UTC(2024, 2, 24, 12, 0, 0); // 12:00 UTC
      const local = makeLocal(4, localTs, '/body[1]/p[10]');

      // Cloud updated at 13:00 UTC (1 hour later)
      const cloud = makeCloud(5, '2024-03-24 13:00:00', '/body[1]/p[3]');

      const { merged, source } = mergeProgress(local, cloud);
      expect(source).toBe('cloud');
      expect(merged.chapter).toBe(5);
      expect(merged.xpath).toBe('/body[1]/p[3]');
    });

    it('returns local when local timestamp is newer', () => {
      const localTs = Date.UTC(2024, 2, 24, 14, 0, 0); // 14:00 UTC
      const local = makeLocal(6, localTs, '/body[1]/p[20]');

      // Cloud at 13:00 UTC (1 hour earlier)
      const cloud = makeCloud(5, '2024-03-24 13:00:00', '/body[1]/p[3]');

      const { merged, source } = mergeProgress(local, cloud);
      expect(source).toBe('local');
      expect(merged.chapter).toBe(6);
    });

    it('cross-device scenario: Device A ch4, Device B ch5, Device A refresh', () => {
      // Device A saved chapter 4 at 12:00 UTC
      const deviceALocal = makeLocal(4, Date.UTC(2024, 2, 24, 12, 0, 0));

      // Device B later saved chapter 5 at 13:00 UTC to the cloud
      const cloud = makeCloud(5, '2024-03-24 13:00:00', '/body[1]/p[5]');

      // When Device A refreshes, cloud should win
      const { merged, source } = mergeProgress(deviceALocal, cloud);
      expect(source).toBe('cloud');
      expect(merged.chapter).toBe(5);
      expect(merged.xpath).toBe('/body[1]/p[5]');
    });

    it('handles cloud with null xpath gracefully', () => {
      const local = makeLocal(3, Date.UTC(2024, 2, 24, 10, 0, 0));
      const cloud = makeCloud(5, '2024-03-24 13:00:00', null);

      const { merged } = mergeProgress(local, cloud);
      expect(merged.chapter).toBe(5);
      expect(merged.xpath).toBeUndefined();
    });

    it('handles cloud with empty string xpath', () => {
      const local = makeLocal(3, Date.UTC(2024, 2, 24, 10, 0, 0));
      const cloud = makeCloud(5, '2024-03-24 13:00:00', '');

      const { merged } = mergeProgress(local, cloud);
      expect(merged.xpath).toBeUndefined();
    });

    it('handles cloud with no updated_at (timestamp 0)', () => {
      const local = makeLocal(4, 1000);
      const cloud = makeCloud(5, null);

      // Cloud timestamp is 0, local timestamp is 1000 → local wins
      const { merged, source } = mergeProgress(local, cloud);
      expect(source).toBe('local');
      expect(merged.chapter).toBe(4);
    });

    it('handles equal timestamps — local wins (tie-break)', () => {
      const ts = Date.UTC(2024, 2, 24, 12, 0, 0);
      const local = makeLocal(4, ts);
      const cloud = makeCloud(5, '2024-03-24 12:00:00');

      // Equal timestamp → cloudTimestamp is NOT > local.timestamp → local wins
      const { merged, source } = mergeProgress(local, cloud);
      expect(source).toBe('local');
      expect(merged.chapter).toBe(4);
    });
  });
});
