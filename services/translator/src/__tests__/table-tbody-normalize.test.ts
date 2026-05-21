/**
 * Browsers auto-insert <tbody> when <table> has bare <tr> children, but
 * @xmldom/xmldom does not. Without normalization the stored XPath
 * (`/body/table/tr/td/p`) never matches what the reader sees in the
 * rendered DOM (`/body/table/tbody/tr/td/p`), so no translations are
 * applied. Normalize at parse time so both sides agree.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseEPUB } from '../book-parser.js';

async function buildEpub(bodyHtml: string): Promise<Buffer> {
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
  zip.file(
    'OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Ch</title></head>
<body>${bodyHtml}</body>
</html>`
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>T</dc:title><dc:creator>A</dc:creator><dc:language>en</dc:language>
  </metadata>
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`
  );
  return await zip.generateAsync({ type: 'nodebuffer' });
}

describe('normalizeTableBodies', () => {
  it('wraps bare <tr> children of <table> in <tbody> in both rawHtml and XPaths', async () => {
    const body = `<table><tr><td><p>Para A</p></td></tr><tr><td><p>Para B</p></td></tr></table>`;
    const epub = await buildEpub(body);
    const book = await parseEPUB(epub);
    const chapter = book.chapters[0];

    // rawHtml now contains explicit tbody — what the browser would render.
    expect(chapter.rawHtml).toContain('<tbody');

    // Stored XPaths include tbody[1], matching the browser's DOM.
    const xpaths = chapter.textNodes.map(n => n.xpath);
    expect(xpaths.some(x => x.includes('/table[1]/tbody[1]/tr[1]/td[1]/p[1]'))).toBe(true);
    expect(xpaths.some(x => x.includes('/table[1]/tbody[1]/tr[2]/td[1]/p[1]'))).toBe(true);
    // No leftover xpath that skips tbody.
    expect(xpaths.some(x => /\/table\[1\]\/tr\[/.test(x))).toBe(false);
  });

  it('leaves tables that already have <tbody> alone', async () => {
    const body = `<table><tbody><tr><td><p>Already wrapped.</p></td></tr></tbody></table>`;
    const epub = await buildEpub(body);
    const book = await parseEPUB(epub);
    const chapter = book.chapters[0];

    // Only one tbody (not double-wrapped).
    expect((chapter.rawHtml.match(/<tbody/g) || []).length).toBe(1);
    expect(chapter.textNodes.some(n => n.xpath.includes('/tbody[1]/tr[1]/td[1]/p[1]'))).toBe(true);
  });

  it('leaves <table> with no <tr> children untouched (e.g. malformed/empty)', async () => {
    const body = `<table><caption>Empty</caption></table><p>After</p>`;
    const epub = await buildEpub(body);
    const book = await parseEPUB(epub);
    const chapter = book.chapters[0];

    expect(chapter.rawHtml).not.toContain('<tbody');
  });

  it('handles nested tables (PG essay layout): both levels get tbody', async () => {
    const body = `<table><tr><td><table><tr><td><p>Inner paragraph.</p></td></tr></table></td></tr></table>`;
    const epub = await buildEpub(body);
    const book = await parseEPUB(epub);
    const chapter = book.chapters[0];

    expect(chapter.rawHtml).toContain('<tbody');
    // The inner paragraph's xpath goes through tbody at both nesting levels.
    const innerXpath = chapter.textNodes.find(n => n.text === 'Inner paragraph.')?.xpath;
    expect(innerXpath).toMatch(/\/table\[1\]\/tbody\[1\]\/tr\[1\]\/td\[1\]\/table\[1\]\/tbody\[1\]\/tr\[1\]\/td\[1\]\/p\[1\]/);
  });
});
