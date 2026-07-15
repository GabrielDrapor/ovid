/**
 * TOC-driven chapter extraction: when the EPUB has a usable table of
 * contents, the chapter list follows it — split-file continuations inherit
 * the preceding entry's title, publisher filler outside the TOC's range is
 * dropped, front/back-matter files get role names instead of "Chapter N",
 * and prose/dialogue never becomes a derived title.
 */
import { describe, it, expect } from 'vitest';
import { parseEPUB } from '../book-parser';
import { buildTestEpub, RawTestFile } from './helpers/epub-builder';

const longText = (label: string) =>
  Array.from(
    { length: 20 },
    (_, i) =>
      `<p>${label} paragraph ${i + 1}: a sufficiently long line of narrative content to make this file count as substantial body text for the split-continuation heuristic.</p>`
  ).join('\n');

describe('TOC-driven chapter titles', () => {
  it('split-chapter continuation files inherit the preceding TOC title', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          { fileName: 'part1.xhtml', bodyHtml: longText('One') },
          { fileName: 'part1b.xhtml', bodyHtml: longText('One-continued') },
          { fileName: 'part2.xhtml', bodyHtml: longText('Two') },
        ],
        ncxEntries: [
          { src: 'part1.xhtml', title: '第一章 命案' },
          { src: 'part2.xhtml', title: '第二章 蜗牛' },
        ],
      })
    );
    expect(book.chapters.map((c) => c.title)).toEqual([
      '第一章 命案',
      '第一章 命案',
      '第二章 蜗牛',
    ]);
  });

  it('continuation files after the LAST TOC entry inherit its title', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          { fileName: 'part1.xhtml', bodyHtml: longText('One') },
          { fileName: 'part2.xhtml', bodyHtml: longText('Two') },
          { fileName: 'part2b.xhtml', bodyHtml: longText('Two-continued') },
        ],
        ncxEntries: [
          { src: 'part1.xhtml', title: 'First' },
          { src: 'part2.xhtml', title: 'Last Chapter' },
        ],
      })
    );
    expect(book.chapters.map((c) => c.title)).toEqual([
      'First',
      'Last Chapter',
      'Last Chapter',
    ]);
  });

  it('drops tiny text-only filler outside the TOC range, keeps numbering contiguous', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          {
            fileName: 'ad-front.xhtml',
            bodyHtml: '<p>如果你不知道读什么书，就关注这个微信号。</p>',
          },
          { fileName: 'ch1.xhtml', bodyHtml: longText('One') },
          { fileName: 'ch2.xhtml', bodyHtml: longText('Two') },
          {
            fileName: 'ad-back.xhtml',
            bodyHtml: '<p>更多好书请关注公众号：幸福的味道。</p>',
          },
        ],
        ncxEntries: [
          { src: 'ch1.xhtml', title: 'Chapter the First' },
          { src: 'ch2.xhtml', title: 'Chapter the Second' },
        ],
      })
    );
    expect(book.chapters.map((c) => [c.number, c.title])).toEqual([
      [1, 'Chapter the First'],
      [2, 'Chapter the Second'],
    ]);
  });

  it('keeps image pages outside the TOC range (covers, title art)', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          {
            fileName: 'titlepage.xhtml',
            bodyHtml: '<p><img src="images/test.png" alt=""/> My Book</p>',
          },
          { fileName: 'ch1.xhtml', bodyHtml: longText('One') },
          { fileName: 'ch2.xhtml', bodyHtml: longText('Two') },
        ],
        ncxEntries: [
          { src: 'ch1.xhtml', title: 'First' },
          { src: 'ch2.xhtml', title: 'Second' },
        ],
        includeImage: true,
      })
    );
    expect(book.chapters.map((c) => c.title)).toEqual([
      'Title Page',
      'First',
      'Second',
    ]);
  });

  it('small in-range pages (part dividers) keep their derived titles', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          { fileName: 'ch1.xhtml', bodyHtml: longText('One') },
          { fileName: 'divider.xhtml', bodyHtml: '<p>第二部</p>' },
          { fileName: 'ch2.xhtml', bodyHtml: longText('Two') },
        ],
        ncxEntries: [
          { src: 'ch1.xhtml', title: 'First' },
          { src: 'ch2.xhtml', title: 'Second' },
        ],
      })
    );
    expect(book.chapters.map((c) => c.title)).toEqual([
      'First',
      '第二部',
      'Second',
    ]);
  });

  it('resolves TOC srcs with ./ prefixes and URL encoding', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          { fileName: 'chapter 1.xhtml', bodyHtml: longText('One') },
          { fileName: 'chapter2.xhtml', bodyHtml: longText('Two') },
        ],
        ncxEntries: [
          { src: './chapter%201.xhtml', title: 'Encoded Path Title' },
          { src: './chapter2.xhtml#middle', title: 'Fragment Title' },
        ],
      })
    );
    expect(book.chapters.map((c) => c.title)).toEqual([
      'Encoded Path Title',
      'Fragment Title',
    ]);
  });
});

describe('front/back-matter and fallback titles', () => {
  it('skips linear="no" spine items entirely', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          {
            fileName: 'aux.xhtml',
            bodyHtml: '<p>Auxiliary content not in the reading order.</p>',
            nonLinear: true,
          },
          { fileName: 'ch1.xhtml', bodyHtml: longText('One') },
        ],
      })
    );
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].rawHtml).toContain('One paragraph 1');
  });

  it('uses OPF guide roles for headingless matter pages', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          {
            fileName: 'page01.xhtml',
            bodyHtml:
              '<p>All rights reserved. No part of this publication may be reproduced without permission of the publisher, and so on and so forth at some length.</p>',
          },
          { fileName: 'ch1.xhtml', bodyHtml: longText('One') },
        ],
        guide: [{ type: 'copyright-page', href: 'page01.xhtml' }],
      })
    );
    expect(book.chapters[0].title).toBe('Copyright');
  });

  it('uses filename roles when there is no guide', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          {
            fileName: 'acknowledgments.xhtml',
            bodyHtml:
              '<p>The author would like to thank a very long list of people whose contributions made this book possible over many years of writing.</p>',
          },
          { fileName: 'ch1.xhtml', bodyHtml: longText('One') },
        ],
      })
    );
    expect(book.chapters[0].title).toBe('Acknowledgments');
  });

  it('never glues dialogue lines into a derived title', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          {
            fileName: 'page05.xhtml',
            bodyHtml: `
  <p>“啊，太好了。真细致。”今西很满意。</p>
  <p>“请把具体长相再讲一下。”</p>
  ${longText('Body')}`,
          },
        ],
      })
    );
    expect(book.chapters[0].title).toBe('Chapter 1');
  });

  it('still derives titles from genuine heading-like short blocks', async () => {
    const book = await parseEPUB(
      await buildTestEpub({
        rawFiles: [
          {
            fileName: 'page05.xhtml',
            bodyHtml: `
  <p>OTHER RIVERS</p>
  <p>A Chinese Education</p>
  ${longText('Body')}`,
          },
        ],
      })
    );
    expect(book.chapters[0].title).toBe('OTHER RIVERS – A Chinese Education');
  });
});
