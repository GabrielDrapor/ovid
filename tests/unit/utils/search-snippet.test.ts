import { describe, it, expect } from 'vitest';
import {
  buildSnippet,
  escapeLikePattern,
} from '../../../src/utils/search-snippet';

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards and backslashes', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('foo_bar')).toBe('foo\\_bar');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves normal text untouched', () => {
    expect(escapeLikePattern('福尔摩斯')).toBe('福尔摩斯');
    expect(escapeLikePattern('Sherlock Holmes')).toBe('Sherlock Holmes');
  });
});

describe('buildSnippet', () => {
  it('returns null when the text does not contain the query', () => {
    expect(buildSnippet('hello world', 'xyz')).toBeNull();
    expect(buildSnippet('', 'a')).toBeNull();
    expect(buildSnippet('text', '')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(buildSnippet('Sherlock Holmes', 'sherlock')).toBe('Sherlock Holmes');
  });

  it('returns the whole text when it fits within the radius', () => {
    expect(buildSnippet('短句子', '句')).toBe('短句子');
  });

  it('adds leading/trailing ellipses when truncating', () => {
    const text = 'a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100);
    const snippet = buildSnippet(text, 'needle', 10)!;
    expect(snippet).toBe(
      '…' + 'a'.repeat(10) + 'NEEDLE' + 'b'.repeat(10) + '…'
    );
  });

  it('omits the leading ellipsis for matches near the start', () => {
    const text = 'NEEDLE' + 'b'.repeat(100);
    const snippet = buildSnippet(text, 'needle', 10)!;
    expect(snippet.startsWith('NEEDLE')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('omits the trailing ellipsis for matches near the end', () => {
    const text = 'a'.repeat(100) + 'NEEDLE';
    const snippet = buildSnippet(text, 'needle', 10)!;
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('NEEDLE')).toBe(true);
  });

  it('keeps CJK context around a CJK match', () => {
    const text = '我获得伦敦大学医学博士学位，随后前往军医学校。'.repeat(5);
    const snippet = buildSnippet(text, '博士', 8)!;
    expect(snippet).toContain('博士');
    expect(snippet.length).toBeLessThanOrEqual(2 + 8 * 2 + 2);
  });
});
