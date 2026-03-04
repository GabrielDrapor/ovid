import { describe, it, expect, vi } from 'vitest';
import { upsertUserBookProgress, updateReadingProgress, getUserBookProgress, getAllUserBookProgress } from '../../../src/worker/db';

function createMockDB(firstResult: any = null) {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const db = {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  } as any;
  return db;
}

describe('reading progress', () => {
  describe('upsertUserBookProgress', () => {
    it('sets is_completed and reading_progress on insert/conflict', async () => {
      const db = createMockDB();
      await upsertUserBookProgress(db, 1, 'book-uuid', true, 100);
      
      const sql = db.prepare.mock.calls[0][0] as string;
      expect(sql).toContain('INSERT INTO user_book_progress');
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('is_completed');
      expect(sql).toContain('reading_progress');
    });

    it('preserves completed_at when marking complete (uses COALESCE)', async () => {
      const db = createMockDB();
      await upsertUserBookProgress(db, 1, 'book-uuid', true, 100);
      
      const sql = db.prepare.mock.calls[0][0] as string;
      // Should use COALESCE to preserve existing completed_at
      expect(sql).toContain('COALESCE');
    });

    it('clears completed_at when explicitly marking incomplete', async () => {
      const db = createMockDB();
      await upsertUserBookProgress(db, 1, 'book-uuid', false, 50);
      
      const sql = db.prepare.mock.calls[0][0] as string;
      // When isCompleted=0, completed_at should be set to NULL
      expect(sql).toContain('WHEN ? = 0 THEN NULL');
    });

    it('binds correct number of parameters', async () => {
      const db = createMockDB();
      await upsertUserBookProgress(db, 1, 'book-uuid', true, 75);
      
      // Should have exactly 10 bind params:
      // userId, bookUuid, isCompletedInt, progress, isCompletedInt (INSERT completed_at CASE),
      // isCompletedInt (UPDATE is_completed), progress, progress (UPDATE reading_progress CASE),
      // isCompletedInt, isCompletedInt (UPDATE completed_at CASE)
      expect(db._statement.bind).toHaveBeenCalledWith(
        1, 'book-uuid', 1, 75, 1,  // INSERT values
        1, 75, 75, 1, 1             // UPDATE values
      );
    });

    it('binds correctly when readingProgress is undefined (null)', async () => {
      const db = createMockDB();
      await upsertUserBookProgress(db, 1, 'book-uuid', false);
      
      expect(db._statement.bind).toHaveBeenCalledWith(
        1, 'book-uuid', 0, null, 0,
        0, null, null, 0, 0
      );
    });
  });

  describe('updateReadingProgress', () => {
    it('updates only reading_progress without touching is_completed', async () => {
      const db = createMockDB();
      await updateReadingProgress(db, 1, 'book-uuid', 42);
      
      const sql = db.prepare.mock.calls[0][0] as string;
      expect(sql).toContain('UPDATE user_book_progress');
      expect(sql).toContain('reading_progress = ?');
      expect(sql).not.toContain('is_completed');
      expect(sql).not.toContain('completed_at');
    });

    it('creates a new row if none exists (changes=0)', async () => {
      const mockStatement = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn()
          .mockResolvedValueOnce({ success: true, meta: { changes: 0 } })  // UPDATE finds nothing
          .mockResolvedValueOnce({ success: true, meta: { changes: 1 } }), // INSERT succeeds
      };
      const db = {
        prepare: vi.fn().mockReturnValue(mockStatement),
        _statement: mockStatement,
      } as any;

      await updateReadingProgress(db, 1, 'book-uuid', 25);
      
      // Should have called prepare twice: UPDATE then INSERT
      expect(db.prepare).toHaveBeenCalledTimes(2);
      const insertSql = db.prepare.mock.calls[1][0] as string;
      expect(insertSql).toContain('INSERT INTO user_book_progress');
      expect(insertSql).toContain('is_completed');
    });

    it('does not insert when update succeeds (changes>0)', async () => {
      const db = createMockDB(); // default meta.changes = 1
      await updateReadingProgress(db, 1, 'book-uuid', 50);
      
      // Only one prepare call (the UPDATE)
      expect(db.prepare).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAllUserBookProgress', () => {
    it('queries all progress for a user in a single call', async () => {
      const mockResults = [
        { id: 1, user_id: 1, book_uuid: 'book-1', is_completed: 1, reading_progress: 100 },
        { id: 2, user_id: 1, book_uuid: 'book-2', is_completed: 0, reading_progress: 42 },
      ];
      const mockStatement = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: mockResults }),
      };
      const db = { prepare: vi.fn().mockReturnValue(mockStatement) } as any;

      const result = await getAllUserBookProgress(db, 1);
      
      expect(db.prepare).toHaveBeenCalledTimes(1);
      const sql = db.prepare.mock.calls[0][0] as string;
      expect(sql).toContain('SELECT * FROM user_book_progress');
      expect(sql).toContain('WHERE user_id = ?');
      expect(mockStatement.bind).toHaveBeenCalledWith(1);
      expect(result).toHaveLength(2);
      expect(result[0].book_uuid).toBe('book-1');
      expect(result[1].reading_progress).toBe(42);
    });
  });
});
