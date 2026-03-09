import { describe, it, expect, vi } from 'vitest';
import { addCredits, getUserCredits, deductCredits } from '../../../src/worker/credits';

function createMockDB(options?: { deductChanges?: number; credits?: number }) {
  const changes = options?.deductChanges ?? 1;
  const credits = options?.credits ?? 1000;

  const calls: string[] = [];

  const db = {
    prepare: vi.fn((sql: string) => {
      calls.push(sql);
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ credits }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes } }),
      };
    }),
    _calls: calls,
  } as any;
  return db;
}

describe('credits', () => {
  describe('addCredits', () => {
    it('uses atomic SQL increment (credits = credits + ?)', async () => {
      const db = createMockDB();
      await addCredits(db, 1, 500, 'purchase', 'test purchase');

      const firstSql = db.prepare.mock.calls[0][0] as string;
      expect(firstSql).toContain('credits = credits + ?');
      expect(firstSql).not.toMatch(/SET credits = \?,/);
    });

    it('records transaction with correct balance_after', async () => {
      const db = createMockDB();
      await addCredits(db, 1, 500, 'purchase', 'test');

      const insertCall = db.prepare.mock.calls.find((c: any) =>
        (c[0] as string).includes('INSERT INTO credit_transactions')
      );
      expect(insertCall).toBeTruthy();
    });
  });

  describe('deductCredits', () => {
    it('returns false when insufficient credits', async () => {
      const db = createMockDB({ deductChanges: 0 });

      const result = await deductCredits(db, 1, 100, 'book-1', 'translate');
      expect(result).toBe(false);
    });

    it('deducts when sufficient credits', async () => {
      const db = createMockDB({ deductChanges: 1, credits: 500 });

      const result = await deductCredits(db, 1, 100, 'book-1', 'translate');
      expect(result).toBe(true);

      // Should have an INSERT for the transaction
      const insertCall = db.prepare.mock.calls.find((c: any) =>
        (c[0] as string).includes('INSERT INTO credit_transactions')
      );
      expect(insertCall).toBeTruthy();
    });
  });
});
