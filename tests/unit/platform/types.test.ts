import { describe, it, expect } from 'vitest';
import type {
  OvidDatabase,
  OvidStorage,
  OvidBoundStatement,
} from '../../../src/platform/types';

/**
 * These interfaces exist so handlers run on both Workers (D1/R2 bindings) and
 * a self-hosted Node server (SQLite/filesystem). The contract that matters is
 * that a hand-written implementation — i.e. what the self-host adapter will
 * be — satisfies them and drives real handler code.
 */

function createMemoryDb(rows: Record<string, unknown>[] = []): OvidDatabase {
  const calls: { sql: string; params: unknown[] }[] = [];
  const make = (sql: string, params: unknown[]): OvidBoundStatement => ({
    async first<T>() {
      calls.push({ sql, params });
      return (rows[0] as T) ?? null;
    },
    async all<T>() {
      calls.push({ sql, params });
      return { results: rows as T[] };
    },
    async run() {
      calls.push({ sql, params });
      return { meta: { changes: rows.length } };
    },
  });
  return {
    prepare(sql: string) {
      return {
        bind: (...params: unknown[]) => make(sql, params),
        ...make(sql, []),
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run())) as Promise<never[]>;
    },
  };
}

function createMemoryStorage(): OvidStorage {
  const store = new Map<
    string,
    { data: ArrayBuffer; meta: Record<string, unknown> }
  >();
  return {
    async get(key) {
      const found = store.get(key);
      if (!found) return null;
      return {
        body: null,
        arrayBuffer: async () => found.data,
        ...found.meta,
      };
    },
    async put(key, value, options) {
      const data =
        typeof value === 'string'
          ? new TextEncoder().encode(value).buffer
          : ((value as ArrayBuffer) ?? new ArrayBuffer(0));
      store.set(key, { data: data as ArrayBuffer, meta: options ?? {} });
      return undefined;
    },
    async head(key) {
      const found = store.get(key);
      return found ? found.meta : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe('platform interfaces', () => {
  it('a hand-written database satisfies the interface end to end', async () => {
    const db = createMemoryDb([{ id: 7, title: 'Ovid' }]);
    const row = await db
      .prepare('SELECT * FROM books_v2 WHERE id = ?')
      .bind(7)
      .first<{ id: number; title: string }>();
    expect(row).toEqual({ id: 7, title: 'Ovid' });

    const list = await db.prepare('SELECT * FROM books_v2').bind().all();
    expect(list.results).toHaveLength(1);

    const res = await db
      .prepare('UPDATE books_v2 SET title = ?')
      .bind('x')
      .run();
    expect(res.meta.changes).toBe(1);
  });

  it('batch executes every statement', async () => {
    const db = createMemoryDb([{ ok: 1 }]);
    const out = await db.batch([
      db.prepare('UPDATE a SET x = 1').bind(),
      db.prepare('UPDATE b SET y = 2').bind(),
    ]);
    expect(out).toHaveLength(2);
  });

  it('drives real handler code (getBookStatus) unchanged', async () => {
    const { getBookStatus } = await import('../../../src/worker/db');
    const db = createMemoryDb([{ status: 'ready' }]);
    await expect(getBookStatus(db, 'some-uuid')).resolves.toBe('ready');
  });

  it('a hand-written storage round-trips objects and metadata', async () => {
    const storage = createMemoryStorage();
    expect(await storage.get('missing')).toBeNull();
    expect(await storage.head('missing')).toBeNull();

    await storage.put('uploads/a.epub', 'hello', {
      httpMetadata: { contentType: 'application/epub+zip' },
      customMetadata: { originalName: 'a.epub' },
    });

    const head = await storage.head('uploads/a.epub');
    expect(head?.httpMetadata?.contentType).toBe('application/epub+zip');
    expect(head?.customMetadata?.originalName).toBe('a.epub');

    const obj = await storage.get('uploads/a.epub');
    expect(new TextDecoder().decode(await obj!.arrayBuffer())).toBe('hello');

    await storage.delete('uploads/a.epub');
    expect(await storage.get('uploads/a.epub')).toBeNull();
  });
});
