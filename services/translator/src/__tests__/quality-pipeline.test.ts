import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  translateBook,
  activeJobs,
  resolveFeaturesFromEnv,
  ALL_FEATURES_OFF,
} from '../translate-worker.js';
import type { D1Client } from '../d1-client.js';

const llmConfig = {
  apiKey: 'test-key',
  baseURL: 'https://api.test.com/v1',
  model: 'strong-model',
  fastModel: 'fast-model',
  cheapModel: 'cheap-model',
};

const ALL_FEATURES_ON = {
  styleGuide: true,
  bookContext: true,
  incrementalGlossary: true,
  reviewPass: true,
  autofixSevere: true,
};

const textNodes = [
  { xpath: '/p[1]', text: 'Hello world, said Irene.', html: '<p>Hello world, said Irene.</p>', orderIndex: 0 },
  { xpath: '/p[2]', text: 'Goodbye then.', html: '<p>Goodbye then.</p>', orderIndex: 1 },
];

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
    book_context_json: null,
    review_summary_json: null,
    ...overrides,
  };
}

function makeMockDb() {
  return {
    first: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('translation_jobs')) return makeJob();
      if (sql.includes('text_nodes_json')) return { text_nodes_json: JSON.stringify(textNodes) };
      if (sql.includes('FROM books_v2')) return { original_title: 'My Book' };
      if (sql.includes('original_title')) return { original_title: 'Chapter One' };
      if (sql.includes('chapters_v2')) return { id: 55 };
      return null;
    }),
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ results: [], success: true }),
    batchInsert: vi.fn().mockResolvedValue(undefined),
  } as unknown as D1Client;
}

/**
 * Dispatching LLM mock: routes by prompt content markers so every phase of
 * the quality pipeline gets a plausible response. Records calls for
 * assertions.
 */
function installDispatchingLlm() {
  const calls: Array<{ model: string; system: string; user: string }> = [];
  const respond = (content: string) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });

  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const system: string = body.messages[0].content;
    const user: string = body.messages[1].content;
    calls.push({ model: body.model, system, user });

    if (system.includes('pre-translation analyst')) {
      return respond(JSON.stringify({
        genre: 'mystery', tone: 'dry', narration: 'first person',
        style_guide: ['keep it terse'],
        characters: [{ source: 'Irene', target: '艾琳', gender: 'female', note: 'witty' }],
      }));
    }
    if (system.includes('summarize novel chapters')) return respond('第一章：初次见面。');
    if (system.includes('book overview')) return respond('这是一部侦探小说的全书概览。');
    if (system.includes('proper noun extraction')) return respond('{"Irene": "艾琳"}');
    if (system.includes('proper-noun glossary')) return respond('{"Briony Lodge": "布里奥尼府"}');
    if (system.includes('strict translation reviewer')) {
      return respond(JSON.stringify({
        issues: [{ index: 1, type: 'missing', detail: 'dropped "then"', suggestion: '那么，再见了。' }],
      }));
    }
    if (user.includes('REVIEW FEEDBACK')) return respond('那么，再见了。');
    if (user.includes('<seg id=')) {
      // Echo back tagged translations for every segment in the batch
      const ids = [...user.matchAll(/<seg id="(\d+)">/g)].map(m => m[1]);
      return respond(ids.map(id => `<seg id="${id}">中文译文${id}。</seg>`).join('\n'));
    }
    if (user.includes('<translate>')) return respond('中文标题');
    return respond('中文默认。');
  }));
  return calls;
}

