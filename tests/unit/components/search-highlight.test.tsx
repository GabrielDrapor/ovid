import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHighlightedSnippet } from '../../../src/components/BilingualReaderV2';

const marks = (nodes: React.ReactNode[]) =>
  nodes.filter(
    (n) => React.isValidElement(n) && n.type === 'mark'
  ) as React.ReactElement[];

describe('renderHighlightedSnippet', () => {
  it('wraps each occurrence in <mark>', () => {
    const nodes = renderHighlightedSnippet('the cat and the dog', 'the');
    expect(marks(nodes)).toHaveLength(2);
  });

  it('is case-insensitive but preserves the original casing', () => {
    const nodes = renderHighlightedSnippet('Sherlock and sherlock', 'SHERLOCK');
    const ms = marks(nodes);
    expect(ms).toHaveLength(2);
    expect(ms[0].props.children).toBe('Sherlock');
    expect(ms[1].props.children).toBe('sherlock');
  });

  it('returns the plain snippet when the query is empty or absent', () => {
    expect(renderHighlightedSnippet('plain text', '')).toEqual(['plain text']);
    const nodes = renderHighlightedSnippet('plain text', 'zzz');
    expect(marks(nodes)).toHaveLength(0);
    expect(nodes.join('')).toBe('plain text');
  });

  it('handles CJK queries', () => {
    const nodes = renderHighlightedSnippet('夏洛克·福尔摩斯先生', '福尔摩斯');
    expect(marks(nodes)).toHaveLength(1);
  });
});
