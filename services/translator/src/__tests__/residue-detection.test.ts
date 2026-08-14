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

  describe('high-CJK residue (regression: prod misses reported 2026-08)', () => {
    // Real production output from "How to Win the Premier League": the
    // segment is ~89% CJK so the old detector skipped it entirely, and
    // the bare "simply" shipped to readers.
    it('flags a bare lowercase common word inside mostly-Chinese text', () => {
      const text =
        '他尤其喜欢对阵那些有明确、僵化哲学的主帅——这 simply 让他的战术任务更容易，正如他在 2014 年的一次采访中所概述的那样。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual(['simply']);
    });

    it('flags multiple bare leftovers (real Dracula segment)', () => {
      const text =
        '至少，他回答我的问题 exactly 像是听懂了。这 simply 说明还需 further 检查。';
      const residue = detectEnglishResidue(text, noGlossary);
      expect(residue).toContain('exactly');
      expect(residue).toContain('simply');
      expect(residue).toContain('further');
    });

    it('does not flag quoted English word discussions', () => {
      // Real Hound of the Baskervilles output: cut-out newspaper words
      const text =
        '因为剪切者在剪“keep away”这个词时不得不剪了两下，所以那是一把刃部很短的剪刀。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('does not flag bracketed glosses', () => {
      // Real archaeology-book output: 泰勒（tell）style gloss
      const text = '每当您看到这样一座泰勒（tell）或孤立土丘耸立于平原之上，您就可以确信下面有遗迹。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('does not flag proper nouns or pinyin in mostly-Chinese text', () => {
      const text = '正如 Hessler 在书中所写，Feng tong xing 一家搬到了涪陵。这段话完全没有问题。';
      expect(detectEnglishResidue(text, noGlossary)).toEqual([]);
    });

    it('does not flag glossary terms left in English', () => {
      const text = '这 simply 是一个测试。';
      // If the glossary maps "simply" (contrived), it is allowed
      expect(detectEnglishResidue(text, { simply: 'simply' })).toEqual([]);
    });
  });
});
