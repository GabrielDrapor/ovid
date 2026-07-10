import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeGlossary, extractIncrementalGlossary } from '../glossary.js';
import { tierConfig } from '../llm-client.js';

const config = {
  apiKey: 'k',
  baseURL: 'https://api.test.com/v1',
  model: 'strong-model',
  fastModel: 'fast-model',
  cheapModel: 'cheap-model',
};

function mockFetchJson(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

describe('mergeGlossary', () => {
  it('existing entries win on conflict (first rendering is canonical)', () => {
    const { merged, added } = mergeGlossary(
      { Holmes: '福尔摩斯' },
      { Holmes: '霍姆斯', Watson: '华生' }
    );
    expect(merged).toEqual({ Holmes: '福尔摩斯', Watson: '华生' });
    expect(added).toEqual(['Watson']);
  });

  it('is case-insensitive on keys and skips empty/oversized entries', () => {
    const { merged, added } = mergeGlossary(
      { holmes: '福尔摩斯' },
      { Holmes: '霍姆斯', '': 'x', Long: 'y'.repeat(100), ' Trim ': '修剪' }
    );
    expect(added).toEqual(['Trim']);
    expect(merged['Trim']).toBe('修剪');
    expect(Object.keys(merged)).toHaveLength(2);
  });
});

describe('extractIncrementalGlossary', () => {
  beforeEach(() => vi.restoreAllMocks());

  const pairs = [{ source: 'Irene Adler smiled.', translated: '艾琳·艾德勒笑了。' }];

  it('parses a flat JSON map and uses the fast tier model', async () => {
    const fetchMock = mockFetchJson('{"Irene Adler": "艾琳·艾德勒"}');
    vi.stubGlobal('fetch', fetchMock);
    const result = await extractIncrementalGlossary(
      tierConfig(config, 'fast'), pairs, {}, 'en', 'zh'
    );
    expect(result).toEqual({ 'Irene Adler': '艾琳·艾德勒' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('fast-model');
  });

  it('tolerates {"terms": {...}} wrappers and code fences', async () => {
    vi.stubGlobal('fetch', mockFetchJson('```json\n{"terms": {"Adler": "艾德勒"}}\n```'));
    const result = await extractIncrementalGlossary(config, pairs, {}, 'en', 'zh');
    expect(result).toEqual({ Adler: '艾德勒' });
  });

  it('returns {} on unparseable output instead of throwing', async () => {
    vi.stubGlobal('fetch', mockFetchJson('sorry, no terms found'));
    const result = await extractIncrementalGlossary(config, pairs, {}, 'en', 'zh');
    expect(result).toEqual({});
  });

  it('returns {} without calling the LLM when there are no pairs', async () => {
    const fetchMock = mockFetchJson('{}');
    vi.stubGlobal('fetch', fetchMock);
    const result = await extractIncrementalGlossary(config, [], {}, 'en', 'zh');
    expect(result).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tierConfig fallback (wenyi tiers: fast → cheap → strong)', () => {
  it('resolves each tier to its model', () => {
    expect(tierConfig(config, 'strong').model).toBe('strong-model');
    expect(tierConfig(config, 'cheap').model).toBe('cheap-model');
    expect(tierConfig(config, 'fast').model).toBe('fast-model');
  });

  it('falls back when tiers are missing', () => {
    const only = { apiKey: 'k', baseURL: 'b', model: 'm' };
    expect(tierConfig(only, 'fast').model).toBe('m');
    expect(tierConfig(only, 'cheap').model).toBe('m');
    const withCheap = { ...only, cheapModel: 'c' };
    expect(tierConfig(withCheap, 'fast').model).toBe('c');
  });
});
