import { describe, it, expect, vi } from 'vitest';
import { resolveOrCreateShelfSlot, moveBookToSlot } from '../../../src/worker/db';

/**
 * A more capable D1 mock than book-handlers.test.ts's shared-statement one:
 * `resolveOrCreateShelfSlot`/`moveBookToSlot` issue several distinct queries
 * per call, so responses are dispatched by matching the prepared SQL text.
 */
function createMockDB(
  opts: {
    findShelfSlotResults?: (Record<string, unknown> | null)[];
    slotByIdResult?: Record<string, unknown> | null;
    bookLookupResult?: Record<string, unknown> | null;
    siblingsResult?: Record<string, unknown>[];
    sourceSlotResult?: Record<string, unknown> | null;
    targetSlotPublicResult?: Record<string, unknown> | null;
  } = {}
) {
  const findShelfSlotQueue = [...(opts.findShelfSlotResults ?? [])];
  const batches: any[][] = [];
  let runCalls = 0;

  const db: any = {
    prepare: vi.fn((sql: string) => {
      const stmt: any = {
        _sql: sql,
        _args: [] as unknown[],
        bind: (...args: unknown[]) => {
          stmt._args = args;
          return stmt;
        },
        first: vi.fn(async () => {
          if (sql.includes('FROM shelf_slots WHERE id = ? AND shelf_id = ?')) {
            return opts.slotByIdResult ?? null;
          }
          if (sql.includes('JOIN shelf_slots')) {
            return opts.sourceSlotResult ?? null;
          }
          if (sql.includes('SELECT is_public FROM shelf_slots WHERE id = ?')) {
            return opts.targetSlotPublicResult ?? null;
          }
          if (sql.includes('FROM shelf_slots WHERE shelf_id = ? AND row = ? AND col = ?')) {
            return findShelfSlotQueue.length > 0 ? (findShelfSlotQueue.shift() ?? null) : null;
          }
          if (sql.includes('COALESCE(MAX(sort_order)')) {
            return { next_order: 0 };
          }
          if (sql.includes('FROM books_v2 WHERE uuid = ?')) {
            return opts.bookLookupResult ?? null;
          }
          return null;
        }),
        all: vi.fn(async () => ({ results: opts.siblingsResult ?? [] })),
        run: vi.fn(async () => {
          runCalls++;
          return { success: true, meta: { changes: 1 } };
        }),
      };
      return stmt;
    }),
    batch: vi.fn(async (statements: any[]) => {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    }),
    _batches: batches,
    get _runCalls() {
      return runCalls;
    },
  };
  return db;
}

describe('resolveOrCreateShelfSlot', () => {
  it('returns a provided slotId after validating it exists', async () => {
    const db = createMockDB({ slotByIdResult: { id: 42, row: 0, col: 0 } });
    const result = await resolveOrCreateShelfSlot(db, { slotId: 42 });
    expect(result).toBe(42);
  });

  it('falls back to (row, col) when the provided slotId does not exist', async () => {
    const db = createMockDB({
      slotByIdResult: null,
      findShelfSlotResults: [{ id: 8 }],
    });
    const result = await resolveOrCreateShelfSlot(db, {
      slotId: 42,
      row: 1,
      col: 2,
    });
    expect(result).toBe(8);
  });

  it('falls back to (row, col) when the slotId exists but its coordinates mismatch', async () => {
    const db = createMockDB({
      slotByIdResult: { id: 42, row: 9, col: 9 },
      findShelfSlotResults: [{ id: 8 }],
    });
    const result = await resolveOrCreateShelfSlot(db, {
      slotId: 42,
      row: 1,
      col: 2,
    });
    expect(result).toBe(8);
  });

  it('returns null for a nonexistent slotId with no coordinates to fall back to', async () => {
    const db = createMockDB({ slotByIdResult: null });
    expect(await resolveOrCreateShelfSlot(db, { slotId: 42 })).toBeNull();
  });

  it('returns null for a null target', async () => {
    const db = createMockDB();
    expect(await resolveOrCreateShelfSlot(db, null)).toBeNull();
  });

  it('returns null when row or col is missing', async () => {
    const db = createMockDB();
    expect(await resolveOrCreateShelfSlot(db, { row: 1 })).toBeNull();
    expect(await resolveOrCreateShelfSlot(db, { col: 1 })).toBeNull();
  });

  it('returns an existing slot id without creating one', async () => {
    const db = createMockDB({ findShelfSlotResults: [{ id: 7 }] });
    const result = await resolveOrCreateShelfSlot(db, { row: 1, col: 2 });
    expect(result).toBe(7);
    expect(db._runCalls).toBe(0);
  });

  it('creates a new slot when none exists', async () => {
    const db = createMockDB({ findShelfSlotResults: [null, { id: 99 }] });
    const result = await resolveOrCreateShelfSlot(db, { row: 3, col: 4 });
    expect(result).toBe(99);
  });

  it('retries when a concurrent request races the same coordinate', async () => {
    const db = createMockDB({ findShelfSlotResults: [null, null, { id: 5 }] });
    const result = await resolveOrCreateShelfSlot(db, { row: 0, col: 0 });
    expect(result).toBe(5);
  });

  it('throws after exhausting retries', async () => {
    const db = createMockDB({ findShelfSlotResults: [null, null, null, null] });
    await expect(resolveOrCreateShelfSlot(db, { row: 0, col: 0 })).rejects.toThrow(
      'Failed to create shelf slot'
    );
  });
});

