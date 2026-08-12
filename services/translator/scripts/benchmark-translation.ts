/**
 * Wall-clock benchmark for translateBook against a synthetic book.
 *
 * Simulates realistic latencies (LLM call + D1 REST round-trip) with mocks so
 * the pipeline's orchestration overhead is measured, not the network.
 * Run before/after a pipeline change to compare:
 *
 *   npx tsx scripts/benchmark-translation.ts
 *
 * Environment knobs:
 *   BENCH_CHAPTERS      number of chapters       (default 40)
 *   BENCH_NODES         text nodes per chapter   (default 30)
 *   BENCH_LLM_MS        latency per LLM call     (default 1500)
 *   BENCH_D1_MS         latency per D1 query     (default 120)
 *   TRANSLATE_CONCURRENCY  pool size for the new pipeline (if supported)
 */
import { translateBook } from '../src/translate-worker.js';
import type { D1Client } from '../src/d1-client.js';

const CHAPTERS = parseInt(process.env.BENCH_CHAPTERS || '40', 10);
const NODES_PER_CHAPTER = parseInt(process.env.BENCH_NODES || '30', 10);
const LLM_MS = parseInt(process.env.BENCH_LLM_MS || '1500', 10);
const D1_MS = parseInt(process.env.BENCH_D1_MS || '120', 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Synthetic book -------------------------------------------------------

interface TextNode {
  xpath: string;
  text: string;
  html: string;
  orderIndex: number;
}

const SAMPLE_SENTENCE =
  'The mountain guide Whymper led the expedition through the icy pass, ' +
  'while the porters carried supplies toward the distant summit ridge. ';

function makeChapterNodes(ch: number): TextNode[] {
  const nodes: TextNode[] = [];
  for (let i = 0; i < NODES_PER_CHAPTER; i++) {
    const text = SAMPLE_SENTENCE.repeat(2) + `(chapter ${ch}, paragraph ${i})`;
    nodes.push({
      xpath: `/html/body/p[${i + 1}]`,
      text,
      html: `<p>${text}</p>`,
      orderIndex: i,
    });
  }
  return nodes;
}

const chapters = new Map<number, { id: number; nodes: TextNode[] }>();
for (let ch = 1; ch <= CHAPTERS; ch++) {
  chapters.set(ch, { id: 1000 + ch, nodes: makeChapterNodes(ch) });
}

// ---- Mutable job row (the fake D1 serves and updates this) ---------------

const job: Record<string, unknown> = {
  id: 1,
  book_id: 100,
  book_uuid: 'bench-uuid',
  source_language: 'en',
  target_language: 'zh',
  total_chapters: CHAPTERS,
  completed_chapters: 0,
  current_chapter: 1,
  current_item_offset: 0,
  glossary_json: null,
  glossary_extracted: 0,
  title_translated: 0,
  translated_title: null,
  status: 'pending',
  error_message: null,
};

// ---- Fake D1 client -------------------------------------------------------

let d1Calls = 0;
let insertedRows = 0;

function chapterByNumberFromParams(sql: string, params: unknown[]): { id: number; nodes: TextNode[] } | null {
  // Heuristic: last (or second) numeric param that is a valid chapter number
  for (const p of [...params].reverse()) {
    if (typeof p === 'number' && chapters.has(p)) return chapters.get(p)!;
  }
  return null;
}

async function fakeQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  d1Calls++;
  await sleep(D1_MS);
  const s = sql.replace(/\s+/g, ' ');

  if (s.includes('FROM translation_jobs')) return [{ ...job }];

  if (s.startsWith('UPDATE translation_jobs')) {
    // crude column tracker for resume-critical fields
    if (s.includes('glossary_extracted = 1')) job.glossary_extracted = 1;
    if (s.includes('title_translated = 1')) job.title_translated = 1;
    return [];
  }
  if (s.startsWith('UPDATE') || s.startsWith('DELETE') || s.startsWith('INSERT')) return [];

  if (s.includes('text_nodes_json')) {
    // Serve chapter rows for both shapes:
    //  - per-chapter: WHERE book_id = ? AND chapter_number = ?
    //  - chunked:     WHERE book_id = ? AND chapter_number BETWEEN ? AND ?  (or IN (...))
    if (s.includes('BETWEEN')) {
      const nums = params.filter((p): p is number => typeof p === 'number' && chapters.has(p));
      const [lo, hi] = [Math.min(...nums.slice(-2)), Math.max(...nums.slice(-2))];
      const rows: Record<string, unknown>[] = [];
      for (let ch = lo; ch <= hi; ch++) {
        const c = chapters.get(ch);
        if (c) {
          rows.push({
            id: c.id,
            chapter_number: ch,
            original_title: `Chapter ${ch}`,
            text_nodes_json: JSON.stringify(c.nodes),
          });
        }
      }
      return rows;
    }
    const c = chapterByNumberFromParams(s, params);
    return c
      ? [{ id: c.id, chapter_number: 0, original_title: 'Chapter', text_nodes_json: JSON.stringify(c.nodes) }]
      : [];
  }

  if (s.includes('GROUP BY chapter_id')) return []; // fresh book: no existing translations

  if (s.includes('FROM books_v2')) return [{ original_title: 'The Bench Book' }];

  if (s.includes('FROM chapters_v2') && s.includes('original_title')) {
    const c = chapterByNumberFromParams(s, params);
    return c ? [{ original_title: 'Chapter Title' }] : [];
  }
  if (s.includes('FROM chapters_v2') && s.includes('id')) {
    const c = chapterByNumberFromParams(s, params);
    return c ? [{ id: c.id }] : [];
  }

  return [];
}

