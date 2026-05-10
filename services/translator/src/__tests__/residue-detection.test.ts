import { describe, it, expect } from 'vitest';
import { detectEnglishResidue } from '../translate-worker.js';

const noGlossary = {} as Record<string, string>;

describe('detectEnglishResidue', () => {
  describe('false positives that previously caused retry storms', () => {
    it('ignores bare domains in citation segments', () => {
      const text = '参见出版社官网（penguinrandomhouse.com）。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('ignores domains with paths (e.g. nytimes.com/world/asia/...)', () => {
      const text =
        '据《纽约时报》报道（https://www.nytimes.com/world/asia/student/informers），事件发生于上周。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('ignores multi-dot government domains with .shtml paths', () => {
      const text = '资料来源：cdwjw.gov.cn/cdwjw/content/eccec/bbc.shtml';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('ignores subdomain-heavy academic URLs', () => {
      const text =
        '研究链接：engineering.pitt.edu 与 ncbi.nlm.nih.gov/pmc/articles。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('ignores email addresses', () => {
      const text = '联系作者：peter.hessler@example.com 进一步讨论。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('treats Title Case proper noun lists as accepted', () => {
      // The acknowledgments-page case from chapter 19.
      const text =
        '感谢 Zoey, Euphy, Alex, Sun, Jingjing, Wang, Gavin 的帮助。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('treats pinyin transliteration runs as accepted', () => {
      // Title-Case head ("Feng") followed by short lowercase pinyin syllables.
      const text = '风通行点（Feng tong xing dian）的研究表明……';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('treats publisher names like "Rupa Publications India Pvt Ltd" as accepted', () => {
      const text = '出版社：Rupa Publications India Pvt Ltd，发行于印度。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });
  });

  describe('true positives — real prose residue', () => {
    it('still flags lowercase content words mixed with CJK', () => {
      const text = '这是 the dog ran very fast across the field.';
      const residue = detectEnglishResidue(text, noGlossary);
      expect(residue).toContain('dog');
      expect(residue).toContain('ran');
      expect(residue).toContain('fast');
      expect(residue).toContain('across');
      expect(residue).toContain('field');
    });

    it('still flags untranslated English when no CJK is present at all', () => {
      const text = 'The dog ran fast across the field.';
      const residue = detectEnglishResidue(text, noGlossary);
      expect(residue.length).toBeGreaterThan(0);
    });
  });

  describe('clean translations', () => {
    it('returns empty for fully Chinese text', () => {
      expect(
        detectEnglishResidue('这是一段完全翻译好的中文。', noGlossary)
      ).toEqual([]);
    });

    it('returns empty when residue is just acronyms', () => {
      expect(
        detectEnglishResidue('GDP 增长率达到 NBA 比赛水平。', noGlossary)
      ).toEqual([]);
    });
  });
});
