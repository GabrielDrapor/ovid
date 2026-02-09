/**
 * Book Processor for Worker Environment
 * Handles EPUB parsing and translation in Cloudflare Workers (XPath-based V2)
 */

import { Translator } from './translator';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

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

export interface BookDataV2 {
  title: string;
  originalTitle: string;
  author: string;
  language: string;
  chapters: ChapterV2[];
  styles?: string;
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

      // Build manifest map and get spine order
      const manifestMap = new Map<string, string>();
      for (let i = 0; i < manifestElements.length; i++) {
        const item = manifestElements[i];
        const id = item.getAttribute('id');
        const href = item.getAttribute('href');
        const mediaType = item.getAttribute('media-type');

        if (id && href && mediaType === 'application/xhtml+xml') {
          manifestMap.set(id, href);
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

    // Parse chapters from HTML files with XPath extraction
    const chapters: ChapterV2[] = [];
    let chapterNumber = 1;

    for (const htmlPath of htmlFiles) {
      const file = zipContent.files[htmlPath];
      if (!file) continue;

      const htmlContent = await file.async('text');
      const chapterData = this.parseHTMLChapterV2(htmlContent, chapterNumber);

      // Extract internal styles
      const doc = new DOMParser().parseFromString(htmlContent, 'text/html');
      const styleTags = doc.getElementsByTagName('style');
      for (let i = 0; i < styleTags.length; i++) {
        const styleContent = styleTags[i].textContent;
        if (styleContent) {
          globalStyles += `/* Internal from ${htmlPath} */\n${styleContent}\n`;
        }
      }

      if (chapterData && chapterData.textNodes.length > 0) {
        chapters.push({
          ...chapterData,
          number: chapterNumber++,
        });
      }
    }

    return {
      title,
      originalTitle: title,
      author,
      language: 'en',
      chapters,
      styles: globalStyles,
    };
  }

  /**
   * Parse a single HTML chapter with XPath extraction
   */
  private parseHTMLChapterV2(
    html: string,
    chapterNumber: number
  ): { title: string; originalTitle: string; rawHtml: string; textNodes: ContentItemV2[] } | null {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.getElementsByTagName('body')[0];
    if (!body) return null;

    // Extract body content as rawHtml
    let rawHtml = '';
    const bodyChildren = body.childNodes;
    for (let i = 0; i < bodyChildren.length; i++) {
      const child = bodyChildren[i];
      if (child.nodeType === 1) { // ELEMENT_NODE
        rawHtml += this.serializeNode(child);
      } else if (child.nodeType === 3 && child.textContent?.trim()) { // TEXT_NODE
        rawHtml += child.textContent;
      }
    }

    // Try to extract chapter title from heading tags
    let chapterTitle = '';
    const h1 = doc.getElementsByTagName('h1')[0];
    const h2 = doc.getElementsByTagName('h2')[0];
    const h3 = doc.getElementsByTagName('h3')[0];

    if (h1?.textContent?.trim()) {
      chapterTitle = h1.textContent.trim();
    } else if (h2?.textContent?.trim()) {
      chapterTitle = h2.textContent.trim();
    } else if (h3?.textContent?.trim()) {
      chapterTitle = h3.textContent.trim();
    }

    // Extract text nodes with XPath
    const textNodes: ContentItemV2[] = [];
    const tagCounts: Record<string, number> = {};
    let orderIndex = 0;

    // Block-level elements to extract text from
    const blockTags = new Set([
      'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'blockquote', 'pre', 'td', 'th', 'dt', 'dd',
      'figcaption', 'article', 'section'
    ]);

    const skipTags = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link']);

    // Helper to decode HTML entities
    const decodeEntities = (text: string): string => {
      return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
        .replace(/\s+/g, ' ')
        .trim();
    };

    // Helper to get full text content
    const getFullTextContent = (node: any): string => {
      let text = '';
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child.nodeType === 3) { // TEXT_NODE
            text += child.textContent || '';
          } else if (child.nodeType === 1) { // ELEMENT_NODE
            text += getFullTextContent(child);
          }
        }
      }
      return text;
    };

    // Helper to get innerHTML (preserves formatting tags)
    const getInnerHtml = (node: any): string => {
      let html = '';
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child.nodeType === 3) { // TEXT_NODE
            html += child.textContent || '';
          } else if (child.nodeType === 1) { // ELEMENT_NODE
            html += this.serializeNode(child);
          }
        }
      }
      return html;
    };

    // Check if a node contains any child block elements (direct or nested)
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

    // Recursive walk to extract from block elements
    // pathSegments tracks the full XPath from body to build hierarchical paths
    // matching exactly how the reader's walkAndMap builds paths
    const walkNode = (node: any, pathSegments: string[]) => {
      if (!node) return;

      const nodeType = node.nodeType;
      if (nodeType !== 1) return; // Only process ELEMENT_NODE

      const tagName = (node.nodeName || '').toLowerCase();
      if (skipTags.has(tagName)) return;

      // Count element index among siblings of same tag name
      let elementIndex = 1;
      let sibling = node.previousSibling;
      while (sibling) {
        if (sibling.nodeType === 1 && (sibling.nodeName || '').toLowerCase() === tagName) {
          elementIndex++;
        }
        sibling = sibling.previousSibling;
      }

      const currentPath = [...pathSegments, `${tagName}[${elementIndex}]`];

      if (blockTags.has(tagName)) {
        // If this block contains child blocks, recurse into them
        if (hasChildBlockElements(node)) {
          const children = node.childNodes;
          if (children) {
            for (let i = 0; i < children.length; i++) {
              walkNode(children[i], currentPath);
            }
          }
          return;
        }

        const fullText = decodeEntities(getFullTextContent(node));
        if (fullText.length >= 2) {
          const xpath = '/' + currentPath.join('/');

          textNodes.push({
            xpath,
            text: fullText,
            html: getInnerHtml(node),
            orderIndex: orderIndex++,
          });
        }
        return; // Don't recurse into leaf block elements
      }

      // Recurse into children for non-block elements
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          walkNode(children[i], currentPath);
        }
      }
    };

    // Walk body children
    for (let i = 0; i < bodyChildren.length; i++) {
      walkNode(bodyChildren[i], ['body[1]']);
    }

    // If no heading tag found, derive title from first short block elements
    if (!chapterTitle) {
      const headingParts: string[] = [];
      let stopScanning = false;
      // Walk block elements looking for short heading-like text
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
            // Check if this block has child blocks (container) - recurse into it
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
            if (hasChildBlocks) {
              scanForHeadings(child);
              continue;
            }
            const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length >= 1 && text.length <= 50) {
              headingParts.push(text);
            } else if (text.length > 50) {
              stopScanning = true;
              return;
            }
          } else {
            scanForHeadings(child);
          }
        }
      };
      scanForHeadings(body);
      chapterTitle = headingParts.join(' \u2013 ') || `Chapter ${chapterNumber}`;
    }

    return {
      title: chapterTitle,
      originalTitle: chapterTitle,
      rawHtml,
      textNodes,
    };
  }

  /**
   * Serialize a DOM node to string
   */
  private serializeNode(node: any): string {
    if (node.nodeType === 3) { // TEXT_NODE
      return node.textContent || '';
    }
    if (node.nodeType !== 1) return ''; // Only serialize ELEMENT_NODE

    const tagName = (node.nodeName || 'div').toLowerCase();
    let attrs = '';

    // Serialize attributes
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i];
        attrs += ` ${attr.name}="${attr.value}"`;
      }
    }

    // Get inner content
    let inner = '';
    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) {
        inner += this.serializeNode(children[i]);
      }
    }

    // Self-closing tags
    const selfClosing = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
    if (selfClosing.has(tagName)) {
      return `<${tagName}${attrs}/>`;
    }

    return `<${tagName}${attrs}>${inner}</${tagName}>`;
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
    const translatedBookTitle = await this.translator.translateText(bookData.title, {
      sourceLanguage,
      targetLanguage,
    });
    completedItems++;
    if (onProgress) onProgress(completedItems, totalItems);

    const translatedChapters: TranslatedChapterV2[] = [];

    // Process chapters with concurrency
    const chapterQueue = [...bookData.chapters];
    const inProgress: Promise<void>[] = [];

    const processChapter = async (chapter: ChapterV2, index: number) => {
      // Translate chapter title
      const translatedTitle = await this.translator.translateText(chapter.title, {
        sourceLanguage,
        targetLanguage,
      });
      completedItems++;
      if (onProgress) onProgress(completedItems, totalItems);

      // Translate text nodes
      const translations = new Map<string, string>();
      const texts = chapter.textNodes.map(n => n.text);

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
        const completed = inProgress.filter(p => {
          let resolved = false;
          p.then(() => { resolved = true; }).catch(() => { resolved = true; });
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
