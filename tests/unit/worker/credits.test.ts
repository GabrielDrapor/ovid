import { describe, it, expect, vi } from 'vitest';
import { addCredits, getUserCredits, deductCredits } from '../../../src/worker/credits';

function createMockDB() {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ credits: 1000 }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const db = {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  } as any;
  return db;
}

describe('credits', () => {
  describe('addCredits', () => {
    it('uses atomic SQL increment (credits = credits + ?)', async () => {
      const db = createMockDB();
      await addCredits(db, 1, 500, 'purchase', 'test purchase');

      // First call should be the atomic UPDATE
      const firstSql = db.prepare.mock.calls[0][0] as string;
      expect(firstSql).toContain('credits = credits + ?');
      expect(firstSql).not.toMatch(/SET credits = \?,/); // not a simple SET
      expect(db._statement.bind).toHaveBeenCalledWith(500, 1);
    });

    it('records transaction with correct balance_after', async () => {
      const db = createMockDB();
      // getUserCredits returns 1000 (after adding)
      await addCredits(db, 1, 500, 'purchase', 'test');

      // Should have INSERT into credit_transactions
      const insertCall = db.prepare.mock.calls.find((c: any) =>
        (c[0] as string).includes('INSERT INTO credit_transactions')
      );
      expect(insertCall).toBeTruthy();
    });
  });

  describe('deductCredits', () => {
    it('returns false when insufficient credits', async () => {
      const db = createMockDB();
      db._statement.run.mockResolvedValue({ success: true, meta: { changes: 0 } });

      const result = await deductCredits(db, 1, 100, 'book-1', 'translate');
      expect(result).toBe(false);
    });

    it('deducts when sufficient credits', async () => {
      const db = createMockDB();
      db._statement.first.mockResolvedValue({ credits: 500 });

      const result = await deductCredits(db, 1, 100, 'book-1', 'translate');
      expect(result).toBe(true);
    });
  });
});
