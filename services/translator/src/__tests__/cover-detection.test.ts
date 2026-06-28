/**
 * The EPUB upload flow prefers the book's own embedded cover over an
 * AI-generated one. parseEPUB must surface that cover via the three standard
 * declarations — EPUB3 manifest properties="cover-image", EPUB2
 * <meta name="cover">, and a filename fallback — and leave coverImage
 * undefined when none is declared.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseEPUB } from '../book-parser.js';

const COVER_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
]); // jpeg-ish

async function buildEpub(
  manifest: string,
  metadataExtra = ''
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );
  zip.file(
    'OEBPS/ch1.xhtml',
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C</title></head><body><p>Hello world.</p></body></html>`
  );
  zip.file('OEBPS/images/cover.jpg', COVER_BYTES);
  zip.file('OEBPS/images/photo.jpg', COVER_BYTES);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>T</dc:title><dc:creator>A</dc:creator><dc:language>en</dc:language>
    ${metadataExtra}
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    ${manifest}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('parseEPUB — embedded cover detection', () => {
  it('EPUB3: manifest item with properties="cover-image"', async () => {
    const epub = await buildEpub(
      `<item id="coverimg" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
       <item id="ph" href="images/photo.jpg" media-type="image/jpeg"/>`
    );
    const book = await parseEPUB(epub);
    expect(book.coverImage?.filename).toBe('cover.jpg');
    expect(book.coverImage?.data.length).toBeGreaterThan(0);
  });

  it('EPUB2: <meta name="cover" content="id"> resolves to the manifest item', async () => {
    // Note the cover image is NOT named "cover" here, so only the meta can find it.
    const epub = await buildEpub(
      `<item id="thecover" href="images/photo.jpg" media-type="image/jpeg"/>`,
      `<meta name="cover" content="thecover"/>`
    );
    const book = await parseEPUB(epub);
    expect(book.coverImage?.filename).toBe('photo.jpg');
  });

  it('falls back to a filename that looks like a cover', async () => {
    const epub = await buildEpub(
      `<item id="i1" href="images/photo.jpg" media-type="image/jpeg"/>
       <item id="i2" href="images/cover.jpg" media-type="image/jpeg"/>`
    );
    const book = await parseEPUB(epub);
    expect(book.coverImage?.filename).toBe('cover.jpg');
  });

  it('prefers an explicit declaration over the filename heuristic', async () => {
    // photo.jpg is declared the cover even though cover.jpg exists.
    const epub = await buildEpub(
      `<item id="dc" href="images/photo.jpg" media-type="image/jpeg" properties="cover-image"/>
       <item id="i2" href="images/cover.jpg" media-type="image/jpeg"/>`
    );
    const book = await parseEPUB(epub);
    expect(book.coverImage?.filename).toBe('photo.jpg');
  });

  it('leaves coverImage undefined when nothing declares or looks like a cover', async () => {
    const epub = await buildEpub(
      `<item id="i1" href="images/photo.jpg" media-type="image/jpeg"/>`
    );
    const book = await parseEPUB(epub);
    expect(book.coverImage).toBeUndefined();
  });
});
