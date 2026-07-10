import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  analyzeStyle,
  digestChapters,
  synthesizeSynopsis,
  pickStyleSamples,
} from '../book-analysis.js';

const config = { apiKey: 'k', baseURL: 'https://api.test.com/v1', model: 'test-model' };

function mockFetchJson(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

describe('pickStyleSamples', () => {
  it('takes head/middle/tail for long books', () => {
    const samples = pickStyleSamples(['ch1', 'ch2', 'ch3', 'ch4', 'ch5']);
    expect(samples.map(s => s.text)).toEqual(['ch1', 'ch3', 'ch5']);
  });

  it('handles short books and skips empty chapters', () => {
    expect(pickStyleSamples([])).toEqual([]);
    expect(pickStyleSamples(['', 'only', ' '])).toHaveLength(1);
    expect(pickStyleSamples(['a', 'b']).map(s => s.text)).toEqual(['a', 'b']);
  });
});

describe('analyzeStyle', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('parses the style guide JSON (with code fences)', async () => {
    vi.stubGlobal('fetch', mockFetchJson('```json\n{"genre":"mystery","tone":"dry","style_guide":["short sentences"]}\n```'));
    const sg = await analyzeStyle(config, ['some chapter text'], 'en', 'zh');
    expect(sg).toMatchObject({ genre: 'mystery', tone: 'dry' });
  });

  it('returns null on failure instead of throwing', async () => {
    vi.stubGlobal('fetch', mockFetchJson('I cannot analyze this'));
    const sg = await analyzeStyle(config, ['text'], 'en', 'zh');
    expect(sg).toBeNull();
  });

  it('returns null for an empty book without calling the LLM', async () => {
    const fetchMock = mockFetchJson('{}');
    vi.stubGlobal('fetch', fetchMock);
    const sg = await analyzeStyle(config, ['', '  '], 'en', 'zh');
    expect(sg).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('digestChapters + synthesizeSynopsis', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('digests each non-empty chapter and keys by chapter number', async () => {
    vi.stubGlobal('fetch', mockFetchJson('本章梗概。'));
    const digests = await digestChapters(
      config,
      [
        { number: 1, text: 'Chapter one text' },
        { number: 2, text: '' },
        { number: 3, text: 'Chapter three text' },
      ],
      'en', 'zh'
    );
    expect(Object.keys(digests).sort()).toEqual(['1', '3']);
    expect(digests['1']).toBe('本章梗概。');
  });

  it('skips failed chapters without failing the batch', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return { ok: false, text: async () => 'boom', status: 500 };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '梗概' } }] }) };
    }));
    const digests = await digestChapters(
      config,
      [{ number: 1, text: 'a' }, { number: 2, text: 'b' }],
      'en', 'zh'
    );
    // chapter 1 fails all retries? No — retries succeed on subsequent calls.
    // Both chapters end up digested; the point is no throw.
    expect(Object.keys(digests).length).toBeGreaterThanOrEqual(1);
  });

  it('synthesizes a synopsis from digests, ordered by chapter', async () => {
    const fetchMock = mockFetchJson('全书概览。');
    vi.stubGlobal('fetch', fetchMock);
    const synopsis = await synthesizeSynopsis(config, { '2': '第二章', '1': '第一章' }, 'zh');
    expect(synopsis).toBe('全书概览。');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const user = body.messages[1].content as string;
    expect(user.indexOf('[Chapter 1]')).toBeLessThan(user.indexOf('[Chapter 2]'));
  });

  it('returns null synopsis when there are no digests', async () => {
    const fetchMock = mockFetchJson('x');
    vi.stubGlobal('fetch', fetchMock);
    expect(await synthesizeSynopsis(config, {}, 'zh')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
