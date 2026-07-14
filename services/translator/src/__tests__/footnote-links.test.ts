/**
 * Internal-link & footnote handling in the EPUB parser.
 *
 * Covers the main footnote shapes found in the wild:
 *   1. EPUB3 semantic noteref + <aside epub:type="footnote"> (same file)
 *   2. Separate endnotes file with numbered entries + backlinks (Calibre)
 *   3. Same-file anchor pairs (Project Gutenberg style)
 *   4. Plain cross-references (not notes — jump only)
 * Plus: unresolvable/external link policy, anchor preservation, label
 * stripping from translation text, and XPath stability.
 */
import { describe, it, expect } from 'vitest';
import { parseEPUB } from '../book-parser';
import { buildTestEpub } from './helpers/epub-builder';

describe('EPUB3 noteref + aside footnote (same file)', () => {
  const build = () =>
    buildTestEpub({
      rawFiles: [
        {
          fileName: 'chapter1.xhtml',
          bodyHtml: `
  <h1>Chapter One</h1>
  <p>The riots began in the spring<a epub:type="noteref" href="#fn1"><sup>1</sup></a> and lasted a month.</p>
  <p>A second paragraph without notes.</p>
  <aside epub:type="footnote" id="fn1">1. According to the provincial archives.</aside>`,
        },
      ],
    });

  it('rewrites the noteref to a resolved note link', async () => {
    const book = await parseEPUB(await build());
    expect(book.chapters).toHaveLength(1);
    const raw = book.chapters[0].rawHtml;

    expect(raw).toContain('data-ov-note="1"');
    expect(raw).toContain('data-ov-chapter="1"');
    expect(raw).toContain('data-ov-xpath="/body[1]/aside[1]"');
    // href removed so nothing tries real navigation
    expect(raw).not.toMatch(/<a[^>]*href="#fn1"/);
  });

  it('hides the aside from the flow but extracts its text for translation', async () => {
    const book = await parseEPUB(await build());
    const ch = book.chapters[0];

    expect(ch.rawHtml).toMatch(/<aside[^>]*data-ov-hidden="note"/);
    const asideNode = ch.textNodes.find((n) => n.xpath === '/body[1]/aside[1]');
    expect(asideNode).toBeDefined();
    expect(asideNode!.text).toContain('provincial archives');
  });

  it('strips the note label from translation text but keeps it in html', async () => {
    const book = await parseEPUB(await build());
    const para = book.chapters[0].textNodes.find(
      (n) => n.xpath === '/body[1]/p[1]'
    );
    expect(para).toBeDefined();
    expect(para!.text).toBe(
      'The riots began in the spring and lasted a month.'
    );
    expect(para!.html).toContain('data-ov-note');
    expect(para!.html).toContain('<sup>1</sup>');
  });
});

describe('separate endnotes file (Calibre style)', () => {
  const build = () =>
    buildTestEpub({
      rawFiles: [
        {
          fileName: 'chapter1.xhtml',
          bodyHtml: `
  <h1>Chapter One</h1>
  <p>The merger was announced in May<a id="r12" href="notes.xhtml#n12">12</a> to great surprise.</p>
  <p>More text follows here<a id="r13" href="notes.xhtml#n13">13</a> in the chapter.</p>`,
        },
        {
          fileName: 'notes.xhtml',
          bodyHtml: `
  <h1>Notes</h1>
  <p id="n12"><a href="chapter1.xhtml#r12">12</a>. Reported in the Financial Times, 12 May.</p>
  <p id="n13"><a href="chapter1.xhtml#r13">13</a>. Interview with the author, June.</p>
  <p id="n14"><a href="chapter1.xhtml#r13">14</a>. Uncited but plausible.</p>`,
        },
      ],
    });

  it('marks refs into the detected notes page as note links', async () => {
    const book = await parseEPUB(await build());
    expect(book.chapters).toHaveLength(2);
    const raw = book.chapters[0].rawHtml;

    // ref 12 → notes chapter (2), exact entry block
    expect(raw).toMatch(
      /<a[^>]*data-ov-chapter="2"[^>]*data-ov-xpath="\/body\[1\]\/p\[1\]"[^>]*>12<\/a>/
    );
    const ref12 = raw.match(/<a[^>]*>12<\/a>/)![0];
    expect(ref12).toContain('data-ov-note="1"');
  });

  it('resolves backlinks in the notes page as plain jumps (not notes)', async () => {
    const book = await parseEPUB(await build());
    const notesRaw = book.chapters[1].rawHtml;

    const backlink = notesRaw.match(/<a[^>]*>12<\/a>/)![0];
    expect(backlink).toContain('data-ov-chapter="1"');
    expect(backlink).toContain('data-ov-xpath="/body[1]/p[1]"');
    expect(backlink).not.toContain('data-ov-note');
  });

  it('keeps entry labels in the notes page translation text', async () => {
    const book = await parseEPUB(await build());
    const entry = book.chapters[1].textNodes.find(
      (n) => n.xpath === '/body[1]/p[1]'
    );
    expect(entry!.text).toContain('12');
    expect(entry!.text).toContain('Financial Times');
  });
});

