/**
 * Tests for EPUB TOC extraction (NCX and nav.xhtml parsing).
 */
import { describe, it, expect } from 'vitest';
import { buildTestEpub } from './helpers/epub-builder.js';
import { parseEPUB } from '../book-parser.js';

describe('EPUB TOC extraction', () => {
  describe('NCX parsing', () => {
    it('uses NCX titles instead of heading extraction', async () => {
      const epub = await buildTestEpub({
        chapters: [
          { title: 'PENGUIN BOOKS', paragraphs: ['Some front matter text here.'] },
          { title: 'Chapter 1', paragraphs: ['The story begins here.'] },
          { title: 'Chapter 2', paragraphs: ['The story continues.'] },
        ],
        ncxTitles: ['Front Matter', 'I. The Dawn', 'II. The Dusk'],
      });
      const book = await parseEPUB(epub);

      expect(book.chapters).toHaveLength(3);
      expect(book.chapters[0].title).toBe('Front Matter');
      expect(book.chapters[1].title).toBe('I. The Dawn');
      expect(book.chapters[2].title).toBe('II. The Dusk');
      expect(book.chapters[0].originalTitle).toBe('Front Matter');
    });

    it('handles fragment identifiers in NCX entries', async () => {
      const epub = await buildTestEpub({
        chapters: [
          { title: 'Raw Heading', paragraphs: ['First paragraph.'] },
          { title: 'Another Heading', paragraphs: ['Second paragraph.'] },
        ],
        ncxTitles: ['Part One', 'Part Two'],
        tocFragments: { 0: 'section1', 1: 'section2' },
      });
      const book = await parseEPUB(epub);

      expect(book.chapters).toHaveLength(2);
      expect(book.chapters[0].title).toBe('Part One');
      expect(book.chapters[1].title).toBe('Part Two');
    });
  });

  describe('nav.xhtml parsing', () => {
    it('uses nav.xhtml titles instead of heading extraction', async () => {
      const epub = await buildTestEpub({
        chapters: [
          { title: 'COPYRIGHT', paragraphs: ['Copyright notice here.'] },
          { title: 'ONE', paragraphs: ['Chapter one content.'] },
        ],
        navTitles: ['Copyright Page', 'Chapter 1: The Beginning'],
      });
      const book = await parseEPUB(epub);

      expect(book.chapters).toHaveLength(2);
      expect(book.chapters[0].title).toBe('Copyright Page');
      expect(book.chapters[1].title).toBe('Chapter 1: The Beginning');
    });

    it('prefers nav.xhtml over NCX when both exist', async () => {
      const epub = await buildTestEpub({
        chapters: [
          { title: 'Heading', paragraphs: ['Content here.'] },
        ],
        ncxTitles: ['NCX Title'],
        navTitles: ['Nav Title'],
      });
      const book = await parseEPUB(epub);

      expect(book.chapters).toHaveLength(1);
      expect(book.chapters[0].title).toBe('Nav Title');
    });

    it('handles fragment identifiers in nav entries', async () => {
      const epub = await buildTestEpub({
        chapters: [
          { title: 'H1 Heading', paragraphs: ['Some text.'] },
        ],
        navTitles: ['Prologue'],
        tocFragments: { 0: 'prologue-start' },
      });
      const book = await parseEPUB(epub);

      expect(book.chapters).toHaveLength(1);
      expect(book.chapters[0].title).toBe('Prologue');
    });
  });

  describe('fallback behavior', () => {
    it('falls back to heading extraction when no TOC file exists', async () => {
      const epub = await buildTestEpub({
        chapters: [
          { title: 'The Beginning', paragraphs: ['It was a dark night.'] },
          { title: 'The End', paragraphs: ['And so it ended.'] },
        ],
      });
      const book = await parseEPUB(epub);

      expect(book.chapters).toHaveLength(2);
      expect(book.chapters[0].title).toBe('The Beginning');
      expect(book.chapters[1].title).toBe('The End');
    });

    it('preserves chapter numbering and text nodes with TOC titles', async () => {
      const epub = await buildTestEpub({
        chapters: [
          { title: 'H1 Title', paragraphs: ['First paragraph.', 'Second paragraph.'] },
        ],
        ncxTitles: ['Proper Chapter Title'],
      });
      const book = await parseEPUB(epub);

      expect(book.chapters).toHaveLength(1);
      expect(book.chapters[0].number).toBe(1);
      expect(book.chapters[0].title).toBe('Proper Chapter Title');
      // h1 + 2 paragraphs = 3 text nodes
      expect(book.chapters[0].textNodes.length).toBe(3);
    });
  });
});
