/**
 * Minimal EPUB builder for tests.
 * Constructs valid EPUB files (ZIP with OPF structure) programmatically.
 */
import JSZip from 'jszip';

export interface TestChapter {
  title: string;
  paragraphs: string[];
}

export interface TestEpubOptions {
  title?: string;
  author?: string;
  chapters?: TestChapter[];
  /** Include a test image */
  includeImage?: boolean;
  /** Include CSS styles */
  includeStyles?: boolean;
  /** Create an empty book (no text content) */
  empty?: boolean;
  /** Create a chapter with very long text to test large content handling */
  largeChapter?: boolean;
  /** Include HTML entities that need decoding */
  withEntities?: boolean;
  /** Include nested block elements */
  nestedBlocks?: boolean;
}

const DEFAULT_CHAPTERS: TestChapter[] = [
  {
    title: 'The Beginning',
    paragraphs: [
      'It was a bright cold day in April, and the clocks were striking thirteen.',
      'Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions.',
    ],
  },
  {
    title: 'The Journey',
    paragraphs: [
      'The hallway smelt of boiled cabbage and old rag mats.',
      'At one end of it a coloured poster, too large for indoor display, had been tacked to the wall.',
    ],
  },
];

/**
 * Build a valid EPUB file as a Buffer.
 */
export async function buildTestEpub(options: TestEpubOptions = {}): Promise<Buffer> {
  const {
    title = 'Test Book',
    author = 'Test Author',
    chapters = DEFAULT_CHAPTERS,
    includeImage = false,
    includeStyles = false,
    empty = false,
    largeChapter = false,
    withEntities = false,
    nestedBlocks = false,
  } = options;

  const zip = new JSZip();

  // 1. mimetype (must be first, uncompressed)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // 2. META-INF/container.xml
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  // 3. Build chapters
  const actualChapters: TestChapter[] = empty
    ? []
    : [...chapters];

  if (largeChapter) {
    const largeParagraphs = Array.from({ length: 200 }, (_, i) =>
      `This is paragraph number ${i + 1} of a very large chapter designed to test handling of books with many text nodes. The quick brown fox jumps over the lazy dog.`
    );
    actualChapters.push({ title: 'The Large Chapter', paragraphs: largeParagraphs });
  }

  if (withEntities) {
    actualChapters.push({
      title: 'Entities &amp; Special Characters',
      paragraphs: [
        'He said &quot;hello&quot; and she replied &amp; waved.',
        'The temperature was &gt;100&deg; and &lt;200&deg;.',
        'Price: &#36;99.99 &mdash; a great deal!',
      ],
    });
  }

  if (nestedBlocks) {
    // This will be handled separately in XHTML generation
    actualChapters.push({
      title: 'Nested Structure',
      paragraphs: ['__NESTED_BLOCK__'], // sentinel
    });
  }

  // 4. Generate XHTML files for each chapter
  const chapterFiles: string[] = [];
  for (let i = 0; i < actualChapters.length; i++) {
    const ch = actualChapters[i];
    const filename = `chapter${i + 1}.xhtml`;
    chapterFiles.push(filename);

    let bodyContent: string;
    if (ch.paragraphs[0] === '__NESTED_BLOCK__') {
      bodyContent = `
    <h1>${ch.title}</h1>
    <div class="section">
      <div class="subsection">
        <p>Nested paragraph inside two divs.</p>
        <blockquote>
          <p>A quote inside a blockquote inside divs.</p>
        </blockquote>
      </div>
      <p>Direct child of section div.</p>
    </div>`;
    } else {
      bodyContent = `
    <h1>${ch.title}</h1>
    ${ch.paragraphs.map((p) => `<p>${p}</p>`).join('\n    ')}`;
    }

    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${ch.title}</title>
  ${includeStyles ? '<style>body { font-family: serif; } p { margin: 1em 0; }</style>' : ''}
</head>
<body>
  ${bodyContent}
</body>
</html>`;

    zip.file(`OEBPS/${filename}`, xhtml);
  }

  // 5. Optional CSS
  if (includeStyles) {
    zip.file('OEBPS/styles.css', 'body { font-family: Georgia, serif; line-height: 1.6; }');
  }

  // 6. Optional image (1x1 red PNG)
  if (includeImage) {
    // Minimal valid PNG (1x1 red pixel)
    const pngData = Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000100000001080200' +
        '0000907753de0000000c49444154789c626060f80f000001010' +
        '000187418e40000000049454e44ae426082',
      'hex'
    );
    zip.file('OEBPS/images/test.png', pngData);
  }

  // 7. content.opf
  const manifestItems = chapterFiles
    .map(
      (f, i) =>
        `    <item id="ch${i + 1}" href="${f}" media-type="application/xhtml+xml"/>`
    )
    .join('\n');

  const spineItems = chapterFiles
    .map((_, i) => `    <itemref idref="ch${i + 1}"/>`)
    .join('\n');

  const imageManifest = includeImage
    ? '    <item id="img1" href="images/test.png" media-type="image/png"/>'
    : '';

  const styleManifest = includeStyles
    ? '    <item id="css1" href="styles.css" media-type="text/css"/>'
    : '';

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
${manifestItems}
${imageManifest}
${styleManifest}
  </manifest>
  <spine>
${spineItems}
  </spine>
</package>`;

  zip.file('OEBPS/content.opf', opf);

  // 8. Generate ZIP buffer
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return buffer;
}
