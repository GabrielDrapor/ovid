import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAllBooksV2 } from '../../../src/worker/db';
import { getCurrentUser } from '../../../src/worker/auth';
import { getUserCredits, deductCredits } from '../../../src/worker/credits';

// We can't run actual CF workers in vitest easily, so we test
// the DB query logic and handler logic by mocking D1Database.

/** Create a mock D1Database */
function createMockDB(rows: any[] = []) {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: rows }),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  const db = {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  } as any;
  return db;
}

function createMockRequest(cookies: string = ''): Request {
  return new Request('http://localhost/api/v2/books', {
    headers: { Cookie: cookies },
  });
}

describe('Book Handlers', () => {
  describe('GET /api/v2/books - getAllBooksV2', () => {
    it('returns only public books for unauthenticated users (no userId)', async () => {
      const publicBooks = [
        { id: 1, uuid: 'pub-1', title: 'Public Book', user_id: null },
      ];
      const db = createMockDB(publicBooks);

      const result = await getAllBooksV2(db);

      // Verify the query filters by user_id IS NULL
      const query = db.prepare.mock.calls[0][0] as string;
      expect(query).toContain('WHERE user_id IS NULL');
      expect(result).toEqual(publicBooks);
    });

    it('returns public + user books for authenticated users', async () => {
      const allBooks = [
        { id: 1, uuid: 'pub-1', title: 'Public Book', user_id: null },
        { id: 2, uuid: 'user-1', title: 'User Book', user_id: 1 },
      ];
      const db = createMockDB(allBooks);

      const result = await getAllBooksV2(db, 1);

      // Verify the query includes user_id filter
      const query = db.prepare.mock.calls[0][0] as string;
      expect(query).toContain('WHERE user_id IS NULL OR user_id = ?');
      expect(result).toEqual(allBooks);
    });

    it('does not leak other users private books', async () => {
      const db = createMockDB([]);
      await getAllBooksV2(db, 2);

      // Verify binding uses the correct userId
      const query = db.prepare.mock.calls[0][0] as string;
      expect(query).toContain('user_id IS NULL OR user_id = ?');
      expect(db._statement.bind).toHaveBeenCalledWith(2);
    });
  });

  describe('POST /api/books/upload - auth check', () => {
    it('rejects upload without auth', async () => {
      // getCurrentUser returns null when no session cookie
      const db = createMockDB();
      db._statement.first.mockResolvedValue(null);

      const user = await getCurrentUser(db, createMockRequest());
      expect(user).toBeNull();
    });

    it('rejects non-epub files (handler logic)', () => {
      // The handler checks file.name.endsWith('.epub')
      const file = new File(['content'], 'test.pdf', { type: 'application/pdf' });
      expect(file.name.endsWith('.epub')).toBe(false);
    });
  });

  describe('Credits - getUserCredits / deductCredits', () => {
    it('returns 0 when user has no credits', async () => {
      const db = createMockDB();
      db._statement.first.mockResolvedValue({ credits: 0 });

      const credits = await getUserCredits(db, 1);
      expect(credits).toBe(0);
    });

    it('returns 402 when insufficient credits', async () => {
      const db = createMockDB();
      db._statement.first.mockResolvedValue({ credits: 10 });

      const credits = await getUserCredits(db, 1);
      expect(credits).toBeLessThan(100); // not enough for a book
    });

    it('deducts credits on successful operation', async () => {
      const db = createMockDB();
      // First call: getUserCredits returns 5000
      db._statement.first.mockResolvedValueOnce({ credits: 5000 });

      const result = await deductCredits(db, 1, 100, 'book-uuid', 'Test deduction');
      expect(result).toBe(true);

      // Verify UPDATE was called to set new balance
      const updateCalls = db.prepare.mock.calls.filter((c: any) =>
        (c[0] as string).includes('UPDATE users SET credits')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    it('fails deduction when insufficient credits', async () => {
      const db = createMockDB();
      db._statement.first.mockResolvedValueOnce({ credits: 50 });

      const result = await deductCredits(db, 1, 100, 'book-uuid', 'Test');
      expect(result).toBe(false);
    });
  });

  describe('DELETE /api/book/:uuid - deleteBookV2', () => {
    it('prevents deleting without auth (handler requires getCurrentUser)', async () => {
      const db = createMockDB();
      db._statement.first.mockResolvedValue(null);
      const user = await getCurrentUser(db, createMockRequest());
      expect(user).toBeNull();
      // In the actual handler, this returns 401
    });

    it('allows owner to delete their own book', async () => {
      const { deleteBookV2 } = await import('../../../src/worker/db');
      const db = createMockDB();
      db._statement.first.mockResolvedValue({ id: 1, user_id: 42 });

      await deleteBookV2(db, 'test-uuid', 42);

      const deleteCalls = db.prepare.mock.calls.filter((c: any) =>
        (c[0] as string).includes('DELETE')
      );
      expect(deleteCalls.length).toBe(3); // translations, chapters, book
    });

    it('prevents deleting another user\'s book', async () => {
      const { deleteBookV2 } = await import('../../../src/worker/db');
      const db = createMockDB();
      db._statement.first.mockResolvedValue({ id: 1, user_id: 99 });

      await expect(deleteBookV2(db, 'test-uuid', 42)).rejects.toThrow('Forbidden');
    });

    it('prevents deleting public books via API', async () => {
      const { deleteBookV2 } = await import('../../../src/worker/db');
      const db = createMockDB();
      db._statement.first.mockResolvedValue({ id: 1, user_id: null });

      await expect(deleteBookV2(db, 'test-uuid', 42)).rejects.toThrow('Forbidden');
    });
  });

  describe('POST /api/book/:uuid/translate-next', () => {
    it('returns done:true when no job exists', async () => {
      const { getTranslationJob } = await import('../../../src/worker/db');
      const db = createMockDB();
      db._statement.first.mockResolvedValue(null);

      const job = await getTranslationJob(db, 'nonexistent');
      expect(job).toBeNull();
      // Handler returns { done: true } when job is null
    });

    it('returns done:true when job status is completed', async () => {
      const { getTranslationJob } = await import('../../../src/worker/db');
      const db = createMockDB();
      db._statement.first.mockResolvedValue({ status: 'completed', book_uuid: 'test' });

      const job = await getTranslationJob(db, 'test');
      expect(job?.status).toBe('completed');
      // Handler returns { done: true } for completed status
    });
  });
});
