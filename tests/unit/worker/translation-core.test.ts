import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  planTranslation,
  translateChapterStep,
  finalizeStep,
  detectEnglishResidue,
  TRANSLATION_FAILED_MARKER,
} from '../../../src/worker/translation/translate-core';
import type { DbClient } from '../../../src/worker/translation/d1-binding-client';

const llm = { apiKey: 'k', baseURL: 'https://llm.test/v1', model: 'test-model' };

const JOB = {
  id: 1,
  book_id: 100,
  book_uuid: 'cf-test',
  source_language: 'en',
  target_language: 'zh',
  total_chapters: 2,
  completed_chapters: 0,
  current_chapter: 1,
  glossary_json: '{}',
  glossary_extracted: 1,
  title_translated: 1,
  status: 'translating',
  backend: 'cf',
};

interface MockDbSetup {
  chapterMeta?: Array<{ id: number; chapter_number: number; node_count: number }>;
  counts?: Array<{ chapter_id: number; cnt: number }>;
  chapterRow?: { id: number; original_title: string | null; text_nodes_json: string | null };
  countForChapter?: number;
  incompleteCount?: number;
  translatedTotal?: number;
  chaptersWithNodes?: number;
  job?: Record<string, unknown>;
}

function makeDb(setup: MockDbSetup) {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const inserts: unknown[][] = [];
  const db: DbClient = {
    first: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM translation_jobs')) return setup.job ?? JOB;
      if (sql.includes('COUNT(*) AS cnt FROM translations_v2')) return { cnt: setup.countForChapter ?? 0 };
      if (sql.includes('COUNT(*) AS n FROM translations_v2')) return { n: setup.translatedTotal ?? 1 };
      if (sql.includes('json_array_length(text_nodes_json), 0) > 0')) return { n: setup.chaptersWithNodes ?? 1 };
      if (sql.includes('COUNT(*) AS n FROM chapters_v2')) return { n: setup.incompleteCount ?? 0 };
      if (sql.includes('SELECT id, original_title, text_nodes_json')) return setup.chapterRow ?? null;
      if (sql.includes('original_title FROM books_v2')) return { original_title: 'Book' };
      return null;
    }),
    all: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('json_array_length(text_nodes_json), 0) AS node_count')) return setup.chapterMeta ?? [];
      if (sql.includes('GROUP BY chapter_id')) return setup.counts ?? [];
      return [];
    }),
    run: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
      runs.push({ sql, params });
    }),
    batchInsert: vi.fn().mockImplementation(async (_t: string, _c: string[], rows: unknown[][]) => {
      inserts.push(...rows);
    }),
  };
  return { db, runs, inserts };
}

function stubLlm(content: string | ((body: any) => string)) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    const text = typeof content === 'function' ? content(body) : content;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: text } }] }),
    };
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('planTranslation', () => {
  it('skips complete chapters, wipes partial ones, queues the rest', async () => {
    const { db, runs } = makeDb({
      chapterMeta: [
        { id: 11, chapter_number: 1, node_count: 5 }, // complete
        { id: 12, chapter_number: 2, node_count: 5 }, // partial → wipe
        { id: 13, chapter_number: 3, node_count: 5 }, // untouched
        { id: 14, chapter_number: 4, node_count: 0 }, // empty → not pending
      ],
      counts: [
        { chapter_id: 11, cnt: 5 },
        { chapter_id: 12, cnt: 2 },
      ],
      job: { ...JOB, total_chapters: 4 },
    });

    const plan = await planTranslation(db, 'cf-test');

    expect(plan.alreadyCompleted).toBe(false);
    expect(plan.pendingChapters).toEqual([2, 3]);

    const del = runs.find(r => r.sql.includes('DELETE FROM translations_v2'));
    expect(del).toBeDefined();
    expect(del!.params).toEqual([12]);
  });

  it('short-circuits completed jobs', async () => {
    const { db } = makeDb({ job: { ...JOB, status: 'completed' } });
    const plan = await planTranslation(db, 'cf-test');
    expect(plan.alreadyCompleted).toBe(true);
  });
});

