import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  compressBookTitleForSpine,
  sanitizeBookTitle,
  sanitizeBookTitleHeuristic,
} from '../title-sanitizer.js';

const llmConfig = {
  apiKey: 'test-key',
  baseURL: 'https://api.test.com/v1',
  model: 'test-model',
};

describe('sanitizeBookTitleHeuristic', () => {
  it('drops long trailing Chinese parenthetical catalog copy', () => {
    expect(
      sanitizeBookTitleHeuristic(
        '可能性的艺术：比较政治学30讲（学者刘瑜比较政治学新著，跳出现象，通过比较洞察政治，突破认知偏见，在浩瀚的可能性中理解我们自身 理想国出品）'
      )
    ).toBe('可能性的艺术：比较政治学30讲');
  });

  it('keeps the title before trailing recommendation blurbs', () => {
    expect(
      sanitizeBookTitleHeuristic(
        '那些活了很久很久的树（牛津大学文学教授的诗意博物之作，BBC人文科普专栏结集，北京大学教授、博物文化倡导者刘华杰推荐）'
      )
    ).toBe('那些活了很久很久的树');
  });

  it('drops English parenthetical descriptors', () => {
    expect(sanitizeBookTitleHeuristic('The Example Book (A Novel)')).toBe(
      'The Example Book'
    );
  });

  it('preserves slash-delimited subtitles', () => {
    expect(
      sanitizeBookTitleHeuristic('阿卡迪亚 / 与蓝鼻族共度的一个月（典藏版）')
    ).toBe('阿卡迪亚 / 与蓝鼻族共度的一个月');
  });

  it('unwraps leading Chinese title marks before slash subtitles', () => {
    expect(
      sanitizeBookTitleHeuristic(
        '《细菌学技术要素》/ 医学、牙科及技术专业学生实验指南。第二版，全面修订增补版。'
      )
    ).toBe('细菌学技术要素 / 医学、牙科及技术专业学生实验指南');
  });

  it('drops English edition sentences', () => {
    expect(
      sanitizeBookTitleHeuristic(
        'The Elements of Bacteriological Technique / A Laboratory Guide for Medical, Dental, and Technical Students. Second Edition Rewritten and Enlarged.'
      )
    ).toBe(
      'The Elements of Bacteriological Technique / A Laboratory Guide for Medical, Dental, and Technical Students'
    );
  });

  it('unwraps Chinese book title marks', () => {
    expect(sanitizeBookTitleHeuristic('《自动钢琴》')).toBe('自动钢琴');
  });
});

describe('sanitizeBookTitle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses a valid LLM JSON title when available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { content: '{"title":"可能性的艺术：比较政治学30讲"}' },
            },
          ],
        }),
      })
    );

    await expect(
      sanitizeBookTitle(
        '可能性的艺术：比较政治学30讲（学者刘瑜比较政治学新著，理想国出品）',
        llmConfig
      )
    ).resolves.toBe('可能性的艺术：比较政治学30讲');
  });

  it('rejects LLM titles that drop colon subtitles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"title":"可能性的艺术"}' } }],
        }),
      })
    );

    await expect(
      sanitizeBookTitle(
        '可能性的艺术：比较政治学30讲（学者刘瑜比较政治学新著，理想国出品）',
        llmConfig
      )
    ).resolves.toBe('可能性的艺术：比较政治学30讲');
  });

  it('falls back to the deterministic sanitizer when the LLM fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(
      sanitizeBookTitle('The Example Book (Illustrated Edition)', llmConfig)
    ).resolves.toBe('The Example Book');
  });

  it('rejects translated LLM titles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"title":"无穷的开始"}' } }],
        }),
      })
    );

    await expect(
      sanitizeBookTitle('The Beginning of Infinity', llmConfig)
    ).resolves.toBe('The Beginning of Infinity');
  });
});

describe('compressBookTitleForSpine', () => {
  it('uses the main title before a colon subtitle', () => {
    expect(compressBookTitleForSpine('可能性的艺术：比较政治学30讲')).toBe(
      '可能性的艺术'
    );
  });

  it('uses the main title before a slash subtitle', () => {
    expect(compressBookTitleForSpine('阿卡迪亚 / 与蓝鼻族共度的一个月')).toBe(
      '阿卡迪亚'
    );
  });

  it('drops Gutenberg-style comma subtitle clauses on the spine', () => {
    expect(
      compressBookTitleForSpine(
        "Bidwell's Travels, from Wall Street to London Prison: Fifteen Years in Solitude"
      )
    ).toBe("Bidwell's Travels");
  });

  it('compresses long generic elements titles on the spine', () => {
    expect(
      compressBookTitleForSpine(
        'The Elements of Bacteriological Technique / A Laboratory Guide for Medical, Dental, and Technical Students'
      )
    ).toBe('Bacteriological Technique');
  });

  it('leaves titles without subtitle separators alone', () => {
    expect(compressBookTitleForSpine('The Beginning of Infinity')).toBe(
      'The Beginning of Infinity'
    );
  });
});
