/**
 * In-memory D1 stand-in for the eval harness.
 *
 * It implements just enough of the query surface that translate-worker.ts
 * exercises (matched by SQL fragments) to run the whole pipeline end-to-end
 * without a real Cloudflare D1 — so the eval measures the actual production
 * code path, not a re-implementation. It is intentionally NOT a general SQL
 * engine; if translate-worker's queries change, update the matchers here.
 */

import type { D1Client } from '../src/d1-client.js';

interface TextNode {
  xpath: string;
  text: string;
  html: string;
  orderIndex: number;
}

export interface MemoryChapter {
  chapter_number: number;
  title: string;
  original_title: string;
  text_nodes: TextNode[];
}

export interface TranslatedNode {
  chapterId: number;
  xpath: string;
  originalText: string;
  translatedText: string;
  orderIndex: number;
}

export interface MemoryBookInput {
  uuid: string;
  bookId: number;
  title: string;
  sourceLanguage: string;
  targetLanguage: string;
  chapters: MemoryChapter[];
}

/** Backing store; exposed so the eval can read results after translateBook. */
export class MemoryStore {
  job: Record<string, any>;
  book: Record<string, any>;
  chapters: Map<number, MemoryChapter & { id: number }>;
  translations: TranslatedNode[] = [];

  constructor(input: MemoryBookInput) {
    this.book = {
      id: input.bookId,
      uuid: input.uuid,
      title: input.title,
      original_title: input.title,
      status: 'processing',
    };
    this.chapters = new Map();
    input.chapters.forEach((ch, i) => {
      this.chapters.set(ch.chapter_number, { ...ch, id: 1000 + i });
    });
    this.job = {
      id: 1,
      book_id: input.bookId,
      book_uuid: input.uuid,
      source_language: input.sourceLanguage,
      target_language: input.targetLanguage,
      total_chapters: input.chapters.length,
      completed_chapters: 0,
      current_chapter: 0,
      current_item_offset: 0,
      glossary_json: null,
      glossary_extracted: 0,
      title_translated: 0,
      translated_title: null,
      status: 'pending',
      error_message: null,
      book_context_json: null,
      review_summary_json: null,
    };
  }

  /** Ordered final translations for a chapter (latest write wins per xpath+order). */
  chapterTranslations(chapterNumber: number): TranslatedNode[] {
    const chapter = this.chapters.get(chapterNumber);
    if (!chapter) return [];
    const byKey = new Map<string, TranslatedNode>();
    for (const t of this.translations) {
      if (t.chapterId !== chapter.id) continue;
      byKey.set(`${t.xpath}#${t.orderIndex}`, t);
    }
    return [...byKey.values()].sort((a, b) => a.orderIndex - b.orderIndex);
  }
}

function chapterByNumber(
  store: MemoryStore,
  params: unknown[]
): (MemoryChapter & { id: number }) | undefined {
  // Queries use (book_id, chapter_number) — chapter_number is the last param.
  const chNum = params[params.length - 1] as number;
  return store.chapters.get(chNum);
}

