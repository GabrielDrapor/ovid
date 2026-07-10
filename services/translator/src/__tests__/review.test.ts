import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviewPairs, fixTranslation, isPlausibleFix, SEVERE_ISSUE_TYPES } from '../review.js';

const config = { apiKey: 'k', baseURL: 'https://api.test.com/v1', model: 'cheap-model' };

function mockFetchJson(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

describe('reviewPairs', () => {
  beforeEach(() => vi.restoreAllMocks());

  const pairs = [
    { index: 0, source: 'Hello world.', translated: '你好。' },
    { index: 1, source: 'Goodbye.', translated: '再见。' },
  ];

  it('parses issues and keeps only valid indexes/shapes', async () => {
    vi.stubGlobal('fetch', mockFetchJson(JSON.stringify({
      issues: [
        { index: 0, type: 'missing', detail: 'dropped "world"', suggestion: '你好，世界。' },
        { index: 99, type: 'missing', detail: 'bogus index' },
        { index: 1, type: 42, detail: 'bad type shape' },
      ],
    })));
    const issues = await reviewPairs(config, pairs, '', 'en', 'zh');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ index: 0, type: 'missing' });
  });

  it('returns [] when a chunk fails instead of throwing', async () => {
    vi.stubGlobal('fetch', mockFetchJson('not json at all'));
    const issues = await reviewPairs(config, pairs, '', 'en', 'zh');
    expect(issues).toEqual([]);
  });

  it('chunks long inputs into multiple review calls', async () => {
    const fetchMock = mockFetchJson('{"issues":[]}');
    vi.stubGlobal('fetch', fetchMock);
    const many = Array.from({ length: 25 }, (_, i) => ({
      index: i, source: `Sentence ${i}.`, translated: `句子${i}。`,
    }));
    await reviewPairs(config, many, '', 'en', 'zh');
    expect(fetchMock.mock.calls.length).toBe(3); // 25 pairs / 10 per chunk
  });
});

describe('isPlausibleFix', () => {
  it('rejects empty, tag-leaking, and absurd-length fixes', () => {
    expect(isPlausibleFix('Hello world', '')).toBe(false);
    expect(isPlausibleFix('Hello world', '<seg id="0">你好</seg>')).toBe(false);
    expect(isPlausibleFix('Hello world', '<translate>你好</translate>')).toBe(false);
    expect(isPlausibleFix('Hello world', 'x'.repeat(200))).toBe(false);
    expect(isPlausibleFix('Hello world', '你好，世界。')).toBe(true);
  });
});

describe('fixTranslation', () => {
  beforeEach(() => vi.restoreAllMocks());

  const pair = { index: 0, source: 'Hello world.', translated: '你好。' };

  it('returns the retranslation when plausible', async () => {
    const fetchMock = mockFetchJson('你好，世界。');
    vi.stubGlobal('fetch', fetchMock);
    const fixed = await fixTranslation(config, {}, pair, 'missing: dropped "world"', 'en', 'zh');
    expect(fixed).toBe('你好，世界。');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[1].content).toContain('REVIEW FEEDBACK');
    expect(body.messages[1].content).toContain('dropped "world"');
  });

  it('returns null when the fix fails sanity checks', async () => {
    // Non-empty LLM response that strips down to nothing after tag removal
    vi.stubGlobal('fetch', mockFetchJson('<translate> </translate>'));
    const fixed = await fixTranslation(config, {}, pair, 'missing', 'en', 'zh');
    expect(fixed).toBeNull();
  });
});

describe('SEVERE_ISSUE_TYPES', () => {
  it('covers missing/added/mistranslation but not terminology/pronoun', () => {
    expect(SEVERE_ISSUE_TYPES.has('missing')).toBe(true);
    expect(SEVERE_ISSUE_TYPES.has('added')).toBe(true);
    expect(SEVERE_ISSUE_TYPES.has('mistranslation')).toBe(true);
    expect(SEVERE_ISSUE_TYPES.has('terminology')).toBe(false);
    expect(SEVERE_ISSUE_TYPES.has('pronoun')).toBe(false);
  });
});
