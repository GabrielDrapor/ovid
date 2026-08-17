#!/usr/bin/env ts-node

/**
 * Re-translate segments that shipped with untranslated English left in them.
 *
 * Books translated before a detector improvement carry residue the pipeline
 * would now catch and retry ("曼联的历史最佳射手 arguably 从未找到自己的最佳
 * 位置"). This script re-runs the *current* detector over a book's stored
 * translations, re-translates every flagged segment with the production
 * translateText (same prompt, same glossary), and writes the result back —
 * but only when the new text is actually cleaner than the old one.
 *
 * Rows are updated by id via UPDATE; nothing is deleted, so xpath mappings
 * and order_index stay exactly as the reader expects. Every replacement is
 * appended to a JSONL log (--log, default backfill-residue-<uuid>.jsonl) so a
 * bad run can be reverted row by row.
 *
 * Usage:
 *   yarn backfill-residue -- --uuid="<book-uuid>" [--env=local|remote]
 *                            [--dry-run] [--limit=N] [--skip-ids=1,2,3]
 *                            [--log=path.jsonl]
 *   yarn backfill-residue -- --all --env=remote --dry-run   # sweep every book
 *
 * Needs OPENAI_API_KEY / OPENAI_API_BASE_URL / OPENAI_MODEL in .env. Remote
 * mode uses the D1 REST API when CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 * / CLOUDFLARE_D1_DATABASE_ID are set, and otherwise falls back to the
 * wrangler CLI (a `wrangler login` session is enough).
 */

import 'dotenv/config';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

// services/translator is ESM while scripts run under CommonJS ts-node — the
// new Function indirection stops TS from downleveling import() to require().
const importEsm = new Function('s', 'return import(s)') as (
  s: string
) => Promise<any>;

interface TranslatorModule {
  translateText: (
    config: { apiKey: string; baseURL: string; model: string },
    text: string,
    glossary: Record<string, string>,
    sourceLanguage: string,
    targetLanguage: string,
    context?: string[]
  ) => Promise<string>;
  translateLargeNode: (
    config: { apiKey: string; baseURL: string; model: string },
    text: string,
    glossary: Record<string, string>,
    sourceLanguage: string,
    targetLanguage: string,
    bookUuid: string
  ) => Promise<string>;
  detectEnglishResidue: (
    text: string,
    glossary: Record<string, string>
  ) => string[];
}

async function loadTranslator(): Promise<TranslatorModule> {
  const distPath = path.resolve(
    __dirname,
    '../services/translator/dist/translate-worker.js'
  );
  if (!fs.existsSync(distPath)) {
    console.log(
      'Building services/translator (dist/translate-worker.js missing)…'
    );
    execSync('yarn --cwd services/translator build', { stdio: 'inherit' });
  }
  return importEsm(pathToFileURL(distPath).href);
}

interface Options {
  uuid: string;
  all: boolean;
  highCjkOnly: boolean;
  env: 'local' | 'remote';
  dryRun: boolean;
  limit: number;
  skipIds: Set<number>;
  log?: string;
}

function parseArgs(): Options {
  const opts: Options = {
    uuid: '',
    all: false,
    highCjkOnly: false,
    env: 'local',
    dryRun: false,
    limit: Infinity,
    skipIds: new Set(),
  };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'uuid') opts.uuid = value || '';
    else if (key === 'all') opts.all = true;
    else if (key === 'high-cjk-only') opts.highCjkOnly = true;
    else if (key === 'env' && (value === 'local' || value === 'remote'))
      opts.env = value;
    else if (key === 'dry-run') opts.dryRun = true;
    else if (key === 'limit')
      opts.limit = parseInt(value || '', 10) || Infinity;
    else if (key === 'skip-ids')
      opts.skipIds = new Set(
        (value || '')
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter(Number.isFinite)
      );
    else if (key === 'log') opts.log = value;
    else if (key === 'help') {
      console.log(
        'Usage: yarn backfill-residue -- (--uuid=<uuid> | --all) [--env=local|remote] [--high-cjk-only] [--dry-run] [--limit=N] [--skip-ids=1,2] [--log=path]'
      );
      process.exit(0);
    }
  }
  if (!opts.uuid && !opts.all) {
    console.error('Missing --uuid (or --all to sweep every book)');
    process.exit(1);
  }
  return opts;
}

/** Mirror of translate-worker.ts — above this, the pipeline splits the node */
const LARGE_NODE_CHAR_THRESHOLD = 3000;

