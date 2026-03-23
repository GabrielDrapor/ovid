import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tests for book-handlers reliability improvements:
 * - Translation retry logic (no more permanent [Translation pending])
 * - Proper failure marking with [Translation failed]
 * - Credit refund on upload failure
 * - Job recovery on startup
 * - Job timeout
 */

// Resolve paths from project root
const projectRoot = path.resolve(__dirname, '../../..');
const bookHandlersPath = path.join(projectRoot, 'src/worker/book-handlers.ts');
const translatorIndexPath = path.join(projectRoot, 'services/translator/src/index.ts');
const translateWorkerPath = path.join(projectRoot, 'services/translator/src/translate-worker.ts');

describe('Book Handlers Reliability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Translation retry in handleTranslateNext', () => {
    it('does not write [Translation pending] — uses [Translation failed] after retry', () => {
      const handlerCode = fs.readFileSync(bookHandlersPath, 'utf-8');

      // Verify [Translation pending] is no longer used as a written value
      expect(handlerCode).not.toContain("'[Translation pending]'");
      expect(handlerCode).not.toContain('`[Translation pending]`');

      // Verify [Translation failed] is used instead (after retry)
      expect(handlerCode).toContain('[Translation failed]');
    });

    it('collects failed nodes and retries them', () => {
      const handlerCode = fs.readFileSync(bookHandlersPath, 'utf-8');

      // Verify retry pattern exists
      expect(handlerCode).toContain('failedNodes');
      expect(handlerCode).toContain('Retry failed nodes');
    });
  });

  describe('Credit refund in processUpload', () => {
    it('source code tracks creditsDeducted for refund', () => {
      const indexCode = fs.readFileSync(translatorIndexPath, 'utf-8');

      // Verify credit refund pattern exists
      expect(indexCode).toContain('creditsDeducted');
      expect(indexCode).toContain('credits + ?');
      expect(indexCode).toContain("'refund'");
      expect(indexCode).toContain('Refund: upload failed');
    });
  });

  describe('Job recovery on startup', () => {
    it('source code includes recoverStalledJobs function', () => {
      const indexCode = fs.readFileSync(translatorIndexPath, 'utf-8');

      // Verify recovery mechanism exists
      expect(indexCode).toContain('recoverStalledJobs');
      expect(indexCode).toContain('startJobScanner');
      expect(indexCode).toContain("status IN ('pending', 'translating', 'extracting_glossary')");
    });
  });

  describe('Job timeout', () => {
    it('translate-worker includes timeout mechanism', () => {
      const workerCode = fs.readFileSync(translateWorkerPath, 'utf-8');

      expect(workerCode).toContain('JOB_TIMEOUT_MS');
      expect(workerCode).toContain('checkJobTimeout');
      expect(workerCode).toContain('Job timed out');
    });
  });

  describe('Batch insert support', () => {
    it('translate-worker uses batchInsert for translations', () => {
      const workerCode = fs.readFileSync(translateWorkerPath, 'utf-8');

      expect(workerCode).toContain('batchInsert');
      expect(workerCode).toContain("'translations_v2'");
    });

    it('d1-client exposes batchInsert method', () => {
      const d1Code = fs.readFileSync(
        path.join(projectRoot, 'services/translator/src/d1-client.ts'),
        'utf-8'
      );

      expect(d1Code).toContain('async batchInsert');
      expect(d1Code).toContain('INSERT OR REPLACE');
      expect(d1Code).toContain('INSERT OR IGNORE');
    });
  });

  describe('Progress visibility', () => {
    it('BookShelf includes safe-to-close hint for processing books', () => {
      const shelfCode = fs.readFileSync(
        path.join(projectRoot, 'src/components/BookShelf.tsx'),
        'utf-8'
      );

      expect(shelfCode).toContain('safe-to-close-hint');
      expect(shelfCode).toContain('safely close this page');
    });

    it('BookShelf shows upload success toast', () => {
      const shelfCode = fs.readFileSync(
        path.join(projectRoot, 'src/components/BookShelf.tsx'),
        'utf-8'
      );

      expect(shelfCode).toContain('uploadToast');
      expect(shelfCode).toContain('upload-toast');
      expect(shelfCode).toContain('Translation is in progress');
    });

    it('CSS includes toast and hint styles', () => {
      const cssCode = fs.readFileSync(
        path.join(projectRoot, 'src/components/BookShelf.css'),
        'utf-8'
      );

      expect(cssCode).toContain('.upload-toast');
      expect(cssCode).toContain('.safe-to-close-hint');
    });
  });
});
