/**
 * Integration tests using constructed EPUB files.
 * Tests the actual parsing pipeline + translation flow with real EPUB data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTestEpub } from './helpers/epub-builder.js';
import { parseEPUB, parseBook } from '../book-parser.js';
import { calculateBookCredits } from '../token-counter.js';
import { translateBook, activeJobs } from '../translate-worker.js';
import type { D1Client } from '../d1-client.js';

describe('EPUB Integration Tests', () => {
  describe('parseEPUB with constructed files', () => {
    it('parses a minimal 2-chapter EPUB correctly', async () => {
      const epub = await buildTestEpub();
      const book = await parseEPUB(epub);

      expect(book.title).toBe('Test Book');
      expect(book.author).toBe('Test Author');
      expect(book.chapters.length).toBe(2);

      // Chapter 1
      expect(book.chapters[0].title).toBe('The Beginning');
      expect(book.chapters[0].number).toBe(1);
      // h1 title + 2 paragraphs = 3 text nodes (parser counts h1 as block text)
      expect(book.chapters[0].textNodes.length).toBe(3);
      expect(book.chapters[0].textNodes[1].text).toContain('bright cold day');
      expect(book.chapters[0].textNodes[0].xpath).toMatch(/^\/body\[1\]/);

      // Chapter 2
      expect(book.chapters[1].title).toBe('The Journey');
      expect(book.chapters[1].number).toBe(2);
      expect(book.chapters[1].textNodes.length).toBe(3);
    });

    it('parses a single-chapter EPUB', async () => {
      const epub = await buildTestEpub({
        title: 'Short Story',
        author: 'A. Writer',
        chapters: [
          {
            title: 'Only Chapter',
            paragraphs: ['The one and only paragraph.'],
          },
        ],
      });
      const book = await parseEPUB(epub);

      expect(book.title).toBe('Short Story');
      expect(book.author).toBe('A. Writer');
      expect(book.chapters.length).toBe(1);
      // h1 + 1 paragraph = 2 text nodes
      expect(book.chapters[0].textNodes.length).toBe(2);
    });

    it('handles an EPUB with no text content gracefully', async () => {
      const epub = await buildTestEpub({ empty: true });
      const book = await parseEPUB(epub);

      expect(book.title).toBe('Test Book');
      expect(book.chapters.length).toBe(0);
    });

    it('parses a large chapter with many paragraphs', async () => {
      const epub = await buildTestEpub({ largeChapter: true });
      const book = await parseEPUB(epub);

      // Default 2 chapters + 1 large chapter
      expect(book.chapters.length).toBe(3);
      const largeChapter = book.chapters[2];
      expect(largeChapter.title).toBe('The Large Chapter');
      // h1 + 200 paragraphs = 201 text nodes
      expect(largeChapter.textNodes.length).toBe(201);
    });

    it('decodes HTML entities in text nodes', async () => {
      const epub = await buildTestEpub({ withEntities: true });
      const book = await parseEPUB(epub);

      // Find the entities chapter (after the 2 default chapters)
      const entitiesChapter = book.chapters.find((ch) =>
        ch.textNodes.some((n) => n.text.includes('hello'))
      );
      expect(entitiesChapter).toBeDefined();

      const helloNode = entitiesChapter!.textNodes.find((n) =>
        n.text.includes('hello')
      );
      // Entities should be decoded
      expect(helloNode!.text).toContain('"hello"');
      expect(helloNode!.text).toContain('& waved');
    });

    it('handles nested block elements', async () => {
      const epub = await buildTestEpub({
        chapters: [],
        nestedBlocks: true,
      });
      const book = await parseEPUB(epub);

      expect(book.chapters.length).toBe(1);
      const ch = book.chapters[0];
      // Should find text nodes inside nested divs
      expect(ch.textNodes.length).toBeGreaterThanOrEqual(2);
      const nestedText = ch.textNodes.find((n) =>
        n.text.includes('Nested paragraph')
      );
      expect(nestedText).toBeDefined();
    });

    it('extracts images from EPUB', async () => {
      const epub = await buildTestEpub({ includeImage: true });
      const book = await parseEPUB(epub);

      expect(book.images).toBeDefined();
      expect(book.images!.length).toBe(1);
      expect(book.images![0].filename).toBe('test.png');
      expect(book.images![0].mediaType).toBe('image/png');
      expect(book.images![0].data.length).toBeGreaterThan(0);
    });

    it('extracts CSS styles from EPUB', async () => {
      const epub = await buildTestEpub({ includeStyles: true });
      const book = await parseEPUB(epub);

      expect(book.styles).toBeDefined();
      expect(book.styles).toContain('font-family');
    });

    it('preserves rawHtml in chapters', async () => {
      const epub = await buildTestEpub();
      const book = await parseEPUB(epub);

      expect(book.chapters[0].rawHtml).toContain('<h1>');
      expect(book.chapters[0].rawHtml).toContain('<p>');
      expect(book.chapters[0].rawHtml).toContain('The Beginning');
    });

    it('generates unique XPaths for each text node', async () => {
      const epub = await buildTestEpub({
        chapters: [
          {
            title: 'Multi-para',
            paragraphs: ['First.', 'Second.', 'Third.', 'Fourth.', 'Fifth.'],
          },
        ],
      });
      const book = await parseEPUB(epub);

      const xpaths = book.chapters[0].textNodes.map((n) => n.xpath);
      const uniqueXpaths = new Set(xpaths);
      expect(uniqueXpaths.size).toBe(xpaths.length);
    });

    it('assigns sequential orderIndex to text nodes', async () => {
      const epub = await buildTestEpub();
      const book = await parseEPUB(epub);

      for (const chapter of book.chapters) {
        for (let i = 0; i < chapter.textNodes.length; i++) {
          expect(chapter.textNodes[i].orderIndex).toBe(i);
        }
      }
    });
  });

  describe('parseBook dispatcher', () => {
    it('routes .epub to parseEPUB', async () => {
      const epub = await buildTestEpub({ title: 'Dispatch Test' });
      const book = await parseBook(epub, '.epub');
      expect(book.title).toBe('Dispatch Test');
    });
  });

  describe('Credit calculation with real EPUB data', () => {
    it('calculates credits proportional to text volume', async () => {
      const smallEpub = await buildTestEpub({
        chapters: [{ title: 'Ch', paragraphs: ['Short text.'] }],
      });
      const largeEpub = await buildTestEpub({ largeChapter: true });

      const smallBook = await parseEPUB(smallEpub);
      const largeBook = await parseEPUB(largeEpub);

      const smallTexts = smallBook.chapters.flatMap((ch) =>
        ch.textNodes.map((n) => n.text)
      );
      const largeTexts = largeBook.chapters.flatMap((ch) =>
        ch.textNodes.map((n) => n.text)
      );

      const smallCredits = calculateBookCredits(smallTexts, 'zh');
      const largeCredits = calculateBookCredits(largeTexts, 'zh');

      expect(largeCredits).toBeGreaterThan(smallCredits);
      expect(smallCredits).toBeGreaterThan(0);
    });

    it('Chinese target costs more credits than default', async () => {
      const epub = await buildTestEpub();
      const book = await parseEPUB(epub);
      const texts = book.chapters.flatMap((ch) => ch.textNodes.map((n) => n.text));

      const zhCredits = calculateBookCredits(texts, 'zh');
      const esCredits = calculateBookCredits(texts, 'es');

      // Chinese has 1.5x output multiplier vs Spanish 1.2x
      expect(zhCredits).toBeGreaterThan(esCredits);
    });
  });

  describe('Full translation pipeline with EPUB', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      activeJobs.clear();
    });

    it('translates a constructed EPUB end-to-end', async () => {
      const epub = await buildTestEpub({
        title: 'Pipeline Test',
        author: 'Tester',
        chapters: [
          {
            title: 'Chapter One',
            paragraphs: [
              'The sun was setting over the mountains.',
              'Birds sang in the trees.',
            ],
          },
        ],
      });

      // Parse the EPUB (this is what processUpload does)
      const bookData = await parseEPUB(epub);
      expect(bookData.chapters.length).toBe(1);
      // h1 title + 2 paragraphs = 3 text nodes
      expect(bookData.chapters[0].textNodes.length).toBe(3);

      // Now simulate the translation pipeline with mocked DB and LLM
      const job = {
        id: 1,
        book_id: 100,
        book_uuid: 'pipeline-test',
        source_language: 'en',
        target_language: 'zh',
        total_chapters: bookData.chapters.length,
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

      // Feed actual parsed text nodes into the mock DB
      const textNodesJson = JSON.stringify(bookData.chapters[0].textNodes);

      const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('translation_jobs')) return job;
        if (sql.includes('text_nodes_json'))
          return { text_nodes_json: textNodesJson };
        if (sql.includes('chapters_v2') && sql.includes('id'))
          return { id: 1 };
        if (sql.includes('original_title'))
          return { original_title: bookData.title };
        return null;
      });

      const db = {
        first: mockFirst,
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ results: [], success: true }),
        batchInsert: vi.fn().mockResolvedValue(undefined),
      } as unknown as D1Client;

      // Mock LLM to return predictable translations
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (_url: string, opts: any) => {
          const body = JSON.parse(opts.body);
          const userMsg = body.messages?.find((m: any) =>
            m.content?.includes('<translate>')
          );

          let translation = '翻译结果';
          if (userMsg?.content?.includes('sun was setting')) {
            translation = '太阳正在山后落下。';
          } else if (userMsg?.content?.includes('Birds sang')) {
            translation = '鸟儿在树上歌唱。';
          } else if (userMsg?.content?.includes('Pipeline Test')) {
            translation = '流水线测试';
          }

          // Glossary extraction
          if (body.messages?.[0]?.content?.includes('proper noun')) {
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: '{}' } }],
              }),
            };
          }

          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: translation } }],
            }),
          };
        })
      );

      await translateBook(db, {
        apiKey: 'test',
        baseURL: 'https://test.com/v1',
        model: 'test',
      }, 'pipeline-test');

      // Verify translations were written via batchInsert
      const batchCalls = (db.batchInsert as any).mock.calls;
      const translationBatches = batchCalls.filter(
        (c: any[]) => c[0] === 'translations_v2'
      );
      expect(translationBatches.length).toBeGreaterThan(0);

      const allRows = translationBatches.flatMap(
        (call: any[]) => call[2] as unknown[][]
      );
      // 3 text nodes translated (h1 title + 2 paragraphs)
      expect(allRows.length).toBe(3);

      // Verify the actual XPaths from the parsed EPUB were used
      const xpathsWritten = allRows.map((row: unknown[]) => row[1]);
      const xpathsExpected = bookData.chapters[0].textNodes.map(
        (n) => n.xpath
      );
      expect(xpathsWritten).toEqual(expect.arrayContaining(xpathsExpected));

      // Verify book was marked completed
      const completeCalls = (db.run as any).mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === 'string' &&
          c[0].includes("status = 'completed'")
      );
      expect(completeCalls.length).toBeGreaterThan(0);

      // Verify activeJobs cleaned up
      expect(activeJobs.has('pipeline-test')).toBe(false);
    });

    it('handles an EPUB where some nodes fail translation', { timeout: 30000 }, async () => {
      const epub = await buildTestEpub({
        chapters: [
          {
            title: 'Flaky Chapter',
            paragraphs: [
              'This will succeed.',
              'This will fail on first try.',
              'This will also succeed.',
            ],
          },
        ],
      });

      const bookData = await parseEPUB(epub);
      const textNodesJson = JSON.stringify(bookData.chapters[0].textNodes);

      const job = {
        id: 1, book_id: 100, book_uuid: 'flaky-test',
        source_language: 'en', target_language: 'zh',
        total_chapters: 1, completed_chapters: 0,
        current_chapter: 1, current_item_offset: 0,
        glossary_json: '{}', glossary_extracted: 1,
        title_translated: 1, translated_title: '测试',
        status: 'translating', error_message: null,
      };

      const mockFirst = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('translation_jobs')) return job;
        if (sql.includes('text_nodes_json')) return { text_nodes_json: textNodesJson };
        if (sql.includes('chapters_v2') && sql.includes('id')) return { id: 1 };
        if (sql.includes('original_title')) return { original_title: 'Flaky' };
        return null;
      });

      const db = {
        first: mockFirst,
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ results: [], success: true }),
        batchInsert: vi.fn().mockResolvedValue(undefined),
      } as unknown as D1Client;

      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
        const body = JSON.parse(opts.body);
        const userMsg = body.messages?.find((m: any) => m.content?.includes('fail on first'));
        if (userMsg) {
          return { ok: false, text: async () => 'Error 500' };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '翻译成功' } }],
          }),
        };
      }));

      await translateBook(db, {
        apiKey: 'test', baseURL: 'https://test.com/v1', model: 'test',
      }, 'flaky-test');

      const batchCalls = (db.batchInsert as any).mock.calls
        .filter((c: any[]) => c[0] === 'translations_v2');
      const allRows = batchCalls.flatMap((call: any[]) => call[2] as unknown[][]);

      // h1 + 3 paragraphs = 4 text nodes; 3 succeed + 1 fails permanently
      expect(allRows.length).toBe(4);

      // The permanently failing node should have [Translation failed]
      const failedRows = allRows.filter((row: unknown[]) => row[4] === '[Translation failed]');
      expect(failedRows.length).toBe(1);

      // No [Translation pending] should exist
      const pendingRows = allRows.filter((row: unknown[]) => row[4] === '[Translation pending]');
      expect(pendingRows.length).toBe(0);
    });
  });
});
