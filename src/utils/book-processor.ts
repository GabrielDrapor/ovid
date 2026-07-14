/**
 * Book Processor for Worker Environment
 * Handles EPUB parsing and translation in Cloudflare Workers (XPath-based V2)
 */

import { Translator } from './translator';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { initMobiFile, initKf8File } from '@lingo-reader/mobi-parser';

// V2 content item with XPath support
export interface ContentItemV2 {
  xpath: string;
  text: string; // Plain text for translation
  html: string; // Original innerHTML (preserves formatting)
  orderIndex: number;
}

export interface ChapterV2 {
  number: number;
  title: string;
  originalTitle: string;
  rawHtml: string; // Raw HTML content from EPUB
  textNodes: ContentItemV2[];
}

export interface EpubImage {
  /** Path inside the EPUB zip (e.g. "OEBPS/images/fig1.jpg") */
  zipPath: string;
  /** Just the filename (e.g. "fig1.jpg") */
  filename: string;
  /** MIME type (e.g. "image/jpeg") */
  mediaType: string;
  /** Raw binary data */
  data: Uint8Array;
}

export interface BookDataV2 {
  title: string;
  originalTitle: string;
  author: string;
  language: string;
  chapters: ChapterV2[];
  styles?: string;
  /** Images extracted from the EPUB, ready for upload */
  images?: EpubImage[];
}

export interface TranslatedChapterV2 extends ChapterV2 {
  translatedTitle: string;
  translations: Map<string, string>; // xpath -> translated text
}

export interface ProcessedBookV2 {
  metadata: {
    title: string;
    originalTitle: string;
    author: string;
    languagePair: string;
    styles: string;
  };
  chapters: TranslatedChapterV2[];
}

// ---- Parsing helpers (kept in sync with services/translator/src/book-parser.ts) ----

const blockTags = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'td',
  'th',
  'dt',
  'dd',
  'figcaption',
  'article',
  'section',
  // EPUB3 popup footnotes live in <aside epub:type="footnote">, often as
  // bare text without a <p> wrapper — treat aside as a block so that text
  // is extracted (and translated) instead of silently dropped.
  'aside',
]);

const skipTags = new Set([
  'script',
  'style',
  'noscript',
  'head',
  'meta',
  'link',
]);

/** Collapse ./ and ../ segments in a zip path for reliable matching. */
function normalizeZipPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function getFullTextContent(node: any): string {
  let text = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) text += child.textContent || '';
      else if (child.nodeType === 1) text += getFullTextContent(child);
    }
  }
  return text;
}

/**
 * Like getFullTextContent, but skips note-reference links (superscript
 * footnote labels rewritten to `a[data-ov-note]`) so they don't pollute
 * the text sent to translation.
 */
function getTranslatableTextContent(node: any): string {
  let text = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) text += child.textContent || '';
      else if (child.nodeType === 1) {
        if (
          (child.nodeName || '').toLowerCase() === 'a' &&
          child.getAttribute?.('data-ov-note')
        )
          continue;
        text += getTranslatableTextContent(child);
      }
    }
  }
  return text;
}

function serializeNode(node: any): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';

  const tagName = (node.nodeName || 'div').toLowerCase();

  let inner = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      inner += serializeNode(children[i]);
    }
  }

  // <a> policy: keep external http(s) links, resolved internal links
  // (data-ov-chapter) and named anchors; unwrap everything else.
  if (tagName === 'a') {
    const href = node.getAttribute?.('href');
    const keep =
      node.getAttribute?.('data-ov-chapter') ||
      node.getAttribute?.('id') ||
      node.getAttribute?.('name') ||
      (href && href.startsWith('http'));
    if (!keep) return inner;
  }

  let attrs = '';
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes[i];
      attrs += ` ${attr.name}="${attr.value}"`;
    }
  }

  const selfClosing = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
  if (selfClosing.has(tagName)) return `<${tagName}${attrs}/>`;

  return `<${tagName}${attrs}>${inner}</${tagName}>`;
}

function getInnerHtml(node: any): string {
  let html = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) html += child.textContent || '';
      else if (child.nodeType === 1) html += serializeNode(child);
    }
  }
  return html;
}