/**
 * Is this segment judged by the detector's mostly-CJK branch? That branch is
 * where the word-shape fix lives, so --high-cjk-only restricts a backfill to
 * prose that reads as translated Chinese with English left inside it. The
 * mixed-script branch flags name lists, credits pages and TOC headings, whose
 * English is usually deliberate — those rows predate the fix and are not what
 * a backfill should be rewriting.
 */
function isHighCjk(text: string): boolean {
  const cjk = (text.match(/[　-鿿가-힯]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  return cjk > 0 && cjk / (cjk + latin) >= 0.6;
}

// ---- D1 access (mirrors backfill-internal-links.ts) ----

/**
 * Run a statement through the wrangler CLI. Used for local mode always, and
 * for remote mode when the Cloudflare API credentials aren't in .env (a
 * `wrangler login` session is enough).
 *
 * Statements always go through --command, passed as an argv element via
 * execFileSync (no shell), so multi-line translated text needs no escaping.
 * The --file path is deliberately avoided: it uploads a temp file per call and
 * remote runs return only a batch summary instead of rows.
 */
function wranglerQuery(sql: string, params: unknown[], remote: boolean): any[] {
  const inlined = params.length ? inlineParams(sql, params) : sql;
  // D1 occasionally answers a large read with "fetch failed" — one flaky call
  // must not abandon a library-wide sweep half-way through.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execFileSync(
        'npx',
        [
          'wrangler',
          'd1',
          'execute',
          'ovid-db',
          remote ? '--remote' : '--local',
          '--json',
          '--command',
          inlined,
        ],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
      );
      const start = out.indexOf('[');
      return (
        JSON.parse(start === -1 ? out : out.slice(start))[0]?.results || []
      );
    } catch (err) {
      lastErr = err;
      execSync(`sleep ${2 * (attempt + 1)}`);
    }
  }
  throw lastErr;
}

/** The wrangler path has no bound-parameter support — inline them safely. */
function inlineParams(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const p = params[i++];
    if (p === null || p === undefined) return 'NULL';
    if (typeof p === 'number') return String(p);
    return sqlQuote(String(p));
  });
}

