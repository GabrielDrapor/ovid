import { describe, it, expect, vi } from 'vitest';
import { D1BindingClient } from '../../../src/worker/translation/d1-binding-client';

function makeFakeD1() {
  const prepared: Array<{ sql: string; params: unknown[] }> = [];
  const batches: Array<number> = [];
  const stmt = (sql: string) => ({
    bind: (...params: unknown[]) => {
      prepared.push({ sql, params });
      return {
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue(undefined),
      };
    },
  });
  const db = {
    prepare: vi.fn().mockImplementation(stmt),
    batch: vi.fn().mockImplementation(async (stmts: unknown[]) => {
      batches.push(stmts.length);
      return [];
    }),
  };
  return { db: db as unknown as D1Database, prepared, batches };
}

describe('D1BindingClient.batchInsert', () => {
  const COLUMNS = ['chapter_id', 'xpath', 'original_text', 'original_html', 'translated_text', 'order_index'];

  it('chunks rows to stay under 100 bound params per statement', async () => {
    const { db, prepared, batches } = makeFakeD1();
    const client = new D1BindingClient(db);
    // 6 columns → floor(100/6) = 16 rows per statement; 40 rows → 3 statements
    const rows = Array.from({ length: 40 }, (_, i) => [1, `/p[${i}]`, 'o', '<p>o</p>', 't', i]);

    await client.batchInsert('translations_v2', COLUMNS, rows);

    expect(batches).toEqual([3]);
    expect(prepared.length).toBe(3);
    expect(prepared[0].params.length).toBe(16 * 6);
    expect(prepared[2].params.length).toBe(8 * 6);
    // All statements go through one db.batch call (atomic-ish, single round)
    expect(prepared[0].sql).toContain('INSERT OR REPLACE INTO translations_v2');
  });

  it('honors conflict modes', async () => {
    const { db, prepared } = makeFakeD1();
    const client = new D1BindingClient(db);
    await client.batchInsert('t', ['a'], [[1]], 'ABORT');
    expect(prepared[0].sql).toMatch(/^INSERT INTO t/);
    await client.batchInsert('t', ['a'], [[1]], 'IGNORE');
    expect(prepared[1].sql).toContain('INSERT OR IGNORE');
  });

  it('no-ops on empty rows', async () => {
    const { db, batches } = makeFakeD1();
    const client = new D1BindingClient(db);
    await client.batchInsert('t', ['a'], []);
    expect(batches.length).toBe(0);
  });
});