const hasChildBlockElements = (node: any): boolean => {
  const children = node.childNodes;
  if (!children) return false;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 1) {
      const childTag = (child.nodeName || '').toLowerCase();
      if (blockTags.has(childTag)) return true;
    }
  }
  return false;
};

/** DFS visiting every leaf block element with its computed XPath. */
function walkBlockLeaves(body: any, cb: (node: any, xpath: string) => void) {
  const visit = (node: any, pathSegments: string[]) => {
    if (!node || node.nodeType !== 1) return;

    const tagName = (node.nodeName || '').toLowerCase();
    if (skipTags.has(tagName)) return;

    let elementIndex = 1;
    let sibling = node.previousSibling;
    while (sibling) {
      if (
        sibling.nodeType === 1 &&
        (sibling.nodeName || '').toLowerCase() === tagName
      )
        elementIndex++;
      sibling = sibling.previousSibling;
    }

    const currentPath = [...pathSegments, `${tagName}[${elementIndex}]`];

    if (blockTags.has(tagName)) {
      if (hasChildBlockElements(node)) {
        const children = node.childNodes;
        if (children) {
          for (let i = 0; i < children.length; i++)
            visit(children[i], currentPath);
        }
        return;
      }
      cb(node, '/' + currentPath.join('/'));
      return;
    }

    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) visit(children[i], currentPath);
    }
  };

  const bodyChildren = body.childNodes;
  for (let i = 0; i < bodyChildren.length; i++) {
    visit(bodyChildren[i], ['body[1]']);
  }
}

function extractTextNodes(body: any): ContentItemV2[] {
  const textNodes: ContentItemV2[] = [];
  let orderIndex = 0;
  walkBlockLeaves(body, (node, xpath) => {
    const fullText = decodeEntities(getTranslatableTextContent(node));
    if (fullText.length >= 2) {
      textNodes.push({
        xpath,
        text: fullText,
        html: getInnerHtml(node),
        orderIndex: orderIndex++,
      });
    }
  });
  return textNodes;
}

function extractChapterTitle(
  doc: any,
  body: any,
  chapterNumber: number
): string {
  let chapterTitle = '';
  const h1 = doc.getElementsByTagName('h1')[0];
  const h2 = doc.getElementsByTagName('h2')[0];
  const h3 = doc.getElementsByTagName('h3')[0];
  if (h1?.textContent?.trim()) chapterTitle = h1.textContent.trim();
  else if (h2?.textContent?.trim()) chapterTitle = h2.textContent.trim();
  else if (h3?.textContent?.trim()) chapterTitle = h3.textContent.trim();
  if (chapterTitle) return chapterTitle;

  const headingParts: string[] = [];
  let stopScanning = false;
  const scanForHeadings = (parent: any) => {
    const children = parent.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      if (stopScanning || headingParts.length >= 3) return;
      const child = children[i];
      if (child.nodeType !== 1) continue;
      const tag = (child.nodeName || '').toLowerCase();
      if (skipTags.has(tag)) continue;
      if (blockTags.has(tag)) {
        if (hasChildBlockElements(child)) {
          scanForHeadings(child);
          continue;
        }
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 1 && text.length <= 50) headingParts.push(text);
        else if (text.length > 50) {
          stopScanning = true;
          return;
        }
      } else {
        scanForHeadings(child);
      }
    }
  };
  scanForHeadings(body);
  return headingParts.join(' – ') || `Chapter ${chapterNumber}`;
}

function serializeBodyHtml(body: any): string {
  let rawHtml = '';
  const bodyChildren = body.childNodes;
  for (let i = 0; i < bodyChildren.length; i++) {
    const child = bodyChildren[i];
    if (child.nodeType === 1) rawHtml += serializeNode(child);
    else if (child.nodeType === 3 && child.textContent?.trim())
      rawHtml += child.textContent;
  }
  return rawHtml;
}

// ---- Internal links & footnotes (see book-parser.ts for the taxonomy) ----

interface AnchorTarget {
  chapter: number;
  xpath: string;
}

interface AnchorIndex {
  anchors: Map<string, string>;
  firstBlockXpath: string | null;
  blockTexts: Map<string, string>;
}

