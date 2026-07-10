import { describe, it, expect } from 'vitest';
import {
  buildStaticPreamble,
  formatStyleGuide,
  translatorBatchSystem,
  translatorBatchUser,
  translatorSingleSystem,
  translatorSingleUser,
  translatorFixUser,
} from '../prompts.js';

const CTX = {
  styleGuideText: 'Tone: noir first-person',
  synopsisText: 'A detective story that ends with the butler.',
  glossaryStr: '**GLOSSARY (MUST use these exact translations):**\n  "Holmes" → "福尔摩斯"',
  digestText: 'Watson meets Holmes.',
};

describe('prompt cache discipline (wenyi #5)', () => {
  it('system prompts are static — no glossary or per-batch content', () => {
    const sys = translatorBatchSystem('en', 'Chinese');
    expect(sys).not.toContain('福尔摩斯');
    expect(sys).not.toContain('GLOSSARY (MUST');
    // Same book → byte-identical system prompt on every call
    expect(translatorBatchSystem('en', 'Chinese')).toBe(sys);
    expect(translatorSingleSystem('en', 'Chinese')).toBe(translatorSingleSystem('en', 'Chinese'));
  });

  it('user prompt is ordered static → dynamic (style → synopsis → glossary → digest → source)', () => {
    const user = translatorBatchUser(CTX, '<seg id="0">Hello</seg>');
    const idxStyle = user.indexOf('STYLE GUIDE');
    const idxSynopsis = user.indexOf('BOOK OVERVIEW');
    const idxGlossary = user.indexOf('GLOSSARY');
    const idxDigest = user.indexOf('CHAPTER SUMMARY');
    const idxSource = user.indexOf('<seg id="0">');
    expect(idxStyle).toBeGreaterThanOrEqual(0);
    expect(idxSynopsis).toBeGreaterThan(idxStyle);
    expect(idxGlossary).toBeGreaterThan(idxSynopsis);
    expect(idxDigest).toBeGreaterThan(idxGlossary);
    expect(idxSource).toBeGreaterThan(idxDigest);
  });

  it('batches in the same chapter share an identical prompt prefix', () => {
    const a = translatorBatchUser(CTX, '<seg id="0">First batch</seg>');
    const b = translatorBatchUser(CTX, '<seg id="7">Second batch</seg>');
    const prefix = buildStaticPreamble(CTX);
    expect(prefix.length).toBeGreaterThan(0);
    expect(a.startsWith(prefix)).toBe(true);
    expect(b.startsWith(prefix)).toBe(true);
  });

  it('empty context yields no preamble', () => {
    expect(buildStaticPreamble({})).toBe('');
    expect(translatorBatchUser({}, '<seg id="0">x</seg>')).toBe('<seg id="0">x</seg>');
  });

  it('single-text user prompt keeps context after static blocks, before source', () => {
    const user = translatorSingleUser(CTX, 'Hello', ['previous paragraph']);
    expect(user.indexOf('STYLE GUIDE')).toBeLessThan(user.indexOf('<context>'));
    expect(user.indexOf('<context>')).toBeLessThan(user.indexOf('<translate>'));
    expect(user).toContain('previous paragraph');
    expect(user).toContain('<translate>\nHello\n</translate>');
  });

  it('fix prompt includes feedback and flawed translation', () => {
    const user = translatorFixUser(CTX, 'Hello', '你好吗', 'missing: dropped greeting');
    expect(user).toContain('REVIEW FEEDBACK');
    expect(user).toContain('missing: dropped greeting');
    expect(user).toContain('你好吗');
    expect(user).toContain('<translate>\nHello\n</translate>');
  });
});

describe('formatStyleGuide', () => {
  it('renders fields, rules, and characters', () => {
    const text = formatStyleGuide({
      genre: 'mystery',
      tone: 'dry wit',
      narration: 'first person past',
      style_guide: ['keep sentences short'],
      characters: [
        { source: 'Holmes', target: '福尔摩斯', gender: 'male', note: 'terse' },
        { source: '' }, // dropped
      ],
    });
    expect(text).toContain('Genre: mystery');
    expect(text).toContain('- keep sentences short');
    expect(text).toContain('Holmes: 福尔摩斯; male; terse');
    expect(text).not.toContain('undefined');
  });
});
