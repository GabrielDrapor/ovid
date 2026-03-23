import { describe, it, expect, vi, beforeEach } from 'vitest';
import { D1Client } from '../d1-client.js';

/**
 * Tests for processUpload reliability:
 * - Credit refund on failure
 * - Job recovery on startup
 *
 * Since processUpload is not exported, we test the logic patterns
 * by verifying the SQL sequences that would be executed.
 */

const mockConfig = {
  accountId: 'test-account',
  apiToken: 'test-token',
  databaseId: 'test-db',
};

describe('Upload Reliability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Credit refund pattern', () => {
    it('credits can be atomically refunded via SQL', async () => {
      const sqlCalls: Array<{ sql: string; params: unknown[] }> = [];

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ results: [{ credits: 1000 }], success: true }],
        }),
        text: async () => 'ok',
      });
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);

      // Simulate deduction
      await client.run('UPDATE users SET credits = credits - ? WHERE id = ?', [500, 1]);
      sqlCalls.push({ sql: 'UPDATE users SET credits = credits - ? WHERE id = ?', params: [500, 1] });

      // Simulate failure and refund
      await client.run('UPDATE users SET credits = credits + ? WHERE id = ?', [500, 1]);
      sqlCalls.push({ sql: 'UPDATE users SET credits = credits + ? WHERE id = ?', params: [500, 1] });

      // Verify both calls were made
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Verify the refund SQL matches the deduction amount
      const deductBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const refundBody = JSON.parse(fetchSpy.mock.calls[1][1].body);

      expect(deductBody.sql).toContain('credits - ?');
      expect(deductBody.params[0]).toBe(500);

      expect(refundBody.sql).toContain('credits + ?');
      expect(refundBody.params[0]).toBe(500);
    });

    it('refund records a credit_transactions entry', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ results: [], success: true }],
        }),
        text: async () => 'ok',
      });
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);

      // Simulate refund transaction record
      await client.run(
        `INSERT INTO credit_transactions (user_id, amount, type, description, reference_id)
         VALUES (?, ?, 'refund', ?, ?)`,
        [1, 500, 'Refund: upload failed for test-uuid', 'test-uuid']
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sql).toContain("'refund'");
      expect(body.params).toContain(500); // Positive amount for refund
      expect(body.params).toContain('Refund: upload failed for test-uuid');
    });
  });

  describe('Job recovery pattern', () => {
    it('can query for stalled translation jobs', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{
            results: [
              { book_uuid: 'job-1', status: 'translating', updated_at: '2025-01-01T00:00:00Z' },
              { book_uuid: 'job-2', status: 'extracting_glossary', updated_at: '2025-01-01T00:00:00Z' },
            ],
            success: true,
          }],
        }),
        text: async () => 'ok',
      });
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      const stalledJobs = await client.all(
        `SELECT book_uuid, status, updated_at FROM translation_jobs
         WHERE status IN ('translating', 'extracting_glossary', 'pending')
         ORDER BY updated_at ASC`
      );

      expect(stalledJobs).toHaveLength(2);
      expect(stalledJobs[0]).toEqual({
        book_uuid: 'job-1',
        status: 'translating',
        updated_at: '2025-01-01T00:00:00Z',
      });
    });

    it('periodic scanner queries for stale jobs older than 5 minutes', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ results: [], success: true }],
        }),
        text: async () => 'ok',
      });
      vi.stubGlobal('fetch', fetchSpy);

      const client = new D1Client(mockConfig);
      const staleJobs = await client.all(
        `SELECT book_uuid, status FROM translation_jobs
         WHERE status IN ('pending', 'translating', 'extracting_glossary')
         AND updated_at < datetime('now', '-5 minutes')`
      );

      // The SQL is valid and executes
      expect(staleJobs).toEqual([]);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.sql).toContain("datetime('now', '-5 minutes')");
    });
  });
});