async function remoteQuery(
  sql: string,
  params: unknown[] = []
): Promise<any[]> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const dbId = process.env.CLOUDFLARE_D1_DATABASE_ID;
  if (!accountId || !token || !dbId) {
    return wranglerQuery(sql, params, true);
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

// ---- Main ----

type Query = (sql: string, params?: unknown[]) => Promise<any[]>;

interface BookRow {
  id: number;
  uuid: string;
  title: string;
  language_pair: string;
}

interface Totals {
  flagged: number;
  fixed: number;
  improved: number;
  unchanged: number;
}

async function main() {
  const opts = parseArgs();
  const query: Query =
    opts.env === 'local'
      ? async (sql: string, params: unknown[] = []) =>
          wranglerQuery(sql, params, false)
      : (sql: string, params: unknown[] = []) => remoteQuery(sql, params);

  const translator = await loadTranslator();

  const llmConfig = {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
  if (!opts.dryRun && !llmConfig.apiKey) {
    console.error('Missing OPENAI_API_KEY (needed to re-translate)');
    process.exit(1);
  }

  const books: BookRow[] = opts.all
    ? await query(
        `SELECT id, uuid, title, language_pair FROM books_v2 ORDER BY id`
      )
    : await query(
        `SELECT id, uuid, title, language_pair FROM books_v2 WHERE uuid = ${sqlQuote(opts.uuid)}`
      );
  if (books.length === 0) {
    console.error(
      opts.all
        ? `No books found in ${opts.env} DB`
        : `Book ${opts.uuid} not found in ${opts.env} DB`
    );
    process.exit(1);
  }

  const logPath =
    opts.log ||
    path.resolve(
      process.cwd(),
      `backfill-residue-${opts.all ? 'all' : opts.uuid}.jsonl`
    );

  const totals: Totals = { flagged: 0, fixed: 0, improved: 0, unchanged: 0 };
  for (const book of books) {
    await processBook(book, {
      opts,
      query,
      translator,
      llmConfig,
      logPath,
      totals,
    });
  }

  if (books.length > 1) {
    console.log(
      `\n== ${books.length} books: ${totals.flagged} flagged, ${totals.fixed} clean, ` +
        `${totals.improved} improved, ${totals.unchanged} left as-is`
    );
  }
  if (!opts.dryRun && totals.fixed + totals.improved > 0) {
    console.log(`Rollback log: ${logPath}`);
  }
}

async function processBook(
  book: BookRow,
  ctx: {
    opts: Options;
    query: Query;
    translator: TranslatorModule;
    llmConfig: { apiKey: string; baseURL: string; model: string };
    logPath: string;
    totals: Totals;
  }
) {
  const { opts, query, translator, llmConfig, logPath, totals } = ctx;
  const { translateText, translateLargeNode, detectEnglishResidue } =
    translator;
  const [sourceLanguage, targetLanguage] = String(
    book.language_pair || 'en-zh'
  ).split('-');

  const jobs = await query(
    `SELECT glossary_json FROM translation_jobs WHERE book_uuid = ${sqlQuote(book.uuid)}`
  );
  let glossary: Record<string, string> = {};
  try {
    glossary = JSON.parse(jobs[0]?.glossary_json || '{}');
  } catch {
    console.warn(
      '   glossary_json unparseable — proceeding without a glossary'
    );
  }

  // Only rows with a run of 3+ lowercase latin letters can hold residue —
  // the prefilter keeps the sweep from hauling every Chinese paragraph in
  // the library across the wire. Paged, because a whole book's candidate
  // rows in one response is what makes D1 answer "fetch failed".
  const PAGE = 300;
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await query(
      `SELECT t.id, t.original_text, t.translated_text, c.chapter_number
       FROM translations_v2 t JOIN chapters_v2 c ON c.id = t.chapter_id
       WHERE c.book_id = ${book.id} AND t.translated_text GLOB '*[a-z][a-z][a-z]*'
       ORDER BY c.chapter_number, t.order_index
       LIMIT ${PAGE} OFFSET ${offset}`
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const flagged = rows
    .map((r: any) => ({
      ...r,
      residue: detectEnglishResidue(r.translated_text || '', glossary),
    }))
    .filter(
      (r: any) =>
        r.residue.length > 0 &&
        !opts.skipIds.has(r.id) &&
        (!opts.highCjkOnly || isHighCjk(r.translated_text || ''))
    )
    .slice(0, opts.limit);

  if (flagged.length === 0) return;
  totals.flagged += flagged.length;
  console.log(
    `\n📖 ${book.title} (${book.uuid}) — ${flagged.length} flagged of ${rows.length} candidate segments, ` +
      `glossary ${Object.keys(glossary).length} terms`
  );

  let fixed = 0;
  let improved = 0;
  let unchanged = 0;
  for (const row of flagged) {
    const label = `ch${row.chapter_number} #${row.id} [${row.residue.join(', ')}]`;
    if (opts.dryRun) {
      console.log(
        `· ${label}\n    ${String(row.translated_text).slice(0, 160)}`
      );
      continue;
    }

    // Nodes past the pipeline's split threshold go through the same chunked
    // path it uses; a single call would come back truncated, and a truncated
    // tail has no residue left to warn us with.
    const isLargeNode =
      String(row.original_text).length > LARGE_NODE_CHAR_THRESHOLD;

    let retranslated: string;
    try {
      retranslated = isLargeNode
        ? await translateLargeNode(
            llmConfig,
            row.original_text,
            glossary,
            sourceLanguage,
            targetLanguage,
            book.uuid
          )
        : await translateText(
            llmConfig,
            row.original_text,
            glossary,
            sourceLanguage,
            targetLanguage
          );
    } catch (err) {
      console.warn(
        `✗ ${label} — translation failed: ${(err as Error).message}`
      );
      continue;
    }

    const after = detectEnglishResidue(retranslated, glossary);
    if (after.length >= row.residue.length) {
      // No improvement — keep the shipped text rather than swap in a
      // differently-worded translation that is just as leaky.
      unchanged++;
      console.log(
        `- ${label} — retry still leaves [${after.join(', ')}], keeping original`
      );
      continue;
    }

    // Truncation tripwire: a half-length replacement is a dropped tail, not a
    // tighter translation — and a truncated tail reads as residue-free.
    if (retranslated.length < String(row.translated_text).length * 0.6) {
      unchanged++;
      console.log(
        `- ${label} — replacement is ${retranslated.length} chars vs ${row.translated_text.length}, looks truncated; keeping original`
      );
      continue;
    }

    await query(`UPDATE translations_v2 SET translated_text = ? WHERE id = ?`, [
      retranslated,
      row.id,
    ]);
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        id: row.id,
        chapter_number: row.chapter_number,
        residue_before: row.residue,
        residue_after: after,
        before: row.translated_text,
        after: retranslated,
      }) + '\n'
    );
    if (after.length === 0) fixed++;
    else improved++;
    console.log(`✓ ${label}${after.length ? ` → [${after.join(', ')}]` : ''}`);
  }

  totals.fixed += fixed;
  totals.improved += improved;
  totals.unchanged += unchanged;
  if (!opts.dryRun) {
    console.log(
      `   ${fixed} clean, ${improved} improved, ${unchanged} left as-is`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
