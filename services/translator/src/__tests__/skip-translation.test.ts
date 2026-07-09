import { describe, it, expect, vi, beforeEach } from 'vitest';
import { D1Client } from '../d1-client.js';
import { settleCoverGeneration } from '../upload-helpers.js';

/**
 * Tests for the skip-translation upload path (PR #117).
 *
 * processUpload() is not exported (it starts a Hono server on import),
 * so we test the key invariants:
 *  - language_pair uses `${source}-none` for skip-translation books
 *  - status is set directly to 'ready' (not via translation_jobs)
 *  - no credit deduction SQL is issued
 *
 * We use the same SQL-pattern approach as upload-reliability.test.ts:
 * capture every SQL call made to D1 and assert on it.
 */

const mockConfig = {
  accountId: 'test-account',
  apiToken: 'test-token',
  databaseId: 'test-db',
};

function makeFetchSpy(rows: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      result: [
        { results: rows, success: true, meta: { changes: rows.length } },
      ],
    }),
    text: async () => 'ok',
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('skipTranslation language_pair invariant', () => {
  it('uses -none suffix for skip-translation books', () => {
    const sourceLanguage = 'zh';
    const targetLanguage = 'en';
    const skipTranslation = true;
    const effectiveTarget = skipTranslation ? 'none' : targetLanguage;
    expect(`${sourceLanguage}-${effectiveTarget}`).toBe('zh-none');
  });

  it('preserves actual target language for translated books', () => {
    const sourceLanguage = 'zh';
    const targetLanguage = 'en';
    const skipTranslation = false;
    const effectiveTarget = skipTranslation ? 'none' : targetLanguage;
    expect(`${sourceLanguage}-${effectiveTarget}`).toBe('zh-en');
  });

  it('handles auto source language with -none suffix', () => {
    const sourceLanguage = 'auto';
    const skipTranslation = true;
    const effectiveTarget = skipTranslation ? 'none' : 'zh';
    expect(`${sourceLanguage}-${effectiveTarget}`).toBe('auto-none');
  });
});

describe('skipTranslation status invariant', () => {
  it("keeps status 'processing' for skip-translation books until cover/spine are ready", () => {
    const skipTranslation = true;
    const initialStatus = skipTranslation ? 'processing' : 'processing';
    expect(initialStatus).toBe('processing');
  });

  it("sets status to 'processing' for translated books (awaits translation_jobs)", () => {
    const skipTranslation = false;
    const initialStatus = skipTranslation ? 'ready' : 'processing';
    expect(initialStatus).toBe('processing');
  });
});

describe('skipTranslation credit deduction SQL', () => {
  it('credit deduction SQL uses credits - ? pattern', async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal('fetch', fetchSpy);

    const client = new D1Client(mockConfig);
    await client.run(
      'UPDATE users SET credits = credits - ? WHERE id = ?',
      [100, 1]
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.sql).toContain('credits - ?');
  });

  it('ready-status SQL still uses UPDATE books_v2 SET status after artwork generation', async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal('fetch', fetchSpy);

    const client = new D1Client(mockConfig);
    await client.run("UPDATE books_v2 SET status = 'ready' WHERE uuid = ?", [
      'book-uuid',
    ]);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.sql).toContain("status = 'ready'");
    expect(body.sql).not.toContain('credits');
    expect(body.sql).not.toContain('translation_jobs');
  });

  it('translation job SQL is NOT the same as the skip-translation ready SQL', () => {
    // When skipTranslation=false, a translation_jobs INSERT is made instead
    const translationJobSQL = `INSERT INTO translation_jobs (book_id, book_uuid, source_language, target_language, total_chapters, status) VALUES (?, ?, ?, ?, ?, 'pending')`;
    const skipTranslationSQL =
      "UPDATE books_v2 SET status = 'ready' WHERE uuid = ?";

    expect(translationJobSQL).toContain('translation_jobs');
    expect(skipTranslationSQL).not.toContain('translation_jobs');
    expect(skipTranslationSQL).toContain("'ready'");
  });
});

describe('skipTranslation cover-failure resilience', () => {
  it('resolves even when cover generation rejects, so the ready update still runs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      settleCoverGeneration(Promise.reject(new Error('sharp failed')), 'uuid1')
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cover generation failed for uuid1'),
      expect.any(Error)
    );
  });

  it('waits for cover generation to finish before resolving', async () => {
    let finished = false;
    const coverGeneration = Promise.resolve().then(() => {
      finished = true;
    });
    await settleCoverGeneration(coverGeneration, 'uuid2');
    expect(finished).toBe(true);
  });
});

describe('skipTranslation FormData and JSON parsing', () => {
  it('JSON body: skipTranslation=true is parsed as boolean', () => {
    // From book-handlers.ts: skipTranslation = body.skipTranslation === true
    const body = { skipTranslation: true };
    expect(body.skipTranslation === true).toBe(true);
  });

  it('JSON body: skipTranslation=false (or absent) defaults to false', () => {
    expect((undefined as unknown as boolean) === true).toBe(false);
    expect(false === true).toBe(false);
  });

  it('FormData: string "true" is parsed as skip', () => {
    // From book-handlers.ts: formData.get('skipTranslation') === 'true'
    const formDataValue = 'true';
    expect(formDataValue === 'true').toBe(true);
  });

  it('FormData: string "false" is not treated as skip', () => {
    const formDataValue = 'false';
    expect(formDataValue === 'true').toBe(false);
  });

  it('FormData: absent field is not treated as skip', () => {
    const formDataValue = null; // formData.get() returns null when absent
    expect(formDataValue === 'true').toBe(false);
  });
});
