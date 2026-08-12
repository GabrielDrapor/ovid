import { describe, it, expect, vi, beforeEach } from 'vitest';
import { translateBook, activeJobs } from '../translate-worker.js';
import type { D1Client } from '../d1-client.js';

const llmConfig = {
  apiKey: 'test-key',
  baseURL: 'https://api.test.com/v1',
  model: 'test-model',
};

function makeMockDb(overrides: Partial<Record<'first' | 'all' | 'run' | 'batchInsert', any>> = {}) {
  return {
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ results: [], success: true }),
    batchInsert: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as D1Client;
}

function makeJob(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    book_id: 100,
    book_uuid: 'test-uuid',
    source_language: 'en',
    target_language: 'zh',
    total_chapters: 2,
    completed_chapters: 0,
    current_chapter: 1,
    current_item_offset: 0,
    glossary_json: null,
    glossary_extracted: 0,
    title_translated: 0,
    translated_title: null,
    status: 'pending',
    error_message: null,
    ...overrides,
  };
}

function mockLlmResponse(text: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: text } }],
    }),
  });
}

/**
 * Mock for db.all serving the two queries the pooled pipeline makes:
 * the chunked chapter load and the per-chapter translation row counts.
 */
function mockAll(
  chapterRows: Array<{ id: number; chapter_number: number; original_title: string | null; text_nodes_json: string | null }>,
  counts: Array<{ chapter_id: number; cnt: number }> = []
) {
  return vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('text_nodes_json')) {
      const [, lo, hi] = params as [number, number, number];
      return chapterRows.filter(r => r.chapter_number >= lo && r.chapter_number <= hi);
    }
    if (sql.includes('GROUP BY chapter_id')) return counts;
    return [];
  });
}