const fakeDb = {
  query: async (sql: string, params: unknown[] = []) => ({ results: await fakeQuery(sql, params), success: true }),
  first: async (sql: string, params: unknown[] = []) => (await fakeQuery(sql, params))[0] ?? null,
  all: async (sql: string, params: unknown[] = []) => fakeQuery(sql, params),
  run: async (sql: string, params: unknown[] = []) => {
    await fakeQuery(sql, params);
  },
  batchInsert: async (_table: string, columns: string[], rows: unknown[][]) => {
    // Same chunking cost model as the real client: 100 bound params per query
    const perQuery = Math.floor(100 / columns.length);
    for (let i = 0; i < rows.length; i += perQuery) {
      d1Calls++;
      await sleep(D1_MS);
    }
    insertedRows += rows.length;
  },
} as unknown as D1Client;

// ---- Fake LLM endpoint ----------------------------------------------------

let llmCalls = 0;
let maxInFlight = 0;
let inFlight = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, opts: any) => {
  if (!String(url).includes('api.bench.local')) return realFetch(url, opts);
  llmCalls++;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await sleep(LLM_MS);
  inFlight--;

  const body = JSON.parse(opts.body);
  const userContent: string = body.messages.find((m: any) => m.role === 'user')?.content ?? '';
  const systemContent: string = body.messages.find((m: any) => m.role === 'system')?.content ?? '';

  let content: string;
  if (systemContent.includes('proper noun extraction')) {
    content = '{"Whymper": "温珀"}';
  } else if (userContent.includes('<seg')) {
    // Echo back each segment id with a CJK translation
    const ids = [...userContent.matchAll(/<seg id="(\d+)">/g)].map((m) => m[1]);
    content = ids.map((id) => `<seg id="${id}">这是一段完整的中文翻译，向导温珀带领探险队穿过冰封的山口。</seg>`).join('\n');
  } else {
    content = '这是一段完整的中文翻译，向导温珀带领探险队穿过冰封的山口。';
  }

  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}) as typeof fetch;

// ---- Timestamped logging for per-chapter timing analysis ------------------

const benchStart = performance.now();
const origLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  origLog(`[t+${((performance.now() - benchStart) / 1000).toFixed(1)}s]`, ...args);
};

// ---- Run ------------------------------------------------------------------

const llmConfig = { apiKey: 'bench', baseURL: 'https://api.bench.local/v1', model: 'bench-model' };

const t0 = performance.now();
await translateBook(fakeDb, llmConfig, 'bench-uuid');
const elapsed = (performance.now() - t0) / 1000;

const expectedRows = CHAPTERS * NODES_PER_CHAPTER;
console.log('---- benchmark result ----');
console.log(`chapters=${CHAPTERS} nodes/chapter=${NODES_PER_CHAPTER} llm_latency=${LLM_MS}ms d1_latency=${D1_MS}ms`);
console.log(`wall clock:      ${elapsed.toFixed(1)}s`);
console.log(`LLM calls:       ${llmCalls} (max in-flight: ${maxInFlight})`);
console.log(`D1 round trips:  ${d1Calls}`);
console.log(`rows inserted:   ${insertedRows} (expected ${expectedRows})`);
if (insertedRows !== expectedRows) {
  console.error('!! row count mismatch — pipeline dropped or duplicated nodes');
  process.exit(1);
}