describe('quality pipeline integration (features on)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    activeJobs.clear();
  });

  it('runs prescan → glossary → translate → incremental glossary → review → autofix', async () => {
    const calls = installDispatchingLlm();
    const db = makeMockDb();

    await translateBook(db, llmConfig, 'test-uuid', ALL_FEATURES_ON);

    // Phase 0: book context persisted
    const runCalls = (db.run as any).mock.calls;
    const contextUpdate = runCalls.find((c: any[]) => c[0].includes('book_context_json'));
    expect(contextUpdate).toBeDefined();
    const savedContext = JSON.parse(contextUpdate[1][0]);
    expect(savedContext.styleGuide.genre).toBe('mystery');
    expect(savedContext.synopsis).toContain('全书概览');
    expect(savedContext.digests['1']).toContain('第一章');

    // Batch translation: system static (no glossary), user carries all static blocks
    const batchCall = calls.find(c => c.user.includes('<seg id="0">'));
    expect(batchCall).toBeDefined();
    expect(batchCall!.system).not.toContain('GLOSSARY (MUST');
    expect(batchCall!.system).not.toContain('艾琳');
    expect(batchCall!.user).toContain('STYLE GUIDE');
    expect(batchCall!.user).toContain('BOOK OVERVIEW');
    expect(batchCall!.user).toContain('GLOSSARY (MUST');
    expect(batchCall!.user).toContain('"Irene" → "艾琳"');
    expect(batchCall!.user).toContain('CHAPTER SUMMARY');
    expect(batchCall!.model).toBe('strong-model');

    // Model tiers: digests on fast, review on cheap
    const digestCall = calls.find(c => c.system.includes('summarize novel chapters'));
    expect(digestCall!.model).toBe('fast-model');
    const reviewCall = calls.find(c => c.system.includes('strict translation reviewer'));
    expect(reviewCall!.model).toBe('cheap-model');
    const incrementalCall = calls.find(c => c.system.includes('proper-noun glossary'));
    expect(incrementalCall!.model).toBe('fast-model');

    // Incremental glossary merged and persisted
    const glossaryUpdates = runCalls.filter((c: any[]) =>
      c[0].includes('SET glossary_json') && c[1]?.[0]?.includes('Briony Lodge'));
    expect(glossaryUpdates.length).toBeGreaterThan(0);

    // Review autofix: severe issue on segment 1 → translations_v2 row updated
    const fixUpdate = runCalls.find((c: any[]) =>
      c[0].includes('UPDATE translations_v2 SET translated_text'));
    expect(fixUpdate).toBeDefined();
    expect(fixUpdate[1]).toEqual(['那么，再见了。', 55, '/p[2]', 1]);

    // Review summary persisted
    const summaryUpdate = runCalls.find((c: any[]) => c[0].includes('review_summary_json'));
    expect(summaryUpdate).toBeDefined();
    expect(JSON.parse(summaryUpdate[1][0])['1']).toEqual({ issues: 1, fixed: 1 });

    // Job completes
    const completed = runCalls.find((c: any[]) => c[0].includes("status = 'completed'"));
    expect(completed).toBeDefined();
    expect(activeJobs.has('test-uuid')).toBe(false);
  });

  it('with features off, no prescan/review calls are made (baseline behavior)', async () => {
    const calls = installDispatchingLlm();
    const db = makeMockDb();

    await translateBook(db, llmConfig, 'test-uuid', { ...ALL_FEATURES_OFF });

    expect(calls.some(c => c.system.includes('pre-translation analyst'))).toBe(false);
    expect(calls.some(c => c.system.includes('summarize novel chapters'))).toBe(false);
    expect(calls.some(c => c.system.includes('strict translation reviewer'))).toBe(false);
    expect(calls.some(c => c.system.includes('proper-noun glossary'))).toBe(false);
    // Baseline still extracts the initial glossary and translates
    expect(calls.some(c => c.system.includes('proper noun extraction'))).toBe(true);
    expect(calls.some(c => c.user.includes('<seg id="0">'))).toBe(true);

    const runCalls = (db.run as any).mock.calls;
    expect(runCalls.some((c: any[]) => c[0].includes('book_context_json'))).toBe(false);
    expect(runCalls.some((c: any[]) => c[0].includes('review_summary_json'))).toBe(false);
  });
});

describe('resolveFeaturesFromEnv', () => {
  it('defaults everything on', () => {
    expect(resolveFeaturesFromEnv({})).toEqual({
      styleGuide: true,
      bookContext: true,
      incrementalGlossary: true,
      reviewPass: true,
      autofixSevere: true,
    });
  });

  it('TRANSLATOR_FEATURES=off disables everything', () => {
    expect(resolveFeaturesFromEnv({ TRANSLATOR_FEATURES: 'off' })).toEqual(ALL_FEATURES_OFF);
  });

  it('individual flags disable individual features', () => {
    const f = resolveFeaturesFromEnv({ FEATURE_REVIEW_PASS: '0', FEATURE_STYLE_GUIDE: 'false' });
    expect(f.reviewPass).toBe(false);
    expect(f.styleGuide).toBe(false);
    expect(f.bookContext).toBe(true);
  });
});