describe('translateBook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    activeJobs.clear();
  });

  it('throws if no job found', async () => {
    const db = makeMockDb();
    await expect(translateBook(db, llmConfig, 'missing-uuid')).rejects.toThrow('No job found');
  });

  it('returns early if job already completed', async () => {
    const db = makeMockDb({
      first: vi.fn().mockResolvedValue(makeJob({ status: 'completed' })),
    });
    await translateBook(db, llmConfig, 'test-uuid');
    expect(db.run).not.toHaveBeenCalled();
  });

  it('runs full translation pipeline', async () => {
    const job = makeJob();
    const textNodes = [
      { xpath: '/p[1]', text: 'Hello world', html: '<p>Hello world</p>', orderIndex: 0 },
    ];

    let firstCallCount = 0;
    const mockFirst = vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('translation_jobs')) {
        firstCallCount++;
        // Return pending job first, then updated job for subsequent calls
        return firstCallCount === 1 ? job : { ...job, glossary_extracted: 1, glossary_json: '{}', title_translated: 1, status: 'translating' };
      }
      if (sql.includes('original_title')) {
        return { original_title: 'Test Book' };
      }
      return null;
    });

    const db = makeMockDb({
      first: mockFirst,
      all: mockAll([
        { id: 1, chapter_number: 1, original_title: 'Ch 1', text_nodes_json: JSON.stringify(textNodes) },
        { id: 2, chapter_number: 2, original_title: 'Ch 2', text_nodes_json: JSON.stringify(textNodes) },
      ]),
    });

    // Mock LLM calls
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"Hello": "你好"}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await translateBook(db, llmConfig, 'test-uuid');

    // Should have called db.run multiple times (status updates, translations, completion)
    expect(db.run).toHaveBeenCalled();
    // Job should be cleaned from activeJobs
    expect(activeJobs.has('test-uuid')).toBe(false);
  });

  it('cleans up activeJobs after successful translation', async () => {
    const job = makeJob();

    const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return job;
      if (sql.includes('text_nodes_json')) return { text_nodes_json: '[]' };
      if (sql.includes('original_title')) return { original_title: 'Test' };
      return null;
    });

    const db = makeMockDb({ first: mockFirst });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
        }),
      })
    );

    await translateBook(db, llmConfig, 'test-uuid');

    // After completion, activeJobs should be cleaned up
    expect(activeJobs.has('test-uuid')).toBe(false);
  });

  it('marks job as error on failure', async () => {
    const job = makeJob();
    const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return job;
      return null;
    });
    // Chapter load happens via db.all — fail there
    const mockAllThrow = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('text_nodes_json')) throw new Error('DB connection lost');
      return [];
    });

    const db = makeMockDb({ first: mockFirst, all: mockAllThrow });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
        }),
      })
    );

    await expect(translateBook(db, llmConfig, 'test-uuid')).rejects.toThrow('DB connection lost');

    // Should have tried to mark error in DB
    const errorCall = (db.run as any).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status = 'error'")
    );
    expect(errorCall).toBeDefined();
    expect(activeJobs.has('test-uuid')).toBe(false);
  });

  it('skips fully translated chapters on resume', async () => {
    const job = makeJob({
      glossary_extracted: 1,
      glossary_json: '{}',
      title_translated: 1,
      status: 'translating',
    });

    const textNodes = [
      { xpath: '/p[1]', text: 'First node', html: '<p>First node</p>', orderIndex: 0 },
      { xpath: '/p[2]', text: 'Second node', html: '<p>Second node</p>', orderIndex: 1 },
    ];

    const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return job;
      if (sql.includes('original_title')) return { original_title: 'Book' };
      return null;
    });

    const db = makeMockDb({
      first: mockFirst,
      all: mockAll(
        [
          { id: 1, chapter_number: 1, original_title: 'Ch 1', text_nodes_json: JSON.stringify(textNodes) },
          { id: 2, chapter_number: 2, original_title: 'Ch 2', text_nodes_json: JSON.stringify(textNodes) },
        ],
        // Chapter 1 already has all its rows → complete; chapter 2 untouched
        [{ chapter_id: 1, cnt: 2 }]
      ),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '<seg id="0">翻译一</seg>\n<seg id="1">翻译二</seg>' } }],
        }),
      })
    );

    await translateBook(db, llmConfig, 'test-uuid');

    const batchCalls = (db.batchInsert as any).mock.calls.filter(
      (c: any[]) => c[0] === 'translations_v2'
    );
    const allRows = batchCalls.flatMap((call: any[]) => call[2] as unknown[][]);
    // Only chapter 2's nodes get translated
    expect(allRows.length).toBe(2);
    expect(allRows.every((row: unknown[]) => row[0] === 2)).toBe(true);

    // Nothing was wiped — chapter 1 is complete, chapter 2 has no rows
    const deleteCalls = (db.run as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM translations_v2')
    );
    expect(deleteCalls.length).toBe(0);
  });

  it('wipes and redoes partially translated chapters on resume (no duplicate rows)', async () => {
    const job = makeJob({
      glossary_extracted: 1,
      glossary_json: '{}',
      title_translated: 1,
      status: 'translating',
    });

    const textNodes = [
      { xpath: '/p[1]', text: 'First node', html: '<p>First node</p>', orderIndex: 0 },
      { xpath: '/p[2]', text: 'Second node', html: '<p>Second node</p>', orderIndex: 1 },
    ];

    const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return job;
      if (sql.includes('original_title')) return { original_title: 'Book' };
      return null;
    });

    const db = makeMockDb({
      first: mockFirst,
      all: mockAll(
        [
          { id: 1, chapter_number: 1, original_title: 'Ch 1', text_nodes_json: JSON.stringify(textNodes) },
          { id: 2, chapter_number: 2, original_title: 'Ch 2', text_nodes_json: JSON.stringify(textNodes) },
        ],
        // Chapter 1 crashed mid-write: only 1 of 2 rows exists → partial
        [{ chapter_id: 1, cnt: 1 }]
      ),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '<seg id="0">翻译一</seg>\n<seg id="1">翻译二</seg>' } }],
        }),
      })
    );

    await translateBook(db, llmConfig, 'test-uuid');

    // The partial chapter's rows must be deleted before it is redone —
    // translations_v2 has no UNIQUE constraint, so redoing without the wipe
    // would duplicate paragraphs in the reader
    const deleteCalls = (db.run as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM translations_v2')
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][1]).toEqual([1]);

    // Both chapters fully (re)translated: 2 nodes each
    const batchCalls = (db.batchInsert as any).mock.calls.filter(
      (c: any[]) => c[0] === 'translations_v2'
    );
    const allRows = batchCalls.flatMap((call: any[]) => call[2] as unknown[][]);
    expect(allRows.length).toBe(4);
  });

  it('translates chapters concurrently through the shared pool', async () => {
    const job = makeJob({
      glossary_extracted: 1,
      glossary_json: '{}',
      title_translated: 1,
      status: 'translating',
      total_chapters: 6,
    });

    const textNodes = [
      { xpath: '/p[1]', text: 'Some paragraph text', html: '<p>Some paragraph text</p>', orderIndex: 0 },
    ];
    const chapterRows = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      chapter_number: i + 1,
      original_title: null, // no title items — isolate batch concurrency
      text_nodes_json: JSON.stringify(textNodes),
    }));

    const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return job;
      return null;
    });
    const db = makeMockDb({ first: mockFirst, all: mockAll(chapterRows) });

    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '中文翻译结果' } }] }),
        };
      })
    );

    await translateBook(db, llmConfig, 'test-uuid');

    // 6 single-batch chapters across a pool of 8 — without cross-chapter
    // concurrency this could never exceed 1
    expect(maxInFlight).toBeGreaterThanOrEqual(4);
    expect(activeJobs.has('test-uuid')).toBe(false);
  });

  it('retries after a 429 rate-limit response', async () => {
    const job = makeJob({
      glossary_extracted: 1,
      glossary_json: '{}',
      title_translated: 1,
      status: 'translating',
      total_chapters: 1,
    });

    const textNodes = [
      { xpath: '/p[1]', text: 'Rate limited text', html: '<p>Rate limited text</p>', orderIndex: 0 },
    ];

    const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return job;
      return null;
    });
    const db = makeMockDb({
      first: mockFirst,
      all: mockAll([
        { id: 1, chapter_number: 1, original_title: null, text_nodes_json: JSON.stringify(textNodes) },
      ]),
    });

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '0' : null) },
            text: async () => 'rate limited',
          };
        }
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '中文翻译结果' } }] }),
        };
      })
    );

    await translateBook(db, llmConfig, 'test-uuid');

    expect(calls).toBe(2);
    const batchCalls = (db.batchInsert as any).mock.calls.filter(
      (c: any[]) => c[0] === 'translations_v2'
    );
    const allRows = batchCalls.flatMap((call: any[]) => call[2] as unknown[][]);
    expect(allRows.length).toBe(1);
    expect(allRows[0][4]).toBe('中文翻译结果');
  });
});