describe('translateChapterStep', () => {
  const nodes = [
    { xpath: '/p[1]', text: 'First paragraph text', html: '<p>First</p>', orderIndex: 0 },
    { xpath: '/p[2]', text: 'Second paragraph text', html: '<p>Second</p>', orderIndex: 1 },
  ];

  it('is idempotent: fully translated chapter makes zero LLM calls', async () => {
    const { db, inserts } = makeDb({
      chapterRow: { id: 11, original_title: 'Ch 1', text_nodes_json: JSON.stringify(nodes) },
      countForChapter: 2,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await translateChapterStep(db, llm, 'cf-test', 1);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserts.length).toBe(0);
  });

  it('wipes partial rows before redoing (step-retry safety)', async () => {
    const { db, runs, inserts } = makeDb({
      chapterRow: { id: 11, original_title: null, text_nodes_json: JSON.stringify(nodes) },
      countForChapter: 1, // crashed previous attempt left 1 of 2 rows
    });
    stubLlm('<seg id="0">第一段</seg>\n<seg id="1">第二段</seg>');

    await translateChapterStep(db, llm, 'cf-test', 1);

    const del = runs.find(r => r.sql.includes('DELETE FROM translations_v2'));
    expect(del).toBeDefined();
    expect(del!.params).toEqual([11]);
    expect(inserts.length).toBe(2);
    expect(inserts.map(r => r[4])).toEqual(['第一段', '第二段']);
  });

  it('writes the failure marker for permanently failing nodes', async () => {
    const { db, inserts } = makeDb({
      chapterRow: { id: 11, original_title: null, text_nodes_json: JSON.stringify(nodes) },
      countForChapter: 0,
    });
    // Batch call returns only seg 0; seg 1 goes to individual retry, which
    // fails every time → marker row
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      const userContent = body.messages.find((m: any) => m.role === 'user')?.content ?? '';
      if (userContent.includes('<seg')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: '<seg id="0">第一段</seg>' } }] }) };
      }
      return { ok: false, status: 500, text: async () => 'boom' };
    }));

    await translateChapterStep(db, llm, 'cf-test', 1);

    expect(inserts.length).toBe(2);
    const byXpath = new Map(inserts.map(r => [r[1], r[4]]));
    expect(byXpath.get('/p[1]')).toBe('第一段');
    expect(byXpath.get('/p[2]')).toBe(TRANSLATION_FAILED_MARKER);
  }, 30000);

  it('updates job progress with a derived completed_chapters count', async () => {
    const { db, runs } = makeDb({
      chapterRow: { id: 11, original_title: null, text_nodes_json: JSON.stringify(nodes) },
      countForChapter: 0,
    });
    stubLlm('<seg id="0">第一段</seg>\n<seg id="1">第二段</seg>');

    await translateChapterStep(db, llm, 'cf-test', 1);

    const progress = runs.find(r => r.sql.includes('completed_chapters = ('));
    expect(progress).toBeDefined();
    expect(progress!.sql).toContain('json_array_length');
  });
});

describe('detectEnglishResidue (mirror of translate-worker.ts)', () => {
  it('flags bare lowercase common words in mostly-Chinese text (2026-08 regression)', () => {
    const text =
      '他尤其喜欢对阵那些有明确、僵化哲学的主帅——这 simply 让他的战术任务更容易，正如他在 2014 年的一次采访中所概述的那样。';
    expect(detectEnglishResidue(text, {})).toEqual(['simply']);
  });

  it('does not flag quoted words, glosses, proper nouns, or pinyin', () => {
    expect(detectEnglishResidue('因为剪切者在剪“keep away”这个词时不得不剪了两下。', {})).toEqual([]);
    expect(detectEnglishResidue('每当您看到这样一座泰勒（tell）或孤立土丘。', {})).toEqual([]);
    expect(detectEnglishResidue('正如 Hessler 在书中所写，Feng tong xing 一家搬到了涪陵。', {})).toEqual([]);
  });
});

describe('finalizeStep', () => {
  it('refuses to finalize while chapters are incomplete', async () => {
    const { db } = makeDb({ incompleteCount: 2 });
    await expect(finalizeStep(db, 'cf-test')).rejects.toThrow('still incomplete');
  });

  it('marks book ready and clears text_nodes_json when complete', async () => {
    const { db, runs } = makeDb({ incompleteCount: 0 });
    await finalizeStep(db, 'cf-test');
    expect(runs.some(r => r.sql.includes("SET status = 'ready'"))).toBe(true);
    expect(runs.some(r => r.sql.includes('text_nodes_json = NULL'))).toBe(true);
    expect(runs.some(r => r.sql.includes("status = 'completed'"))).toBe(true);
  });

  it('refuses to publish an empty book (no nodes, no translations)', async () => {
    // Corrupted state: text_nodes_json cleared while job incomplete —
    // finalize must fail loudly instead of shipping a hollow "ready" book
    const { db, runs } = makeDb({ incompleteCount: 0, translatedTotal: 0, chaptersWithNodes: 0 });
    await expect(finalizeStep(db, 'cf-test')).rejects.toThrow('refusing to mark ready');
    expect(runs.some(r => r.sql.includes("SET status = 'ready'"))).toBe(false);
  });
});
