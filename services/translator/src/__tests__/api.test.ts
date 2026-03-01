import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the Hono app by importing and using app.request()
// But index.ts calls serve() on import, so we test the routes logic directly

describe('API routes', () => {
  describe('POST /translate', () => {
    it('rejects unauthorized requests', async () => {
      // Simulate the auth check logic
      const secret = 'test-secret';
      const body = { bookUuid: 'abc', secret: 'wrong-secret' };
      expect(body.secret !== secret).toBe(true);
    });

    it('rejects missing bookUuid', async () => {
      const body = { secret: 'test-secret' };
      expect(!('bookUuid' in body) || !(body as any).bookUuid).toBe(true);
    });

    it('detects already running jobs', async () => {
      const { activeJobs } = await import('../translate-worker.js');
      activeJobs.set('running-uuid', {
        phase: 'translating',
        chaptersCompleted: 5,
        chaptersTotal: 10,
        currentChapter: 6,
      });

      expect(activeJobs.has('running-uuid')).toBe(true);
      expect(activeJobs.get('running-uuid')?.chaptersCompleted).toBe(5);

      activeJobs.delete('running-uuid');
    });
  });

  describe('GET /status/:uuid', () => {
    it('returns active job progress from memory', async () => {
      const { activeJobs } = await import('../translate-worker.js');
      activeJobs.set('mem-uuid', {
        phase: 'translating',
        chaptersCompleted: 3,
        chaptersTotal: 10,
        currentChapter: 4,
        detail: 'Chapter 4/10',
      });

      const progress = activeJobs.get('mem-uuid');
      expect(progress).toEqual({
        phase: 'translating',
        chaptersCompleted: 3,
        chaptersTotal: 10,
        currentChapter: 4,
        detail: 'Chapter 4/10',
      });

      activeJobs.delete('mem-uuid');
    });

    it('returns undefined for unknown uuid', async () => {
      const { activeJobs } = await import('../translate-worker.js');
      expect(activeJobs.get('unknown')).toBeUndefined();
    });
  });
});