describe('moveBookToSlot', () => {
  const validSlot3 = { slotByIdResult: { id: 3, row: 0, col: 0 } };

  it('throws when the book does not exist', async () => {
    const db = createMockDB({ ...validSlot3, bookLookupResult: null });
    await expect(moveBookToSlot(db, 'missing-uuid', 1, { slotId: 3 }, 0)).rejects.toThrow(
      'Book not found'
    );
  });

  it('throws Forbidden when the book belongs to another user', async () => {
    const db = createMockDB({ ...validSlot3, bookLookupResult: { id: 1, user_id: 2 } });
    await expect(moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, 0)).rejects.toThrow('Forbidden');
  });

  it('throws Forbidden for a public (ownerless) book', async () => {
    const db = createMockDB({ ...validSlot3, bookLookupResult: { id: 1, user_id: null } });
    await expect(moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, 0)).rejects.toThrow('Forbidden');
  });

  it('throws Invalid target when no slotId/row/col resolves to a slot', async () => {
    const db = createMockDB({ bookLookupResult: { id: 1, user_id: 1 } });
    await expect(moveBookToSlot(db, 'uuid', 1, {}, 0)).rejects.toThrow('Invalid target');
  });

  it('throws Invalid target for a nonexistent slotId with no fallback coordinates', async () => {
    const db = createMockDB({
      slotByIdResult: null,
      bookLookupResult: { id: 1, user_id: 1 },
    });
    await expect(moveBookToSlot(db, 'uuid', 1, { slotId: 999 }, 0)).rejects.toThrow(
      'Invalid target'
    );
  });

  it('lands at insertIndex by shifting later siblings right in a single batch', async () => {
    const db = createMockDB({
      ...validSlot3,
      bookLookupResult: { id: 10, user_id: 1 },
      siblingsResult: [
        { book_id: 1, position: 0 },
        { book_id: 2, position: 1 },
        { book_id: 3, position: 2 },
      ],
    });

    const result = await moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, 1);

    // Lands at sibling[1]'s position; siblings at/after shift right.
    expect(result).toEqual({ shelfSlotId: 3, position: 1 });
    expect(db.batch).toHaveBeenCalledTimes(1);
    const statements = db._batches[0];
    expect(statements).toHaveLength(2);

    const shift = statements.find((s: any) => s._sql.includes('position = position + 1'));
    expect(shift._args).toEqual([3, 1, 10]); // slot 3, positions >= 1, excluding book 10

    const upsert = statements.find((s: any) => s._sql.includes('ON CONFLICT(book_id)'));
    expect(upsert._args).toEqual([10, 3, 1]);
  });

  it('clamps a negative insertIndex to the start', async () => {
    const db = createMockDB({
      ...validSlot3,
      bookLookupResult: { id: 10, user_id: 1 },
      siblingsResult: [{ book_id: 1, position: 0 }],
    });
    const result = await moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, -5);
    expect(result.position).toBe(0);
  });

  it('clamps an out-of-range insertIndex to one past the last sibling', async () => {
    const db = createMockDB({
      ...validSlot3,
      bookLookupResult: { id: 10, user_id: 1 },
      siblingsResult: [{ book_id: 1, position: 0 }],
    });
    const result = await moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, 999);
    expect(result.position).toBe(1);
  });

  it('preserves position gaps when appending after non-contiguous siblings', async () => {
    const db = createMockDB({
      ...validSlot3,
      bookLookupResult: { id: 10, user_id: 1 },
      siblingsResult: [
        { book_id: 1, position: 2 },
        { book_id: 2, position: 7 },
      ],
    });
    const result = await moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, 5);
    expect(result.position).toBe(8); // last sibling position + 1, not index-based
  });

  it('resolves a (row, col) target into a new slot when no slotId is given', async () => {
    const db = createMockDB({
      bookLookupResult: { id: 10, user_id: 1 },
      findShelfSlotResults: [null, { id: 55 }],
      siblingsResult: [],
    });
    const result = await moveBookToSlot(db, 'uuid', 1, { row: 2, col: 3 }, 0);
    expect(result).toEqual({ shelfSlotId: 55, position: 0 });
  });

  it('rejects moving a book off a public shelf', async () => {
    const db = createMockDB({
      ...validSlot3,
      bookLookupResult: { id: 10, user_id: 1 },
      sourceSlotResult: { is_public: 1 },
    });
    await expect(moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, 0)).rejects.toThrow(
      'Forbidden: books cannot be moved off a public shelf'
    );
  });

  it('rejects moving a book onto a public shelf', async () => {
    const db = createMockDB({
      ...validSlot3,
      bookLookupResult: { id: 10, user_id: 1 },
      targetSlotPublicResult: { is_public: 1 },
    });
    await expect(moveBookToSlot(db, 'uuid', 1, { slotId: 3 }, 0)).rejects.toThrow(
      'Forbidden: books cannot be moved onto a public shelf'
    );
    expect(db.batch).not.toHaveBeenCalled();
  });
});