describe('same-file anchor footnotes (Gutenberg style)', () => {
  const build = () =>
    buildTestEpub({
      rawFiles: [
        {
          fileName: 'chapter1.xhtml',
          bodyHtml: `
  <h1>Chapter One</h1>
  <p>Nursing is an art<a id="FNanchor_1" href="#Footnote_1">[1]</a> requiring devotion.</p>
  <div class="footnotes">
    <p id="Footnote_1"><a href="#FNanchor_1">[1]</a> First published in 1859.</p>
  </div>`,
        },
      ],
    });

  it('classifies the ref as a note via label echo on the target block', async () => {
    const book = await parseEPUB(await build());
    const raw = book.chapters[0].rawHtml;

    // The in-text [1] points at the footnote paragraph and is a note
    const refMatch = raw.match(/<a[^>]*id="FNanchor_1"[^>]*>\[1\]<\/a>/);
    expect(refMatch).toBeTruthy();
    expect(refMatch![0]).toContain('data-ov-note="1"');
    expect(refMatch![0]).toContain('data-ov-xpath="/body[1]/div[1]/p[1]"');

    // The backlink [1] inside the footnote jumps but is not a note
    const backMatch = raw.match(/<p[^>]*id="Footnote_1"[^>]*>([\s\S]*?)<\/p>/);
    expect(backMatch![1]).toContain('data-ov-chapter="1"');
    expect(backMatch![1]).not.toContain('data-ov-note');
  });

  it('strips the in-text label but keeps the footnote entry label', async () => {
    const book = await parseEPUB(await build());
    const para = book.chapters[0].textNodes.find(
      (n) => n.xpath === '/body[1]/p[1]'
    );
    expect(para!.text).toBe('Nursing is an art requiring devotion.');

    const note = book.chapters[0].textNodes.find(
      (n) => n.xpath === '/body[1]/div[1]/p[1]'
    );
    expect(note!.text).toContain('[1] First published in 1859.');
  });
});

describe('cross-references and link policy', () => {
  const build = () =>
    buildTestEpub({
      rawFiles: [
        {
          fileName: 'chapter1.xhtml',
          bodyHtml: `
  <h1>Chapter One</h1>
  <p>As described in <a href="chapter2.xhtml">the next chapter</a>, things change.</p>
  <p>A dead reference <a href="missing.xhtml#x">points nowhere</a> sadly.</p>
  <p>An external <a href="https://example.com">website link</a> stays.</p>
  <a id="marker"></a>
  <p>Paragraph right after a bare anchor.</p>`,
        },
        {
          fileName: 'chapter2.xhtml',
          bodyHtml: `
  <h1>Chapter Two</h1>
  <p>Jump back to <a href="chapter1.xhtml#marker">the marker</a> anytime.</p>`,
        },
      ],
    });

  it('resolves file-level cross-references to the chapter start', async () => {
    const book = await parseEPUB(await build());
    const raw = book.chapters[0].rawHtml;

    const xref = raw.match(/<a[^>]*>the next chapter<\/a>/)![0];
    expect(xref).toContain('data-ov-chapter="2"');
    expect(xref).toContain('data-ov-xpath="/body[1]/h1[1]"');
    expect(xref).not.toContain('data-ov-note');
  });

  it('unwraps unresolvable internal links and keeps external ones', async () => {
    const book = await parseEPUB(await build());
    const raw = book.chapters[0].rawHtml;

    expect(raw).not.toContain('points nowhere</a>');
    expect(raw).toContain('points nowhere');
    expect(raw).toMatch(/<a[^>]*href="https:\/\/example\.com"[^>]*>/);
  });

  it('preserves bare anchors and resolves links to the following block', async () => {
    const book = await parseEPUB(await build());

    expect(book.chapters[0].rawHtml).toMatch(/<a[^>]*id="marker"/);

    const link = book.chapters[1].rawHtml.match(/<a[^>]*>the marker<\/a>/)![0];
    expect(link).toContain('data-ov-chapter="1"');
    expect(link).toContain('data-ov-xpath="/body[1]/p[4]"');
  });

  it('keeps text-node xpaths identical to the pre-rewrite structure', async () => {
    const book = await parseEPUB(await build());
    expect(book.chapters[0].textNodes.map((n) => n.xpath)).toEqual([
      '/body[1]/h1[1]',
      '/body[1]/p[1]',
      '/body[1]/p[2]',
      '/body[1]/p[3]',
      '/body[1]/p[4]',
    ]);
  });
});
