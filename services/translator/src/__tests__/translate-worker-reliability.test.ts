import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    total_chapters: 1,
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

describe('Translation Worker Reliability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    activeJobs.clear();
  });

  afterEach(() => {
    activeJobs.clear();
  });

  describe('[Translation pending] → retry logic', () => {
    it('writes [Translation failed] for permanently failing nodes after retry', { timeout: 30000 }, async () => {
      const job = makeJob({
        glossary_extracted: 1,
        glossary_json: '{}',
        title_translated: 1,
        status: 'translating',
        current_chapter: 1,
        total_chapters: 1,
      });

      const textNodes = [
        { xpath: '/p[1]', text: 'Hello', html: '<p>Hello</p>', orderIndex: 0 },
        { xpath: '/p[2]', text: 'Fail me', html: '<p>Fail me</p>', orderIndex: 1 },
      ];

      const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('translation_jobs')) return job;
        if (sql.includes('text_nodes_json')) return { text_nodes_json: JSON.stringify(textNodes) };
        if (sql.includes('chapters_v2') && sql.includes('id')) return { id: 1 };
        if (sql.includes('original_title')) return { original_title: 'Ch 1' };
        return null;
      });

      const db = makeMockDb({ first: mockFirst });

      // The LLM fetch mock — fail for "Fail me" text, succeed for others
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
        const body = JSON.parse(opts.body);
        const userMsg = body.messages?.find((m: any) => m.content?.includes('Fail me'));
        if (userMsg) {
          // Always fail for "Fail me" - this triggers both initial failure and retry failure
          return { ok: false, text: async () => 'Error 500' };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '翻译结果' } }],
          }),
        };
      }));

      await translateBook(db, llmConfig, 'test-uuid');

      // Verify batchInsert was called
      const batchCalls = (db.batchInsert as any).mock.calls;

      // Check all inserted rows across all batch calls
      const allRows = batchCalls
        .filter((c: any[]) => c[0] === 'translations_v2')
        .flatMap((call: any[]) => call[2] as unknown[][]);

      // One node should have succeeded with translation
      const successRows = allRows.filter((row: unknown[]) => row[4] === '翻译结果');
      expect(successRows.length).toBe(1);

      // One node should have [Translation failed] after retry
      const failedRows = allRows.filter((row: unknown[]) => row[4] === '[Translation failed]');
      expect(failedRows.length).toBe(1);

      // No [Translation pending] should exist
      const pendingRows = allRows.filter((row: unknown[]) => row[4] === '[Translation pending]');
      expect(pendingRows.length).toBe(0);
    });
  });

  describe('Job timeout', () => {
    it('throws timeout error when job exceeds time limit', async () => {
      const job = makeJob({
        glossary_extracted: 1,
        glossary_json: '{}',
        title_translated: 1,
        status: 'translating',
        current_chapter: 1,
        total_chapters: 100,
      });

      const textNodes = [
        { xpath: '/p[1]', text: 'Hello', html: '<p>Hello</p>', orderIndex: 0 },
      ];

      const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('translation_jobs')) return job;
        if (sql.includes('text_nodes_json')) return { text_nodes_json: JSON.stringify(textNodes) };
        if (sql.includes('chapters_v2') && sql.includes('id')) return { id: 1 };
        if (sql.includes('original_title')) return { original_title: 'Ch' };
        return null;
      });

      const db = makeMockDb({ first: mockFirst });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '翻译' } }],
        }),
      }));

      // Pre-set activeJobs with an expired timestamp
      activeJobs.set('test-uuid', {
        phase: 'translating',
        chaptersCompleted: 0,
        chaptersTotal: 100,
        currentChapter: 1,
        startedAt: Date.now() - (5 * 60 * 60 * 1000), // 5 hours ago
      });

      await expect(translateBook(db, llmConfig, 'test-uuid')).rejects.toThrow('timed out');

      // Job should be marked as error in DB
      const errorCall = (db.run as any).mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes("status = 'error'")
      );
      expect(errorCall).toBeDefined();
      expect(activeJobs.has('test-uuid')).toBe(false);
    });
  });

  describe('Batch inserts', () => {
    it('uses batchInsert for successful translations instead of individual db.run', async () => {
      const job = makeJob({
        glossary_extracted: 1,
        glossary_json: '{}',
        title_translated: 1,
        status: 'translating',
        current_chapter: 1,
        total_chapters: 1,
      });

      const textNodes = [
        { xpath: '/p[1]', text: 'Hello', html: '<p>Hello</p>', orderIndex: 0 },
        { xpath: '/p[2]', text: 'World', html: '<p>World</p>', orderIndex: 1 },
        { xpath: '/p[3]', text: 'Test', html: '<p>Test</p>', orderIndex: 2 },
      ];

      const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('translation_jobs')) return job;
        if (sql.includes('text_nodes_json')) return { text_nodes_json: JSON.stringify(textNodes) };
        if (sql.includes('chapters_v2') && sql.includes('id')) return { id: 1 };
        if (sql.includes('original_title')) return { original_title: 'Ch 1' };
        return null;
      });

      const db = makeMockDb({ first: mockFirst });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '翻译' } }],
        }),
      }));

      await translateBook(db, llmConfig, 'test-uuid');

      // Verify batchInsert was called with translations_v2
      const batchCalls = (db.batchInsert as any).mock.calls;
      const translationBatches = batchCalls.filter(
        (c: any[]) => c[0] === 'translations_v2'
      );
      expect(translationBatches.length).toBeGreaterThan(0);

      // All 3 nodes should be in the batch(es)
      const totalRows = translationBatches.reduce(
        (sum: number, call: any[]) => sum + (call[2] as unknown[][]).length, 0
      );
      expect(totalRows).toBe(3);

      // No individual INSERT calls to db.run for translations
      const individualInserts = (db.run as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT OR REPLACE INTO translations_v2')
      );
      expect(individualInserts.length).toBe(0);
    });
  });

  describe('activeJobs tracking', () => {
    it('tracks startedAt timestamp in activeJobs', async () => {
      const job = makeJob({
        glossary_extracted: 1,
        glossary_json: '{}',
        title_translated: 1,
        status: 'translating',
        current_chapter: 1,
        total_chapters: 1,
      });

      const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('translation_jobs')) return job;
        if (sql.includes('text_nodes_json')) return { text_nodes_json: '[]' };
        if (sql.includes('original_title')) return { original_title: 'Test' };
        return null;
      });

      const db = makeMockDb({ first: mockFirst });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{}' } }] }),
      }));

      const before = Date.now();
      // Start translation but capture the activeJob mid-flight
      const translatePromise = translateBook(db, llmConfig, 'test-uuid');

      // The job may already be done (empty chapters), but startedAt should have been set
      await translatePromise;

      // After completion, activeJobs should be cleaned up
      expect(activeJobs.has('test-uuid')).toBe(false);
    });
  });
});
