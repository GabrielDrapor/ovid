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
 *
 * Needs OPENAI_API_KEY / OPENAI_API_BASE_URL / OPENAI_MODEL in .env. Remote
 * mode uses the D1 REST API when CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 * / CLOUDFLARE_D1_DATABASE_ID are set, and otherwise falls back to the
 * wrangler CLI (a `wrangler login` session is enough).
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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
  env: 'local' | 'remote';
  dryRun: boolean;
  limit: number;
  skipIds: Set<number>;
  log?: string;
}

function parseArgs(): Options {
  const opts: Options = {
    uuid: '',
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
        'Usage: yarn backfill-residue -- --uuid=<uuid> [--env=local|remote] [--dry-run] [--limit=N] [--skip-ids=1,2] [--log=path]'
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

// ---- D1 access (mirrors backfill-internal-links.ts) ----

/**
 * Run a statement through the wrangler CLI. Used for local mode always, and
 * for remote mode when the Cloudflare API credentials aren't in .env (a
 * `wrangler login` session is enough).
 *
 * Reads go through --command (remote --file returns only a batch summary, not
 * rows); writes go through a temp --file so multi-line translated text can't
 * be mangled by shell quoting.
 */
function wranglerQuery(sql: string, params: unknown[], remote: boolean): any[] {
  const inlined = params.length ? inlineParams(sql, params) : sql;
  const scope = remote ? '--remote' : '--local';

  if (/^\s*(?:update|insert|delete)\b/i.test(inlined)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovid-residue-'));
    const file = path.join(dir, 'stmt.sql');
    fs.writeFileSync(file, inlined);
    try {
      execSync(
        `npx wrangler d1 execute ovid-db ${scope} --json --file ${file}`,
        {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        }
      );
      return [];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const out = execSync(
    `npx wrangler d1 execute ovid-db ${scope} --json --command "${inlined.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const start = out.indexOf('[');
  return JSON.parse(start === -1 ? out : out.slice(start))[0]?.results || [];
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

async function main() {
  const opts = parseArgs();
  const query =
    opts.env === 'local'
      ? async (sql: string, params: unknown[] = []) =>
          wranglerQuery(sql, params, false)
      : (sql: string, params: unknown[] = []) => remoteQuery(sql, params);

  const { translateText, detectEnglishResidue } = await loadTranslator();

  const llmConfig = {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
  if (!opts.dryRun && !llmConfig.apiKey) {
    console.error('Missing OPENAI_API_KEY (needed to re-translate)');
    process.exit(1);
  }

  const books = await query(
    `SELECT id, uuid, title, language_pair FROM books_v2 WHERE uuid = ${sqlQuote(opts.uuid)}`
  );
  if (books.length === 0) {
    console.error(`Book ${opts.uuid} not found in ${opts.env} DB`);
    process.exit(1);
  }
  const book = books[0];
  const [sourceLanguage, targetLanguage] = String(
    book.language_pair || 'en-zh'
  ).split('-');
  console.log(`📖 ${book.title} (${book.uuid}), book_id=${book.id}`);

  const jobs = await query(
    `SELECT glossary_json FROM translation_jobs WHERE book_uuid = ${sqlQuote(opts.uuid)}`
  );
  let glossary: Record<string, string> = {};
  try {
    glossary = JSON.parse(jobs[0]?.glossary_json || '{}');
  } catch {
    console.warn(
      '   glossary_json unparseable — proceeding without a glossary'
    );
  }
  console.log(`   glossary: ${Object.keys(glossary).length} terms`);

  const rows = await query(
    `SELECT t.id, t.original_text, t.translated_text, c.chapter_number
     FROM translations_v2 t JOIN chapters_v2 c ON c.id = t.chapter_id
     WHERE c.book_id = ${book.id}
     ORDER BY c.chapter_number, t.order_index`
  );
  console.log(`   ${rows.length} translated segments`);

  const flagged = rows
    .map((r: any) => ({
      ...r,
      residue: detectEnglishResidue(r.translated_text || '', glossary),
    }))
    .filter((r: any) => r.residue.length > 0 && !opts.skipIds.has(r.id))
    .slice(0, opts.limit);

  console.log(
    `   ${flagged.length} segments flagged by the current detector\n`
  );
  if (flagged.length === 0) return;

  const logPath =
    opts.log ||
    path.resolve(process.cwd(), `backfill-residue-${opts.uuid}.jsonl`);

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

    let retranslated: string;
    try {
      retranslated = await translateText(
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

  if (!opts.dryRun) {
    console.log(
      `\nDone: ${fixed} clean, ${improved} improved, ${unchanged} left as-is. Rollback log: ${logPath}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
