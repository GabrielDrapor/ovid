import { describe, it, expect, vi, beforeEach } from 'vitest';
import { translateBook, activeJobs } from '../translate-worker.js';
import type { D1Client } from '../d1-client.js';

const llmConfig = {
  apiKey: 'test-key',
  baseURL: 'https://api.test.com/v1',
  model: 'test-model',
};

function makeMockDb(overrides: Partial<Record<'first' | 'all' | 'run', any>> = {}) {
  return {
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ results: [], success: true }),
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
      if (sql.includes('text_nodes_json')) {
        return { text_nodes_json: JSON.stringify(textNodes) };
      }
      if (sql.includes('chapters_v2') && sql.includes('id')) {
        return { id: 1 };
      }
      if (sql.includes('original_title')) {
        return { original_title: 'Test Book' };
      }
      return null;
    });

    const db = makeMockDb({ first: mockFirst });

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
      if (sql.includes('text_nodes_json')) throw new Error('DB connection lost');
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

    await expect(translateBook(db, llmConfig, 'test-uuid')).rejects.toThrow('DB connection lost');

    // Should have tried to mark error in DB
    const errorCall = (db.run as any).mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes("status = 'error'")
    );
    expect(errorCall).toBeDefined();
    expect(activeJobs.has('test-uuid')).toBe(false);
  });

  it('resumes from offset on partially translated chapter', async () => {
    const job = makeJob({
      glossary_extracted: 1,
      glossary_json: '{}',
      title_translated: 1,
      status: 'translating',
      current_chapter: 1,
      current_item_offset: 1, // Already translated 1 node
    });

    const textNodes = [
      { xpath: '/p[1]', text: 'Already done', html: '<p>Already done</p>', orderIndex: 0 },
      { xpath: '/p[2]', text: 'Need this one', html: '<p>Need this one</p>', orderIndex: 1 },
    ];

    const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return job;
      if (sql.includes('text_nodes_json')) return { text_nodes_json: JSON.stringify(textNodes) };
      if (sql.includes('chapters_v2') && sql.includes('id')) return { id: 1 };
      if (sql.includes('original_title')) return { original_title: 'Ch 1' };
      return null;
    });

    const db = makeMockDb({ first: mockFirst });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '翻译结果' } }],
        }),
      })
    );

    await translateBook(db, llmConfig, 'test-uuid');

    // Should have inserted translation — offset=1 means skip first node of ch1,
    // translate 1 remaining node in ch1, then ch2 has empty text_nodes (same mock returns same nodes
    // but ch2 also gets translated). Count all translation inserts.
    const insertCalls = (db.run as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT OR REPLACE INTO translations_v2')
    );
    // Ch1: 1 node (skipped offset 0), Ch2: 2 nodes (fresh start) = 3 total
    expect(insertCalls.length).toBe(3);
  });
});
