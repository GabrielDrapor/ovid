/**
 * Regression test for Paul Graham-style essays: a whole article packed into a
 * single leaf block (typically `<td>` or `<font>`) with `<br><br>` separating
 * paragraphs. Without splitting we get one ~22K-char text node that breaks
 * translation and renders as a wall of text.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseEPUB } from '../book-parser.js';

async function buildPgEpub(bodyHtml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Essay</title></head>
<body>${bodyHtml}</body>
</html>`;
  zip.file('OEBPS/ch1.xhtml', xhtml);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Essay</dc:title><dc:creator>PG</dc:creator><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`
  );
  return await zip.generateAsync({ type: 'nodebuffer' });
}

describe('splitBrSeparatedParagraphs', () => {
  it('splits a <td> packed with <br><br>-separated paragraphs into individual text nodes', async () => {
    // Mimics the PG essay structure: outer table sidebar + content cell holding
    // an inner table whose td/font wraps the entire essay separated by <br><br>.
    const body = `<h1>The Lesson to Unlearn</h1>
<table><tr><td><font>December 2019<br/><br/>The most damaging thing you learned in school wasn't something you learned in any specific class.<br/><br/>When I was in college, a particularly earnest philosophy grad student once told me that he never cared what grade he got.<br/><br/>For me, as for most students, the measurement of what I was learning completely dominated actual learning in college.</font></td></tr></table>`;

    const epub = await buildPgEpub(body);
    const book = await parseEPUB(epub);
    expect(book.chapters).toHaveLength(1);
    const chapter = book.chapters[0];

    // Should produce one node per <h1> plus one per paragraph (4) — not one giant blob.
    expect(chapter.textNodes.length).toBeGreaterThanOrEqual(5);

    // Largest node should be a single paragraph, not the entire essay.
    const longest = Math.max(...chapter.textNodes.map(n => n.text.length));
    expect(longest).toBeLessThan(500);

    // Each paragraph appears as its own node.
    const allText = chapter.textNodes.map(n => n.text).join(' | ');
    expect(allText).toContain('December 2019');
    expect(allText).toContain('most damaging thing');
    expect(allText).toContain('particularly earnest philosophy');
    expect(allText).toContain('measurement of what I was learning');

    // rawHtml exposes <p> tags so the reader can locate paragraphs via XPath.
    expect(chapter.rawHtml).toContain('<p');
    expect(chapter.rawHtml).toContain('December 2019');
  });

  it('leaves normal <p>-structured HTML untouched', async () => {
    const body = `<h1>Normal</h1><p>First paragraph.</p><p>Second paragraph.</p>`;
    const epub = await buildPgEpub(body);
    const book = await parseEPUB(epub);
    const chapter = book.chapters[0];

    expect(chapter.textNodes.map(n => n.text)).toEqual([
      'Normal',
      'First paragraph.',
      'Second paragraph.',
    ]);
  });

  it('treats a single <br> as a soft break (does not split paragraph)', async () => {
    const body = `<p>Line one<br/>still the same paragraph.</p>`;
    const epub = await buildPgEpub(body);
    const book = await parseEPUB(epub);
    const chapter = book.chapters[0];

    // Single <br> inside a <p> is NOT a paragraph break — the <p> stays one node.
    const paraTexts = chapter.textNodes.filter(n => n.text.includes('Line one'));
    expect(paraTexts).toHaveLength(1);
    expect(paraTexts[0].text).toMatch(/Line one.*still the same paragraph/);
  });

  it('does nothing when a leaf block has no <br><br> runs', async () => {
    const body = `<div><span>Just <em>some</em> inline text.</span></div>`;
    const epub = await buildPgEpub(body);
    const book = await parseEPUB(epub);
    const chapter = book.chapters[0];

    const target = chapter.textNodes.find(n => n.text.includes('Just'));
    expect(target?.text).toBe('Just some inline text.');
    // No <p> wrapper synthesized.
    expect(chapter.rawHtml).not.toContain('<p>');
  });
});
