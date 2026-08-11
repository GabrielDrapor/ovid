import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import BookProcessor from '../../../src/utils/book-processor';

/**
 * Regression for issue #162: Calibre periodical EPUBs declare their content
 * documents as media-type="text/html" (non-conforming, but common). The
 * manifest filter used to accept only application/xhtml+xml, silently
 * dropping every chapter while images still imported.
 *
 * Builds a minimal Calibre-shaped EPUB in memory: content at
 * feed_N/article_N/index.html, all manifest items text/html, NCX TOC.
 */
async function buildCalibreEpub(
  mediaType: string,
  hrefPrefixInSpine = ''
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );
  const article = (title: string, body: string) =>
    `<?xml version='1.0' encoding='utf-8'?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body><h2>${title}</h2><p>${body}</p></body>
</html>`;
  zip.file(
    'feed_0/article_0/index.html',
    article('Politics this week', 'World news happened repeatedly. '.repeat(30))
  );
  zip.file(
    'feed_0/article_1/index.html',
    article('Business this week', 'Markets moved with feeling. '.repeat(30))
  );
  zip.file(
    'content.opf',
    `<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>TheEconomist.2026.03.21</dc:title>
    <dc:creator>Kovid Goyal</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="a0" href="${hrefPrefixInSpine}feed_0/article_0/index.html" media-type="${mediaType}"/>
    <item id="a1" href="${hrefPrefixInSpine}feed_0/article_1/index.html" media-type="${mediaType}"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="a0"/>
    <itemref idref="a1"/>
  </spine>
</package>`
  );
  zip.file(
    'toc.ncx',
    `<?xml version='1.0' encoding='utf-8'?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint class="periodical" id="p1" playOrder="1">
      <navLabel><text>TheEconomist.2026.03.21</text></navLabel>
      <content src="feed_0/article_0/index.html"/>
      <navPoint class="section" id="s1" playOrder="2">
        <navLabel><text>The world this week</text></navLabel>
        <content src="feed_0/article_0/index.html"/>
        <navPoint class="article" id="a1" playOrder="3">
          <navLabel><text>Politics this week</text></navLabel>
          <content src="feed_0/article_0/index.html"/>
        </navPoint>
        <navPoint class="article" id="a2" playOrder="4">
          <navLabel><text>Business this week</text></navLabel>
          <content src="feed_0/article_1/index.html"/>
        </navPoint>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('BookProcessor: Calibre periodical EPUBs (issue #162)', () => {
  const processor = new BookProcessor(1, { apiKey: 'test' });

  it('parses chapters from text/html manifest items', async () => {
    const epub = await buildCalibreEpub('text/html');
    const book = await processor.parseEPUBV2(epub);
    expect(book.chapters.length).toBe(2);
    const titles = book.chapters.map((c) => c.title);
    // article_0 is also the target of the periodical/section wrapper
    // navPoints; the first TOC entry per file wins, so it carries the
    // periodical label. article_1 keeps its own article title.
    expect(titles[0]).toBe('TheEconomist.2026.03.21');
    expect(titles).toContain('Business this week');
    // Body text survives into text nodes
    const allText = book.chapters
      .flatMap((c) => c.contentItems.map((n) => n.text))
      .join(' ');
    expect(allText).toContain('World news happened');
  });

  it('still parses conforming application/xhtml+xml items', async () => {
    const epub = await buildCalibreEpub('application/xhtml+xml');
    const book = await processor.parseEPUBV2(epub);
    expect(book.chapters.length).toBe(2);
  });

  it('resolves URL-encoded spine hrefs via the decoded fallback', async () => {
    const epub = await buildCalibreEpub('text/html', './');
    const book = await processor.parseEPUBV2(epub);
    expect(book.chapters.length).toBe(2);
  });
});