/** Build a D1Client-shaped object backed by the MemoryStore. */
export function makeMemoryD1(store: MemoryStore): D1Client {
  const first = async (sql: string, params: unknown[] = []): Promise<any> => {
    if (sql.includes('FROM translation_jobs')) return { ...store.job };
    if (sql.includes('text_nodes_json') && sql.includes('FROM chapters_v2')) {
      const ch = chapterByNumber(store, params);
      return ch ? { text_nodes_json: JSON.stringify(ch.text_nodes) } : null;
    }
    if (sql.includes('SELECT id FROM chapters_v2')) {
      const ch = chapterByNumber(store, params);
      return ch ? { id: ch.id } : null;
    }
    if (sql.includes('original_title FROM chapters_v2')) {
      const ch = chapterByNumber(store, params);
      return ch ? { original_title: ch.original_title } : null;
    }
    if (sql.includes('original_title FROM books_v2')) {
      return { original_title: store.book.original_title };
    }
    return null;
  };

  const run = async (sql: string, params: unknown[] = []): Promise<void> => {
    if (sql.startsWith('UPDATE translation_jobs')) {
      applyJobUpdate(store, sql, params);
      return;
    }
    if (sql.startsWith('UPDATE books_v2')) {
      // e.g. SET title = ? ... / SET status = 'ready'
      if (sql.includes('SET title =')) store.book.title = params[0];
      if (sql.includes("status = 'ready'")) store.book.status = 'ready';
      if (sql.includes("status = 'error'")) store.book.status = 'error';
      return;
    }
    if (sql.startsWith('UPDATE chapters_v2')) {
      if (sql.includes('SET title =')) {
        const ch = chapterByNumber(store, params);
        if (ch) ch.title = params[0] as string;
      }
      // text_nodes_json = NULL cleanup — no-op for the store
      return;
    }
    if (sql.startsWith('UPDATE translations_v2')) {
      // SET translated_text = ? WHERE chapter_id = ? AND xpath = ? AND order_index = ?
      const [text, chapterId, xpath, orderIndex] = params as [
        string,
        number,
        string,
        number,
      ];
      const existing = store.translations.find(
        (t) =>
          t.chapterId === chapterId &&
          t.xpath === xpath &&
          t.orderIndex === orderIndex
      );
      if (existing) existing.translatedText = text;
      return;
    }
    // INSERT paths go through batchInsert; ignore any other run()
  };

  const batchInsert = async (
    table: string,
    columns: string[],
    rows: unknown[][]
  ): Promise<void> => {
    if (table !== 'translations_v2') return;
    // columns: chapter_id, xpath, original_text, original_html, translated_text, order_index
    for (const row of rows) {
      const rec: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        rec[c] = row[i];
      });
      const node: TranslatedNode = {
        chapterId: rec.chapter_id as number,
        xpath: rec.xpath as string,
        originalText: rec.original_text as string,
        translatedText: rec.translated_text as string,
        orderIndex: rec.order_index as number,
      };
      // Replace-on-conflict semantics (INSERT OR REPLACE)
      const idx = store.translations.findIndex(
        (t) =>
          t.chapterId === node.chapterId &&
          t.xpath === node.xpath &&
          t.orderIndex === node.orderIndex
      );
      if (idx >= 0) store.translations[idx] = node;
      else store.translations.push(node);
    }
  };

  return {
    first,
    run,
    batchInsert,
    all: async () => [],
    query: async () => ({ results: [], success: true }),
  } as unknown as D1Client;
}

const NUMERIC_JOB_COLS = new Set([
  'completed_chapters',
  'current_chapter',
  'current_item_offset',
  'glossary_extracted',
  'title_translated',
  'total_chapters',
]);

/**
 * Apply an `UPDATE translation_jobs SET a = ?, b = ? WHERE ...` by parsing the
 * assigned columns in order and binding the leading params to them. Literal
 * assignments (e.g. status = 'translating', current_chapter = 1) are applied
 * directly. The trailing WHERE book_uuid = ? param is ignored.
 */
function applyJobUpdate(
  store: MemoryStore,
  sql: string,
  params: unknown[]
): void {
  const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
  const assignments = splitTopLevel(setClause);
  let paramIdx = 0;
  for (const assign of assignments) {
    const eq = assign.indexOf('=');
    if (eq < 0) continue;
    const col = assign.slice(0, eq).trim();
    const val = assign.slice(eq + 1).trim();
    if (col === 'updated_at') continue;
    if (val === '?') {
      let bound = params[paramIdx++];
      if (typeof bound === 'string' && NUMERIC_JOB_COLS.has(col))
        bound = Number(bound);
      store.job[col] = bound;
    } else if (val === 'CURRENT_TIMESTAMP') {
      // ignore
    } else {
      // literal, e.g. 'translating' or 1
      const m = val.match(/^'(.*)'$/);
      store.job[col] = m ? m[1] : NUMERIC_JOB_COLS.has(col) ? Number(val) : val;
    }
  }
}

/** Split a SET clause on top-level commas (none of our values contain commas). */
function splitTopLevel(clause: string): string[] {
  return clause
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