function buildAnchorIndex(body: any): AnchorIndex {
  const leaves: { node: any; xpath: string; text: string }[] = [];
  walkBlockLeaves(body, (node, xpath) => {
    leaves.push({
      node,
      xpath,
      text: decodeEntities(getFullTextContent(node)),
    });
  });

  const blockTexts = new Map<string, string>();
  for (const l of leaves) blockTexts.set(l.xpath, l.text);
  const firstContentLeaf = leaves.find((l) => l.text.length >= 2) || null;

  const seqOf = new Map<any, number>();
  let seq = 0;
  const numberDfs = (node: any) => {
    if (!node || node.nodeType !== 1) return;
    seqOf.set(node, seq++);
    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) numberDfs(children[i]);
    }
  };
  numberDfs(body);

  const leafXpathByNode = new Map<any, string>();
  for (const l of leaves) leafXpathByNode.set(l.node, l.xpath);

  const anchors = new Map<string, string>();
  const collectIds = (node: any) => {
    if (!node || node.nodeType !== 1) return;
    const ids: string[] = [];
    const id = node.getAttribute?.('id');
    const name =
      (node.nodeName || '').toLowerCase() === 'a'
        ? node.getAttribute?.('name')
        : null;
    if (id) ids.push(id);
    if (name && name !== id) ids.push(name);

    if (ids.length > 0) {
      let xpath: string | undefined;
      let p = node;
      while (p && p !== body) {
        const found = leafXpathByNode.get(p);
        if (found) {
          xpath = found;
          break;
        }
        p = p.parentNode;
      }
      if (!xpath) {
        const mySeq = seqOf.get(node) ?? 0;
        const next = leaves.find((l) => (seqOf.get(l.node) ?? -1) >= mySeq);
        xpath = (next || leaves[leaves.length - 1])?.xpath;
      }
      if (xpath) {
        for (const key of ids) {
          if (!anchors.has(key)) anchors.set(key, xpath);
        }
      }
    }

    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) collectIds(children[i]);
    }
  };
  collectIds(body);

  return {
    anchors,
    firstBlockXpath: firstContentLeaf?.xpath ?? null,
    blockTexts,
  };
}

const NOTES_HEADING_INDICATORS = [
  'notes',
  'endnotes',
  'footnotes',
  '注释',
  '尾注',
  '脚注',
  '注釈',
];

