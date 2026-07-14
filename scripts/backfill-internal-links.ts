#!/usr/bin/env ts-node

/**
 * Backfill internal-link support (footnote jumps/popovers) for books imported
 * before the parser started resolving internal links.
 *
 * Re-parses the original EPUB (kept in R2 at uploads/{uuid}/original.epub)
 * with the current parser and rewrites ONLY chapters_v2.raw_html — the
 * stored translations and their XPaths are left untouched. Before writing,
 * every chapter is verified: all stored translation XPaths must still
 * resolve in the re-parsed chapter, otherwise the book is skipped (the old
 * import predates a structural parser change and a backfill would detach
 * its translations).
 *
 * Usage:
 *   yarn backfill-links -- --uuid="<book-uuid>" [--env=local|remote]
 *                          [--epub=path/to/original.epub] [--dry-run]
 *
 * Remote mode needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN /
 * CLOUDFLARE_D1_DATABASE_ID in .env (same as other remote scripts); the
 * EPUB is downloaded from R2 via the Cloudflare API unless --epub is given.
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'ovid';

// services/translator is an ESM package while scripts run under CommonJS
// ts-node — load the production parser via a real dynamic import (the
// new Function indirection stops TS from downleveling it to require()).
const importEsm = new Function('s', 'return import(s)') as (
  s: string
) => Promise<any>;

async function loadParser(): Promise<{
  parseEPUB: (buffer: Buffer) => Promise<any>;
}> {
  const distPath = path.resolve(
    __dirname,
    '../services/translator/dist/book-parser.js'
  );
  if (!fs.existsSync(distPath)) {
    console.log('Building services/translator (dist/book-parser.js missing)…');
    execSync('yarn --cwd services/translator build', { stdio: 'inherit' });
  }
  return importEsm(pathToFileURL(distPath).href);
}

interface Options {
  uuid: string;
  env: 'local' | 'remote';
  epub?: string;
  dryRun: boolean;
}

function parseArgs(): Options {
  const opts: Options = { uuid: '', env: 'local', dryRun: false };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'uuid') opts.uuid = value || '';
    else if (key === 'env' && (value === 'local' || value === 'remote'))
      opts.env = value;
    else if (key === 'epub') opts.epub = value;
    else if (key === 'dry-run') opts.dryRun = true;
    else if (key === 'help') {
      console.log(
        'Usage: yarn backfill-links -- --uuid=<uuid> [--env=local|remote] [--epub=file] [--dry-run]'
      );
      process.exit(0);
    }
  }
  if (!opts.uuid) {
    console.error('Missing --uuid');
    process.exit(1);
  }
  return opts;
}

// ---- D1 access ----

function localQuery(sql: string): any[] {
  const out = execSync(
    `npx wrangler d1 execute ovid-db --local --json --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results || [];
}

async function remoteQuery(
  sql: string,
  params: unknown[] = []
): Promise<any[]> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const dbId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  if (!accountId || !token || !dbId) {
    throw new Error(
      'Remote mode needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID'
    );
  }
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    }
  );
  const data = (await resp.json()) as any;
  if (!data.success) {
    throw new Error(
      `D1 API error: ${JSON.stringify(data.errors).slice(0, 500)}`
    );
  }
  return data.result?.[0]?.results || [];
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ---- R2 download ----

async function downloadOriginalEpub(uuid: string): Promise<Buffer> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error(
      'Downloading from R2 needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or pass --epub=path)'
    );
  }
  const key = `uploads/${uuid}/original.epub`;
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    throw new Error(
      `Could not download ${key} from R2 (${resp.status}). ` +
        'Only EPUB originals are supported; pass --epub=path if you have the file locally.'
    );
  }
  return Buffer.from(await resp.arrayBuffer());
}

// ---- Main ----

async function main() {
  const opts = parseArgs();
  const query =
    opts.env === 'local'
      ? async (sql: string) => localQuery(sql)
      : (sql: string) => remoteQuery(sql);

  const books = await query(
    `SELECT id, uuid, title FROM books_v2 WHERE uuid = ${sqlQuote(opts.uuid)}`
  );
  if (books.length === 0) {
    console.error(`Book ${opts.uuid} not found in ${opts.env} DB`);
    process.exit(1);
  }
  const book = books[0];
  console.log(`📖 ${book.title} (${book.uuid}), book_id=${book.id}`);

  const chapters = await query(
    `SELECT id, chapter_number FROM chapters_v2 WHERE book_id = ${book.id} ORDER BY chapter_number`
  );
  console.log(`   ${chapters.length} chapters in DB`);

  const epubBuffer = opts.epub
    ? fs.readFileSync(opts.epub)
    : await downloadOriginalEpub(opts.uuid);
  console.log(
    `   EPUB loaded (${(epubBuffer.length / 1024).toFixed(0)} KB), re-parsing…`
  );

  const { parseEPUB } = await loadParser();
  const parsed = await parseEPUB(epubBuffer);
  const parsedByNumber = new Map<number, any>(
    parsed.chapters.map((c: any) => [c.number, c])
  );

  if (parsed.chapters.length !== chapters.length) {
    console.error(
      `❌ Chapter count mismatch: DB has ${chapters.length}, re-parse produced ${parsed.chapters.length}. ` +
        'The parser structure changed since this import — skipping (re-import instead).'
    );
    process.exit(1);
  }

  // Verify every stored translation xpath still resolves per chapter
  const updates: { id: number; chapterNumber: number; rawHtml: string }[] = [];
  for (const ch of chapters) {
    const reparsed = parsedByNumber.get(ch.chapter_number);
    if (!reparsed) {
      console.error(
        `❌ Chapter ${ch.chapter_number} missing in re-parse — aborting.`
      );
      process.exit(1);
    }
    const stored = await query(
      `SELECT xpath FROM translations_v2 WHERE chapter_id = ${ch.id}`
    );
    const newXpaths = new Set(reparsed.textNodes.map((n: any) => n.xpath));
    const missing = stored.filter((r: any) => !newXpaths.has(r.xpath));
    if (missing.length > 0) {
      console.error(
        `❌ Chapter ${ch.chapter_number}: ${missing.length}/${stored.length} stored xpaths ` +
          `no longer resolve (e.g. ${missing[0].xpath}) — aborting, translations would detach.`
      );
      process.exit(1);
    }
    const linkCount = (reparsed.rawHtml.match(/data-ov-chapter=/g) || [])
      .length;
    const noteCount = (reparsed.rawHtml.match(/data-ov-note=/g) || []).length;
    console.log(
      `   ✓ ch${ch.chapter_number}: ${stored.length} xpaths ok, ${linkCount} links (${noteCount} notes)`
    );
    updates.push({
      id: ch.id,
      chapterNumber: ch.chapter_number,
      rawHtml: reparsed.rawHtml,
    });
  }

  if (opts.dryRun) {
    console.log(
      `🔎 Dry run — would update raw_html for ${updates.length} chapters.`
    );
    return;
  }

  if (opts.env === 'local') {
    // Apply via a SQL file to avoid shell-quoting limits on big chapters
    const sqlPath = path.join(os.tmpdir(), `backfill-${opts.uuid}.sql`);
    const sql = updates
      .map(
        (u) =>
          `UPDATE chapters_v2 SET raw_html = ${sqlQuote(u.rawHtml)} WHERE id = ${u.id};`
      )
      .join('\n');
    fs.writeFileSync(sqlPath, sql);
    execSync(`npx wrangler d1 execute ovid-db --local --file="${sqlPath}"`, {
      stdio: 'inherit',
      maxBuffer: 256 * 1024 * 1024,
    });
    fs.unlinkSync(sqlPath);
  } else {
    for (const u of updates) {
      await remoteQuery('UPDATE chapters_v2 SET raw_html = ? WHERE id = ?', [
        u.rawHtml,
        u.id,
      ]);
      console.log(`   updated ch${u.chapterNumber}`);
    }
  }

  console.log(
    `🎉 Backfilled raw_html for ${updates.length} chapters of "${book.title}".`
  );
}

main().catch((err) => {
  console.error('Backfill failed:', err.message || err);
  process.exit(1);
});
