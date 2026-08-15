/**
 * @vitest-environment node
 *
 * These adapters use Node built-ins (node:sqlite, fs), so they must run in
 * the node environment — the default jsdom environment can't resolve them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../../server/db';
import { FileStorage } from '../../../server/storage';

/**
 * The self-host adapters must behave like D1/R2 closely enough that handler
 * code can't tell the difference — these tests pin the behaviours handlers
 * actually depend on.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ovid-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SqliteDatabase', () => {
  const open = () => {
    const db = new SqliteDatabase(path.join(tmpDir, 'test.db'));
    db.exec(
      'CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, title TEXT, done INTEGER)'
    );
    return db;
  };

  it('round-trips rows through prepare/bind/first', async () => {
    const db = open();
    await db
      .prepare('INSERT INTO books (uuid, title) VALUES (?, ?)')
      .bind('u1', 'Ovid')
      .run();
    const row = await db
      .prepare('SELECT uuid, title FROM books WHERE uuid = ?')
      .bind('u1')
      .first<{ uuid: string; title: string }>();
    expect(row).toEqual({ uuid: 'u1', title: 'Ovid' });
    db.close();
  });

  it('returns null (not undefined) when a row is missing, like D1', async () => {
    const db = open();
    const row = await db
      .prepare('SELECT * FROM books WHERE uuid = ?')
      .bind('nope')
      .first();
    expect(row).toBeNull();
    db.close();
  });

  it('wraps rows under .results for all(), like D1', async () => {
    const db = open();
    for (const u of ['a', 'b']) {
      await db.prepare('INSERT INTO books (uuid) VALUES (?)').bind(u).run();
    }
    const res = await db.prepare('SELECT uuid FROM books ORDER BY uuid').all();
    expect(res.results).toEqual([{ uuid: 'a' }, { uuid: 'b' }]);
    db.close();
  });

  it('reports meta.changes — upsert fallbacks depend on it', async () => {
    const db = open();
    await db.prepare('INSERT INTO books (uuid) VALUES (?)').bind('x').run();
    const hit = await db
      .prepare('UPDATE books SET title = ? WHERE uuid = ?')
      .bind('t', 'x')
      .run();
    expect(hit.meta.changes).toBe(1);
    const miss = await db
      .prepare('UPDATE books SET title = ? WHERE uuid = ?')
      .bind('t', 'absent')
      .run();
    expect(miss.meta.changes).toBe(0);
    db.close();
  });

  it('coerces booleans, undefined and Dates the way D1 accepts them', async () => {
    const db = open();
    await db
      .prepare('INSERT INTO books (uuid, title, done) VALUES (?, ?, ?)')
      .bind('b1', undefined, true)
      .run();
    const row = await db
      .prepare('SELECT title, done FROM books WHERE uuid = ?')
      .bind('b1')
      .first<{ title: string | null; done: number }>();
    expect(row).toEqual({ title: null, done: 1 });
    db.close();
  });

  it('batch() is atomic — a failing statement rolls the whole set back', async () => {
    const db = open();
    await db.prepare('INSERT INTO books (uuid) VALUES (?)').bind('keep').run();
    await expect(
      db.batch([
        db.prepare('INSERT INTO books (uuid) VALUES (?)').bind('new1'),
        // duplicate uuid violates UNIQUE -> whole batch must roll back
        db.prepare('INSERT INTO books (uuid) VALUES (?)').bind('keep'),
      ])
    ).rejects.toThrow();
    const res = await db.prepare('SELECT uuid FROM books').all();
    expect(res.results).toEqual([{ uuid: 'keep' }]);
    db.close();
  });

  it('persists across reopen (data survives a restart)', async () => {
    const db = open();
    await db.prepare('INSERT INTO books (uuid) VALUES (?)').bind('p1').run();
    db.close();

    const again = new SqliteDatabase(path.join(tmpDir, 'test.db'));
    const row = await again
      .prepare('SELECT uuid FROM books WHERE uuid = ?')
      .bind('p1')
      .first();
    expect(row).toEqual({ uuid: 'p1' });
    again.close();
  });
});

describe('FileStorage', () => {
  const open = () => new FileStorage(path.join(tmpDir, 'assets'));

  it('stores and retrieves object bytes', async () => {
    const storage = open();
    await storage.put('uploads/book/original.epub', 'PK-fake-epub');
    const obj = await storage.get('uploads/book/original.epub');
    expect(new TextDecoder().decode(await obj!.arrayBuffer())).toBe(
      'PK-fake-epub'
    );
  });

  it('preserves httpMetadata/customMetadata like R2', async () => {
    const storage = open();
    await storage.put('a.epub', 'x', {
      httpMetadata: { contentType: 'application/epub+zip' },
      customMetadata: { originalName: '原书.epub' },
    });
    const head = await storage.head('a.epub');
    expect(head?.httpMetadata?.contentType).toBe('application/epub+zip');
    expect(head?.customMetadata?.originalName).toBe('原书.epub');
  });

  it('returns null for missing keys instead of throwing', async () => {
    const storage = open();
    expect(await storage.get('missing')).toBeNull();
    expect(await storage.head('missing')).toBeNull();
  });

  it('accepts ArrayBuffer and typed-array bodies', async () => {
    const storage = open();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await storage.put('bin1', bytes);
    await storage.put('bin2', bytes.buffer);
    expect(new Uint8Array(await (await storage.get('bin1'))!.arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await (await storage.get('bin2'))!.arrayBuffer())).toEqual(bytes);
  });

  it('accepts a ReadableStream body — the estimate→upload copy path', async () => {
    const storage = open();
    await storage.put('src.epub', 'streamed-content', {
      httpMetadata: { contentType: 'application/epub+zip' },
    });
    const source = await storage.get('src.epub');
    await storage.put('dest.epub', source!.body, {
      httpMetadata: source!.httpMetadata,
      customMetadata: source!.customMetadata,
    });
    const copied = await storage.get('dest.epub');
    expect(new TextDecoder().decode(await copied!.arrayBuffer())).toBe(
      'streamed-content'
    );
    expect(copied!.httpMetadata?.contentType).toBe('application/epub+zip');
  });

  it('deletes objects and their metadata', async () => {
    const storage = open();
    await storage.put('gone.epub', 'x', { customMetadata: { a: 'b' } });
    await storage.delete('gone.epub');
    expect(await storage.get('gone.epub')).toBeNull();
    expect(await storage.head('gone.epub')).toBeNull();
  });

  it('rejects keys that escape the data directory', async () => {
    const storage = open();
    await expect(storage.put('../../etc/passwd', 'x')).rejects.toThrow(
      /Invalid storage key/
    );
    await expect(storage.get('../outside')).rejects.toThrow(
      /Invalid storage key/
    );
  });
});
