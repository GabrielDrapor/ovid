/**
 * Book parsing for Railway service.
 * Ported from src/utils/book-processor.ts — parsing only, no translation.
 * Runs in Node.js (not CF Worker) so no CPU time limits.
 */

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

// ---- Types (mirrored from book-processor.ts) ----

export interface ContentItemV2 {
  xpath: string;
  text: string;
  html: string;
  orderIndex: number;
}

export interface ChapterV2 {
  number: number;
  title: string;
  originalTitle: string;
  rawHtml: string;
  textNodes: ContentItemV2[];
}

export interface EpubImage {
  zipPath: string;
  filename: string;
  mediaType: string;
  data: Uint8Array;
}

export interface BookDataV2 {
  title: string;
  originalTitle: string;
  author: string;
  language: string;
  chapters: ChapterV2[];
  styles?: string;
  images?: EpubImage[];
}

// ---- Helpers ----

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

  // Strip internal <a> links
  if (tagName === 'a') {
    const href = node.getAttribute?.('href');
    if (!href || !href.startsWith('http')) return inner;
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

// ---- Chapter parsing ----

const blockTags = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'pre', 'td', 'th', 'dt', 'dd',
  'figcaption', 'article', 'section',
]);

const skipTags = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link']);

function parseHTMLChapter(
  html: string,
  chapterNumber: number,
): { title: string; originalTitle: string; rawHtml: string; textNodes: ContentItemV2[] } | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.getElementsByTagName('body')[0];
  if (!body) return null;

  let rawHtml = '';
  const bodyChildren = body.childNodes;
  for (let i = 0; i < bodyChildren.length; i++) {
    const child = bodyChildren[i];
    if (child.nodeType === 1) rawHtml += serializeNode(child);
    else if (child.nodeType === 3 && child.textContent?.trim()) rawHtml += child.textContent;
  }

  // Extract chapter title
  let chapterTitle = '';
  const h1 = doc.getElementsByTagName('h1')[0];
  const h2 = doc.getElementsByTagName('h2')[0];
  const h3 = doc.getElementsByTagName('h3')[0];
  if (h1?.textContent?.trim()) chapterTitle = h1.textContent.trim();
  else if (h2?.textContent?.trim()) chapterTitle = h2.textContent.trim();
  else if (h3?.textContent?.trim()) chapterTitle = h3.textContent.trim();

  // Extract text nodes with XPath
  const textNodes: ContentItemV2[] = [];
  let orderIndex = 0;

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

  const walkNode = (node: any, pathSegments: string[]) => {
    if (!node || node.nodeType !== 1) return;

    const tagName = (node.nodeName || '').toLowerCase();
    if (skipTags.has(tagName)) return;

    let elementIndex = 1;
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && (sibling.nodeName || '').toLowerCase() === tagName) elementIndex++;
      sibling = sibling.previousSibling;
    }

    const currentPath = [...pathSegments, `${tagName}[${elementIndex}]`];

    if (blockTags.has(tagName)) {
      if (hasChildBlockElements(node)) {
        const children = node.childNodes;
        if (children) {
          for (let i = 0; i < children.length; i++) walkNode(children[i], currentPath);
        }
        return;
      }

      const fullText = decodeEntities(getFullTextContent(node));
      if (fullText.length >= 2) {
        textNodes.push({
          xpath: '/' + currentPath.join('/'),
          text: fullText,
          html: getInnerHtml(node),
          orderIndex: orderIndex++,
        });
      }
      return;
    }

    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) walkNode(children[i], currentPath);
    }
  };

  for (let i = 0; i < bodyChildren.length; i++) {
    walkNode(bodyChildren[i], ['body[1]']);
  }

  // Derive title from short blocks if no heading
  if (!chapterTitle) {
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
          let hasChildBlocks = false;
          const grandchildren = child.childNodes;
          if (grandchildren) {
            for (let j = 0; j < grandchildren.length; j++) {
              if (grandchildren[j].nodeType === 1 && blockTags.has((grandchildren[j].nodeName || '').toLowerCase())) {
                hasChildBlocks = true;
                break;
              }
            }
          }
          if (hasChildBlocks) { scanForHeadings(child); continue; }
          const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length >= 1 && text.length <= 50) headingParts.push(text);
          else if (text.length > 50) { stopScanning = true; return; }
        } else {
          scanForHeadings(child);
        }
      }
    };
    scanForHeadings(body);
    chapterTitle = headingParts.join(' \u2013 ') || `Chapter ${chapterNumber}`;
  }

  return { title: chapterTitle, originalTitle: chapterTitle, rawHtml, textNodes };
}

// ---- Public API ----

/**
 * Parse an EPUB file into BookDataV2.
 */
