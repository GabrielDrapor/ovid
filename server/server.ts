/**
 * Self-hosted Node entry point.
 *
 * Serves the same worker `fetch` handler used on Cloudflare, with SQLite and
 * the filesystem behind the platform interfaces. No handler code is
 * duplicated: this file only builds the `env` the handler expects and speaks
 * HTTP.
 *
 *   OVID_DATA_DIR   where the SQLite file and stored objects live (./data)
 *   OVID_PORT       HTTP port (8080)
 *   APP_URL         public base URL, used in OAuth redirects
 */

import { serve } from '@hono/node-server';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDatabase } from './db';
import { FileStorage } from './storage';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/types';

const DATA_DIR = process.env.OVID_DATA_DIR || './data';
const PORT = Number(process.env.OVID_PORT || 8080);
const BUILD_DIR = process.env.OVID_BUILD_DIR || './build';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Stand-in for the Workers Assets binding: serves ./build off disk. */
function createAssetsFetcher(buildDir: string) {
  return {
    async fetch(input: Request | string): Promise<Response> {
      const url = new URL(typeof input === 'string' ? input : input.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      const filePath = path.resolve(buildDir, '.' + pathname);
      const rootResolved = path.resolve(buildDir);
      if (!filePath.startsWith(rootResolved)) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return new Response('Not found', { status: 404 });
        const ext = path.extname(filePath).toLowerCase();
        const body = createReadStream(filePath) as unknown as ReadableStream;
        return new Response(body as BodyInit, {
          headers: {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': String(stat.size),
            // Hashed asset filenames are safe to cache; index.html is not.
            'Cache-Control': pathname.endsWith('.html')
              ? 'no-cache'
              : 'public, max-age=31536000, immutable',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}

/**
 * Bring a fresh database up to date: the v2 base schema, then every
 * numbered migration in order. Statements are applied individually and
 * "already exists"/"duplicate column" errors are ignored, so this is safe to
 * re-run on every boot (the worker's own in-process migrations then handle
 * anything newer than the files on disk).
 */
async function bootstrapSchema(db: SqliteDatabase): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [
    path.resolve(here, '../database'),
    path.resolve(process.cwd(), 'database'),
  ];
  let dbDir: string | null = null;
  for (const root of roots) {
    try {
      await fs.stat(path.join(root, 'schema_v2.sql'));
      dbDir = root;
      break;
    } catch {
      /* try next */
    }
  }
  if (!dbDir)
    throw new Error('Could not locate database/ for schema bootstrap');

  const files = [path.join(dbDir, 'schema_v2.sql')];
  try {
    const migrations = (await fs.readdir(path.join(dbDir, 'migrations')))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    files.push(...migrations.map((f) => path.join(dbDir!, 'migrations', f)));
  } catch {
    /* no migrations dir */
  }

  for (const file of files) {
    const sql = await fs.readFile(file, 'utf8');
    // Strip line comments first: a statement preceded by a comment block
    // would otherwise look like a comment and be skipped entirely.
    const statements = sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        db.exec(statement);
      } catch (err) {
        const msg = String(err);
        const benign =
          msg.includes('already exists') ||
          msg.includes('duplicate column') ||
          msg.includes('no such table: main.') ||
          msg.includes('no such column');
        if (!benign) {
          console.warn(
            `[schema] skipped statement from ${path.basename(file)}: ${msg.slice(0, 140)}`
          );
        }
      }
    }
  }
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'ovid.db');
  const db = new SqliteDatabase(dbPath);
  await bootstrapSchema(db);

  const storage = new FileStorage(path.join(DATA_DIR, 'assets'));
  const assets = createAssetsFetcher(BUILD_DIR);

  const env = {
    ...process.env,
    ASSETS: assets,
    DB: db,
    ASSETS_BUCKET: storage,
    APP_URL: process.env.APP_URL || `http://localhost:${PORT}`,
  } as unknown as Env;

  // Workers' ctx.waitUntil keeps background work alive past the response;
  // in a long-lived Node process the promise simply runs on.
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      void Promise.resolve(promise).catch((err) =>
        console.error('[waitUntil]', err)
      );
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  const handler = async (request: Request): Promise<Response> => {
    try {
      return await worker.fetch(request, env, ctx);
    } catch (err) {
      console.error('[ovid] Unhandled error:', err);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };

  serve({ fetch: handler, port: PORT }, (info) => {
    console.log(`Ovid self-hosted on http://localhost:${info.port}`);
    console.log(`  data:   ${path.resolve(DATA_DIR)}`);
    console.log(`  assets: ${path.resolve(BUILD_DIR)}`);
  });
}

main().catch((err) => {
  console.error('Failed to start Ovid:', err);
  process.exit(1);
});