function detectNotesPage(body: any, filePath: string, title: string): boolean {
  const titleLower = (title || '').trim().toLowerCase();
  let hasHeading = NOTES_HEADING_INDICATORS.some(
    (ind) => titleLower.length <= 30 && titleLower.includes(ind)
  );
  if (!hasHeading) {
    outer: for (const tag of ['h1', 'h2', 'h3', 'p']) {
      const els = body.getElementsByTagName(tag);
      for (let i = 0; i < Math.min(els.length, 3); i++) {
        const text = (els[i].textContent || '').trim().toLowerCase();
        if (
          text.length > 0 &&
          text.length < 30 &&
          NOTES_HEADING_INDICATORS.some((ind) => text.includes(ind))
        ) {
          hasHeading = true;
          break outer;
        }
      }
    }
  }

  const fileName = filePath.split('/').pop() || filePath;
  const paragraphs = body.getElementsByTagName('p');
  let total = 0;
  let backLinked = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const text = (p.textContent || '').trim();
    if (text.length < 3) continue;
    total++;
    const link = p.getElementsByTagName('a')[0];
    if (!link) continue;
    const href = link.getAttribute('href') || '';
    const targetFile = href.split('#')[0];
    if (
      targetFile &&
      !targetFile.startsWith('http') &&
      !targetFile.endsWith(fileName)
    ) {
      backLinked++;
    }
  }

  const ratio = total > 0 ? backLinked / total : 0;
  return (
    (hasHeading && total >= 3 && ratio >= 0.25) || (total >= 5 && ratio >= 0.5)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NOTE_LABEL_RE = /^[[(]?(\d{1,4}|[*†‡§‖¶#])[\])]?\.?$/;

function rewriteInternalLinks(opts: {
  body: any;
  filePath: string;
  anchorMap: Map<string, AnchorTarget>;
  notesFiles: Set<string>;
  blockTextByKey: Map<string, string>;
}): void {
  const { body, filePath, anchorMap, notesFiles, blockTextByKey } = opts;
  const dir = filePath.includes('/')
    ? filePath.slice(0, filePath.lastIndexOf('/') + 1)
    : '';

  const linkEls = body.getElementsByTagName('a');
  const links: any[] = [];
  for (let i = 0; i < linkEls.length; i++) links.push(linkEls[i]);

  for (const a of links) {
    const href = a.getAttribute('href');
    if (!href) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;

    const [rawPath, rawFrag] = href.split('#', 2);
    let targetPath = filePath;
    if (rawPath) {
      try {
        const decoded = decodeURIComponent(rawPath);
        targetPath = normalizeZipPath(
          decoded.startsWith('/') ? decoded.slice(1) : dir + decoded
        );
      } catch {
        continue;
      }
    }
    let frag: string | null = null;
    if (rawFrag) {
      try {
        frag = decodeURIComponent(rawFrag);
      } catch {
        frag = rawFrag;
      }
    }

    const target =
      (frag ? anchorMap.get(`${targetPath}#${frag}`) : undefined) ||
      anchorMap.get(targetPath);
    if (!target) continue;

    const label = getFullTextContent(a).trim();
    const epubType = a.getAttribute('epub:type') || '';
    const role = a.getAttribute('role') || '';
    let isNote = /noteref/i.test(epubType) || /doc-noteref/i.test(role);
    if (!isNote && NOTE_LABEL_RE.test(label)) {
      if (targetPath !== filePath && notesFiles.has(targetPath)) {
        isNote = true;
      } else {
        const targetText =
          blockTextByKey.get(`${targetPath}#${target.xpath}`) || '';
        const core = label.replace(/[[\]().]/g, '');
        if (
          core &&
          new RegExp(`^[[(]?${escapeRegExp(core)}[\\])]?[.):\\s]`).test(
            targetText + ' '
          )
        ) {
          isNote = true;
        }
      }
    }

    a.setAttribute('data-ov-chapter', String(target.chapter));
    a.setAttribute('data-ov-xpath', target.xpath);
    if (isNote) a.setAttribute('data-ov-note', '1');
    a.removeAttribute('href');
    a.setAttribute('tabindex', '0');
    if (!role) a.setAttribute('role', isNote ? 'doc-noteref' : 'link');
  }
}

function markFootnoteAsides(body: any): void {
  const walk = (node: any) => {
    if (!node || node.nodeType !== 1) return;
    const epubType = node.getAttribute?.('epub:type') || '';
    if (
      /\b(footnote|rearnote|endnote)s?\b/i.test(epubType) &&
      !/noteref/i.test(epubType)
    ) {
      node.setAttribute('data-ov-hidden', 'note');
    }
    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) walk(children[i]);
    }
  };
  walk(body);
}

export class BookProcessor {
  private translator: Translator;

  constructor(
    concurrency: number = 8,
    translatorConfig?: {
      apiKey?: string;
      baseURL?: string;
      model?: string;
    }
  ) {
    this.translator = new Translator({
      concurrency,
      ...translatorConfig,
    });
  }

  /**
   * Parse EPUB file with XPath-based extraction
   */
  async parseEPUBV2(buffer: ArrayBuffer): Promise<BookDataV2> {
    const zip = new JSZip();
    const zipContent = await zip.loadAsync(buffer);

    // Find and parse OPF file for metadata
    const opfFile = Object.keys(zipContent.files).find((name) =>
      name.endsWith('.opf')
    );

    let title = 'Unknown Title';
    let author = 'Unknown Author';
    let htmlFiles: string[] = [];
    let globalStyles = '';
    let imageManifestEntries: { href: string; mediaType: string }[] = [];

    if (opfFile) {
      const opfContent = await zipContent.files[opfFile].async('text');
      const doc = new DOMParser().parseFromString(opfContent, 'text/xml');

      // Extract metadata
      const titleElement = doc.getElementsByTagName('dc:title')[0];
      const authorElement = doc.getElementsByTagName('dc:creator')[0];

      if (titleElement?.textContent) {
        title = titleElement.textContent.trim();
      }
      if (authorElement?.textContent) {
        author = authorElement.textContent.trim();
      }

      // Extract CSS styles from manifest
      const manifestElements = doc.getElementsByTagName('item');
      for (let i = 0; i < manifestElements.length; i++) {
        const item = manifestElements[i];
        const mediaType = item.getAttribute('media-type');
        const href = item.getAttribute('href');

        if (mediaType === 'text/css' && href) {
          try {
            const basePath = opfFile.substring(0, opfFile.lastIndexOf('/') + 1);
            const cssPath = basePath + href;
            const cssFile = zipContent.files[cssPath];
            if (cssFile) {
              const cssContent = await cssFile.async('text');
              globalStyles += `/* ${href} */\n${cssContent}\n`;
            }
          } catch (e) {
            console.warn(`Failed to read CSS file: ${href}`);
          }
        }
      }

      // Build manifest map and get spine order; also collect image entries
      const manifestMap = new Map<string, string>();
      imageManifestEntries = [];
      for (let i = 0; i < manifestElements.length; i++) {
        const item = manifestElements[i];
        const id = item.getAttribute('id');
        const href = item.getAttribute('href');
        const mediaType = item.getAttribute('media-type');

        if (id && href && mediaType === 'application/xhtml+xml') {
          manifestMap.set(id, href);
        }
        // Collect image entries
        if (href && mediaType && mediaType.startsWith('image/')) {
          imageManifestEntries.push({ href, mediaType });
        }
      }

      // Get spine order
      const spineItems = doc.getElementsByTagName('itemref');
      for (let i = 0; i < spineItems.length; i++) {
        const itemref = spineItems[i];
        const idref = itemref.getAttribute('idref');

        if (idref && manifestMap.has(idref)) {
          const href = manifestMap.get(idref)!;
          const basePath = opfFile.substring(0, opfFile.lastIndexOf('/') + 1);
          const fullPath = href.startsWith('/')
            ? href.substring(1)
            : basePath + href;
          htmlFiles.push(fullPath);
        }
      }
    }

    // Parse chapters in two phases so internal links can resolve across
    // files (kept in sync with services/translator/src/book-parser.ts).
    interface PreparedFile {
      normPath: string;
      doc: any;
      body: any;
      chapterNumber: number;
      title: string;
      index: AnchorIndex;
      isNotesPage: boolean;
    }

    const prepared: PreparedFile[] = [];
    let chapterNumber = 1;

    for (const htmlPath of htmlFiles) {
      const file = zipContent.files[htmlPath];
      if (!file) continue;

      const htmlContent = await file.async('text');
      const doc = new DOMParser().parseFromString(htmlContent, 'text/html');

      // Extract internal styles
      const styleTags = doc.getElementsByTagName('style');
      for (let i = 0; i < styleTags.length; i++) {
        const styleContent = styleTags[i].textContent;
        if (styleContent) {
          globalStyles += `/* Internal from ${htmlPath} */\n${styleContent}\n`;
        }
      }

      const body = doc.getElementsByTagName('body')[0];
      if (!body) continue;

      const index = buildAnchorIndex(body);
      if (!index.firstBlockXpath) continue;

      const title = extractChapterTitle(doc, body, chapterNumber);
      prepared.push({
        normPath: normalizeZipPath(htmlPath),
        doc,
        body,
        chapterNumber,
        title,
        index,
        isNotesPage: detectNotesPage(body, htmlPath, title),
      });
      chapterNumber++;
    }

    const anchorMap = new Map<string, AnchorTarget>();
    const notesFiles = new Set<string>();
    const blockTextByKey = new Map<string, string>();
    for (const p of prepared) {
      anchorMap.set(p.normPath, {
        chapter: p.chapterNumber,
        xpath: p.index.firstBlockXpath!,
      });
      p.index.anchors.forEach((xpath, id) => {
        anchorMap.set(`${p.normPath}#${id}`, {
          chapter: p.chapterNumber,
          xpath,
        });
      });
      if (p.isNotesPage) notesFiles.add(p.normPath);
      p.index.blockTexts.forEach((text, xpath) => {
        blockTextByKey.set(`${p.normPath}#${xpath}`, text);
      });
    }

    const chapters: ChapterV2[] = [];
    for (const p of prepared) {
      rewriteInternalLinks({
        body: p.body,
        filePath: p.normPath,
        anchorMap,
        notesFiles,
        blockTextByKey,
      });
      markFootnoteAsides(p.body);

      chapters.push({
        number: p.chapterNumber,
        title: p.title,
        originalTitle: p.title,
        rawHtml: serializeBodyHtml(p.body),
        textNodes: extractTextNodes(p.body),
      });
    }

    // Extract images from EPUB
    const images: EpubImage[] = [];
    const basePath = opfFile
      ? opfFile.substring(0, opfFile.lastIndexOf('/') + 1)
      : '';
    for (const entry of imageManifestEntries) {
      const imgPath = entry.href.startsWith('/')
        ? entry.href.substring(1)
        : basePath + entry.href;
      const imgFile = zipContent.files[imgPath];
      if (imgFile) {
        try {
          const data = await imgFile.async('uint8array');
          const filename = entry.href.split('/').pop() || entry.href;
          images.push({
            zipPath: imgPath,
            filename,
            mediaType: entry.mediaType,
            data,
          });
        } catch (e) {
          console.warn(`Failed to extract image: ${imgPath}`);
        }
      }
    }

    return {
      title,
      originalTitle: title,
      author,
      language: 'en',
      chapters,
      styles: globalStyles,
      images: images.length > 0 ? images : undefined,
    };
  }

  /**
   * Parse MOBI/AZW3 file with XPath-based extraction.
   * @param buffer - Raw file bytes
   * @param fileExtension - '.mobi' or '.azw3' to select the right parser
   */
  async parseMOBI(
    buffer: ArrayBuffer,
    fileExtension: string
  ): Promise<BookDataV2> {
    const uint8 = new Uint8Array(buffer);

    // Try KF8 parser for .azw3, MOBI parser for .mobi.
    // If KF8 parsing yields very few chapters (library bug), fall back to MOBI parser.
    const isKf8 = fileExtension === '.azw3';
    let parser:
      | Awaited<ReturnType<typeof initMobiFile>>
      | Awaited<ReturnType<typeof initKf8File>>;

    if (isKf8) {
      // Try KF8 first, fall back to MOBI if chapters fail to load
      try {
        parser = await initKf8File(uint8);
        const result = await this._parseMOBIInternal(parser);
        if (result.chapters.length >= 1) {
          return result;
        }
        // Too few chapters — fall back to MOBI parser
        parser.destroy();
      } catch {
        // KF8 parse failed, try MOBI
      }
    }

    parser = await initMobiFile(uint8);
    return this._parseMOBIInternal(parser);
  }

  /**
   * Internal: extract BookDataV2 from an already-initialized MOBI/KF8 parser.
   */
  private async _parseMOBIInternal(
    parser:
      | Awaited<ReturnType<typeof initMobiFile>>
      | Awaited<ReturnType<typeof initKf8File>>
  ): Promise<BookDataV2> {
    // Placeholder to satisfy TS — actual parser passed in

    const metadata = parser.getMetadata();
    const spine = parser.getSpine();

    const title = metadata.title || 'Unknown Title';
    const author =
      metadata.author && metadata.author.length > 0
        ? metadata.author.join(', ')
        : 'Unknown Author';

    const chapters: ChapterV2[] = [];
    let chapterNumber = 1;
    let globalStyles = '';

    for (const spineItem of spine) {
      let loaded;
      try {
        loaded = parser.loadChapter(spineItem.id);
      } catch (e) {
        console.warn(`Failed to load chapter ${spineItem.id}, skipping:`, e);
        continue;
      }
      if (!loaded) continue;

      const html = loaded.html;
      if (!html || !html.trim()) continue;

      // Collect CSS from chapter
      if (loaded.css && loaded.css.length > 0) {
        for (const cssPart of loaded.css) {
          // cssPart has id and href; the href content is embedded in the html
          // We don't have raw CSS content from mobi-parser, skip
        }
      }

      // Strip internal links (filepos:, kindle:, #) — replace <a> with its text content
      const cleanedHtml = html.replace(
        /<a\s+[^>]*href\s*=\s*["'](?:filepos:|kindle:|#)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
        '$1'
      );

      // Wrap in a full HTML document for parseHTMLChapterV2
      const wrappedHtml = `<html><body>${cleanedHtml}</body></html>`;
      const chapterData = this.parseHTMLChapterV2(wrappedHtml, chapterNumber);

      if (chapterData && chapterData.textNodes.length > 0) {
        chapters.push({
          ...chapterData,
          number: chapterNumber++,
        });
      }
    }

    parser.destroy();

    return {
      title,
      originalTitle: title,
      author,
      language: metadata.language || 'en',
      chapters,
      styles: globalStyles,
    };
  }

  /**
   * Parse a single HTML chapter with XPath extraction (single-file mode:
   * used by the MOBI path, where internal links are stripped beforehand).
   */
  private parseHTMLChapterV2(
    html: string,
    chapterNumber: number
  ): {
    title: string;
    originalTitle: string;
    rawHtml: string;
    textNodes: ContentItemV2[];
  } | null {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.getElementsByTagName('body')[0];
    if (!body) return null;

    const chapterTitle = extractChapterTitle(doc, body, chapterNumber);

    return {
      title: chapterTitle,
      originalTitle: chapterTitle,
      rawHtml: serializeBodyHtml(body),
      textNodes: extractTextNodes(body),
    };
  }

  /**
   * Translate book content (XPath based)
   */
  async translateBookV2(
    bookData: BookDataV2,
    targetLanguage: string,
    sourceLanguage: string = 'en',
    chapterConcurrency: number = 2,
    onProgress?: (current: number, total: number) => void
  ): Promise<ProcessedBookV2> {
    const totalItems = bookData.chapters.reduce(
      (sum, ch) => sum + ch.textNodes.length + 1, // +1 for title
      1 // +1 for book title
    );
    let completedItems = 0;

    // Translate book title
    const translatedBookTitle = await this.translator.translateText(
      bookData.title,
      {
        sourceLanguage,
        targetLanguage,
      }
    );
    completedItems++;
    if (onProgress) onProgress(completedItems, totalItems);

    const translatedChapters: TranslatedChapterV2[] = [];

    // Process chapters with concurrency
    const chapterQueue = [...bookData.chapters];
    const inProgress: Promise<void>[] = [];

    const processChapter = async (chapter: ChapterV2, index: number) => {
      // Translate chapter title
      const translatedTitle = await this.translator.translateText(
        chapter.title,
        {
          sourceLanguage,
          targetLanguage,
        }
      );
      completedItems++;
      if (onProgress) onProgress(completedItems, totalItems);

      // Translate text nodes
      const translations = new Map<string, string>();
      const texts = chapter.textNodes.map((n) => n.text);

      const translatedTexts = await this.translator.translateBatch(texts, {
        sourceLanguage,
        targetLanguage,
      });

      for (let i = 0; i < chapter.textNodes.length; i++) {
        translations.set(chapter.textNodes[i].xpath, translatedTexts[i]);
        completedItems++;
        if (onProgress) onProgress(completedItems, totalItems);
      }

      translatedChapters[index] = {
        ...chapter,
        translatedTitle,
        translations,
      };
    };

    // Process with concurrency limit
    for (let i = 0; i < bookData.chapters.length; i++) {
      const promise = processChapter(bookData.chapters[i], i);
      inProgress.push(promise);

      if (inProgress.length >= chapterConcurrency) {
        await Promise.race(inProgress);
        // Remove completed promises
        const completed = inProgress.filter((p) => {
          let resolved = false;
          p.then(() => {
            resolved = true;
          }).catch(() => {
            resolved = true;
          });
          return !resolved;
        });
        inProgress.length = 0;
        inProgress.push(...completed);
      }
    }

    // Wait for remaining
    await Promise.all(inProgress);

    // Sort by original order
    translatedChapters.sort((a, b) => a.number - b.number);

    return {
      metadata: {
        title: translatedBookTitle,
        originalTitle: bookData.title,
        author: bookData.author,
        languagePair: `${sourceLanguage}-${targetLanguage}`,
        styles: bookData.styles || '',
      },
      chapters: translatedChapters,
    };
  }

  /**
   * Process EPUB file: parse and translate with XPath
   */
  async processEPUBV2(
    buffer: ArrayBuffer,
    targetLanguage: string,
    sourceLanguage: string = 'en',
    options?: {
      chapterConcurrency?: number;
      onProgress?: (current: number, total: number) => void;
    }
  ): Promise<ProcessedBookV2> {
    const bookData = await this.parseEPUBV2(buffer);

    const processedBook = await this.translateBookV2(
      bookData,
      targetLanguage,
      sourceLanguage,
      options?.chapterConcurrency || 2,
      options?.onProgress
    );

    return processedBook;
  }
}

export default BookProcessor;