export async function parseEPUB(buffer: ArrayBuffer | Buffer): Promise<BookDataV2> {
  const zip = new JSZip();
  const zipContent = await zip.loadAsync(buffer);

  const opfFile = Object.keys(zipContent.files).find((name) => name.endsWith('.opf'));

  let title = 'Unknown Title';
  let author = 'Unknown Author';
  let htmlFiles: string[] = [];
  let globalStyles = '';
  let imageManifestEntries: { href: string; mediaType: string }[] = [];

  if (opfFile) {
    const opfContent = await zipContent.files[opfFile].async('text');
    const doc = new DOMParser().parseFromString(opfContent, 'text/xml');

    const titleElement = doc.getElementsByTagName('dc:title')[0];
    const authorElement = doc.getElementsByTagName('dc:creator')[0];
    if (titleElement?.textContent) title = titleElement.textContent.trim();
    if (authorElement?.textContent) author = authorElement.textContent.trim();

    const manifestElements = doc.getElementsByTagName('item');
    const manifestMap = new Map<string, string>();
    imageManifestEntries = [];

    for (let i = 0; i < manifestElements.length; i++) {
      const item = manifestElements[i];
      const mediaType = item.getAttribute('media-type');
      const href = item.getAttribute('href');
      const id = item.getAttribute('id');

      // CSS
      if (mediaType === 'text/css' && href) {
        try {
          const basePath = opfFile.substring(0, opfFile.lastIndexOf('/') + 1);
          const cssPath = basePath + href;
          const cssFile = zipContent.files[cssPath];
          if (cssFile) {
            const cssContent = await cssFile.async('text');
            globalStyles += `/* ${href} */\n${cssContent}\n`;
          }
        } catch { /* skip */ }
      }

      // HTML manifest
      if (id && href && mediaType === 'application/xhtml+xml') {
        manifestMap.set(id, href);
      }

      // Images
      if (href && mediaType && mediaType.startsWith('image/')) {
        imageManifestEntries.push({ href, mediaType });
      }
    }

    // Spine order
    const spineItems = doc.getElementsByTagName('itemref');
    for (let i = 0; i < spineItems.length; i++) {
      const idref = spineItems[i].getAttribute('idref');
      if (idref && manifestMap.has(idref)) {
        const href = manifestMap.get(idref)!;
        const basePath = opfFile.substring(0, opfFile.lastIndexOf('/') + 1);
        const fullPath = href.startsWith('/') ? href.substring(1) : basePath + href;
        htmlFiles.push(fullPath);
      }
    }
  }

  // Parse chapters
  const chapters: ChapterV2[] = [];
  let chapterNumber = 1;

  for (const htmlPath of htmlFiles) {
    const file = zipContent.files[htmlPath];
    if (!file) continue;

    const htmlContent = await file.async('text');
    const chapterData = parseHTMLChapter(htmlContent, chapterNumber);

    // Collect internal styles
    const doc = new DOMParser().parseFromString(htmlContent, 'text/html');
    const styleTags = doc.getElementsByTagName('style');
    for (let i = 0; i < styleTags.length; i++) {
      const styleContent = styleTags[i].textContent;
      if (styleContent) globalStyles += `/* Internal from ${htmlPath} */\n${styleContent}\n`;
    }

    if (chapterData && chapterData.textNodes.length > 0) {
      chapters.push({ ...chapterData, number: chapterNumber++ });
    }
  }

  // Extract images
  const images: EpubImage[] = [];
  const basePath = opfFile ? opfFile.substring(0, opfFile.lastIndexOf('/') + 1) : '';
  for (const entry of imageManifestEntries) {
    const imgPath = entry.href.startsWith('/') ? entry.href.substring(1) : basePath + entry.href;
    const imgFile = zipContent.files[imgPath];
    if (imgFile) {
      try {
        const data = await imgFile.async('uint8array');
        const filename = entry.href.split('/').pop() || entry.href;
        images.push({ zipPath: imgPath, filename, mediaType: entry.mediaType, data });
      } catch { /* skip */ }
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
 * Parse a MOBI/AZW3 file into BookDataV2.
 */
export async function parseMOBI(buffer: ArrayBuffer | Buffer, fileExtension: string): Promise<BookDataV2> {
  // Dynamic import — @lingo-reader/mobi-parser may not be installed
  let initMobiFile: any, initKf8File: any;
  try {
    // @ts-ignore — optional dependency, may not be installed
    const mod = await import('@lingo-reader/mobi-parser');
    initMobiFile = mod.initMobiFile;
    initKf8File = mod.initKf8File;
  } catch {
    throw new Error('MOBI/AZW3 parsing not supported — @lingo-reader/mobi-parser not installed');
  }
  const uint8 = buffer instanceof Buffer ? new Uint8Array(buffer) : new Uint8Array(buffer);

  const isKf8 = fileExtension === '.azw3';

  if (isKf8) {
    try {
      const parser = await initKf8File(uint8);
      const result = parseMOBIInternal(parser);
      if (result.chapters.length >= 1) return result;
      parser.destroy();
    } catch { /* fall through to MOBI parser */ }
  }

  const parser = await initMobiFile(uint8);
  return parseMOBIInternal(parser);
}

function parseMOBIInternal(parser: any): BookDataV2 {
  const metadata = parser.getMetadata();
  const spine = parser.getSpine();

  const title = metadata.title || 'Unknown Title';
  const author = (metadata.author && metadata.author.length > 0)
    ? metadata.author.join(', ')
    : 'Unknown Author';

  const chapters: ChapterV2[] = [];
  let chapterNumber = 1;

  for (const spineItem of spine) {
    let loaded;
    try {
      loaded = parser.loadChapter(spineItem.id);
    } catch { continue; }
    if (!loaded) continue;

    const html = loaded.html;
    if (!html || !html.trim()) continue;

    const cleanedHtml = html.replace(
      /<a\s+[^>]*href\s*=\s*["'](?:filepos:|kindle:|#)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
      '$1'
    );

    const wrappedHtml = `<html><body>${cleanedHtml}</body></html>`;
    const chapterData = parseHTMLChapter(wrappedHtml, chapterNumber);

    if (chapterData && chapterData.textNodes.length > 0) {
      chapters.push({ ...chapterData, number: chapterNumber++ });
    }
  }

  parser.destroy();

  return {
    title,
    originalTitle: title,
    author,
    language: metadata.language || 'en',
    chapters,
    styles: '',
  };
}

/**
 * Parse any supported book format.
 */
export async function parseBook(buffer: ArrayBuffer | Buffer, fileExtension: string): Promise<BookDataV2> {
  if (fileExtension === '.epub') return parseEPUB(buffer);
  return parseMOBI(buffer, fileExtension);
}
