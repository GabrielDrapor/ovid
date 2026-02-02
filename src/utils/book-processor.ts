/**
 * Book Processor for Worker Environment
 * Handles EPUB parsing and translation in Cloudflare Workers
 */

import { Translator, ParagraphInput } from './translator';
import { detectParagraphType } from './translation/types';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

export interface ContentItem {
  id: string;
  text: string;
  type: string;
  tagName?: string;
  className?: string;
  styles?: string;
}

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

export interface Chapter {
  number: number;
  title: string;
  originalTitle: string;
  content: ContentItem[];
}

export interface BookData {
  title: string;
  originalTitle: string;
  author: string;
  language: string;
  chapters: Chapter[];
  styles?: string;
}

export interface TranslatedContentItem extends ContentItem {
  originalText: string;
  translatedText: string;
}

export interface TranslatedChapter extends Chapter {
  translatedTitle: string;
  content: TranslatedContentItem[];
}

export interface ProcessedBook {
  metadata: {
    title: string;
    originalTitle: string;
    author: string;
    languagePair: string;
    styles: string;
  };
  chapters: TranslatedChapter[];
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
   * Parse EPUB file from buffer
   */
  async parseEPUB(buffer: ArrayBuffer): Promise<BookData> {
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

    // Parse chapters from HTML files
    const chapters: Chapter[] = [];
    let chapterNumber = 1;

    for (const htmlPath of htmlFiles) {
      const file = zipContent.files[htmlPath];
      if (!file) continue;

      const htmlContent = await file.async('text');
      const chapterData = this.parseHTMLChapter(htmlContent, chapterNumber);

      // Extract internal styles
      const doc = new DOMParser().parseFromString(htmlContent, 'text/html');
      const styleTags = doc.getElementsByTagName('style');
      for (let i = 0; i < styleTags.length; i++) {
        const styleContent = styleTags[i].textContent;
        if (styleContent) {
          globalStyles += `/* Internal from ${htmlPath} */\n${styleContent}\n`;
        }
      }

      if (chapterData && chapterData.content.length > 0) {
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
      language: 'en', // Default, can be detected or passed as parameter
      chapters,
      styles: globalStyles,
    };
  }

  /**
   * Parse a single HTML chapter
   */
  private parseHTMLChapter(
    html: string,
    chapterNumber: number
  ): { title: string; originalTitle: string; content: ContentItem[] } | null {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.getElementsByTagName('body')[0];
    if (!body) return null;

    // Try to extract chapter title
    let chapterTitle = `Chapter ${chapterNumber}`;
    const h1 = doc.getElementsByTagName('h1')[0];
    const h2 = doc.getElementsByTagName('h2')[0];
    const h3 = doc.getElementsByTagName('h3')[0];
    const titleTag = doc.getElementsByTagName('title')[0];

    if (h1?.textContent?.trim()) {
      chapterTitle = h1.textContent.trim();
    } else if (h2?.textContent?.trim()) {
      chapterTitle = h2.textContent.trim();
    } else if (h3?.textContent?.trim()) {
      chapterTitle = h3.textContent.trim();
    } else if (titleTag?.textContent?.trim()) {
      chapterTitle = titleTag.textContent.trim();
    }

    const content: ContentItem[] = [];
    let itemIndex = 0;

    // Add chapter title as first item
    content.push({
      id: `t-${chapterNumber}-${itemIndex++}`,
      text: chapterTitle,
      type: 'chapter',
      tagName: 'h3',
    });

    // Extract content from meaningful tags
    const meaningfulTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li'];
    const processedTexts = new Set<string>();

    const extractContent = (element: any) => {
      if (!element) return;

      const tagName = (element.nodeName || '').toLowerCase();

      // Skip script and style tags
      if (tagName === 'script' || tagName === 'style') return;

      if (meaningfulTags.includes(tagName)) {
        const text = (element.textContent || '').trim();

        if (text.length > 5 && !processedTexts.has(text)) {
          const className = element.getAttribute ? element.getAttribute('class') : '';
          const inlineStyle = element.getAttribute ? element.getAttribute('style') : '';

          content.push({
            id: `p-${chapterNumber}-${itemIndex++}`,
            text,
            type: tagName.startsWith('h') ? 'chapter' : 'paragraph',
            tagName,
            className: className || undefined,
            styles: inlineStyle || undefined,
          });

          processedTexts.add(text);
          return; // Don't recurse into processed elements
        }
      }

      // Recurse into children
      const children = element.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          extractContent(children[i]);
        }
      }
    };

    extractContent(body);

    return {
      title: chapterTitle,
      originalTitle: chapterTitle,
      content,
    };
  }

  /**
   * Translate book content
   * @param sequential - Enable sequential mode for higher quality translation
   */
  async translateBook(
    bookData: BookData,
    targetLanguage: string,
    sourceLanguage: string = 'en',
    chapterConcurrency: number = 2,
    onProgress?: (current: number, total: number) => void,
    sequential: boolean = false
  ): Promise<ProcessedBook> {
    if (sequential) {
      // Sequential mode: higher quality with translated context
      return this.translateBookSequential(
        bookData,
        targetLanguage,
        sourceLanguage,
        onProgress
      );
    }

    // Parallel mode (default): faster
    const chaptersToTranslate = bookData.chapters.map((chapter) => ({
      title: chapter.title,
      items: chapter.content.map((item) => item.text),
    }));

    const translatedChapters = await this.translator.translateChapters(
      chaptersToTranslate,
      {
        sourceLanguage,
        targetLanguage,
        chapterConcurrency,
        onProgress: (progress, current, total) => {
          if (onProgress) {
            onProgress(current, total);
          }
        },
      }
    );

    const processedChapters: TranslatedChapter[] = bookData.chapters.map(
      (chapter, idx) => {
        const translated = translatedChapters[idx];
        return {
          ...chapter,
          translatedTitle: translated.title,
          content: chapter.content.map((item, itemIdx) => ({
            ...item,
            originalText: item.text,
            translatedText: translated.items[itemIdx],
          })),
        };
      }
    );

    return {
      metadata: {
        title: bookData.title,
        originalTitle: bookData.title,
        author: bookData.author,
        languagePair: `${sourceLanguage}-${targetLanguage}`,
        styles: bookData.styles || '',
      },
      chapters: processedChapters,
    };
  }

  /**
   * Translate book content sequentially with context.
   * Higher quality mode that uses translated context from preceding paragraphs.
   */
  private async translateBookSequential(
    bookData: BookData,
    targetLanguage: string,
    sourceLanguage: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<ProcessedBook> {
    const processedChapters: TranslatedChapter[] = [];
    let totalItems = bookData.chapters.reduce(
      (sum, ch) => sum + ch.content.length + 1, // +1 for title
      0
    );
    let completedItems = 0;

    for (const chapter of bookData.chapters) {
      // Translate chapter title
      const translatedTitle = await this.translator.translateText(chapter.title, {
        sourceLanguage,
        targetLanguage,
      });
      completedItems++;
      if (onProgress) {
        onProgress(completedItems, totalItems);
      }

      // Convert content to ParagraphInput format
      const paragraphInputs: ParagraphInput[] = chapter.content.map((item, idx) => ({
        id: item.id || `p_${idx}`,
        text: item.text,
        type: item.type,
        tagName: item.tagName,
        className: item.className,
      }));

      // Translate content sequentially
      const translatedItems = await this.translator.translateSequential(
        paragraphInputs,
        {
          sourceLanguage,
          targetLanguage,
          sequential: true,
          contextBefore: 2,
          contextAfter: 2,
          delayBetweenCalls: 300, // Shorter delay for Worker
          onProgress: (progress, current, total) => {
            if (onProgress) {
              onProgress(completedItems + current, totalItems);
            }
          },
        }
      );

      completedItems += chapter.content.length;

      processedChapters.push({
        ...chapter,
        translatedTitle,
        content: chapter.content.map((item, idx) => ({
          ...item,
          originalText: item.text,
          translatedText: translatedItems[idx],
        })),
      });
    }

    return {
      metadata: {
        title: bookData.title,
        originalTitle: bookData.title,
        author: bookData.author,
        languagePair: `${sourceLanguage}-${targetLanguage}`,
        styles: bookData.styles || '',
      },
      chapters: processedChapters,
    };
  }

  /**
   * Process EPUB file: parse and translate
   */
  async processEPUB(
    buffer: ArrayBuffer,
    targetLanguage: string,
    sourceLanguage: string = 'en',
    options?: {
      chapterConcurrency?: number;
      onProgress?: (current: number, total: number) => void;
      /** Enable sequential translation for higher quality */
      sequential?: boolean;
    }
  ): Promise<ProcessedBook> {
    // Parse EPUB
    const bookData = await this.parseEPUB(buffer);

    // Translate content
    const processedBook = await this.translateBook(
      bookData,
      targetLanguage,
      sourceLanguage,
      options?.chapterConcurrency || 2,
      options?.onProgress,
      options?.sequential || false
    );

    return processedBook;
  }

  // ==================
  // V2 Methods (XPath-based)
  // ==================

  /**
   * Parse EPUB file with XPath-based extraction (V2)
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
   * Parse a single HTML chapter with XPath extraction (V2)
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

    // Try to extract chapter title
    let chapterTitle = `Chapter ${chapterNumber}`;
    const h1 = doc.getElementsByTagName('h1')[0];
    const h2 = doc.getElementsByTagName('h2')[0];
    const h3 = doc.getElementsByTagName('h3')[0];
    const titleTag = doc.getElementsByTagName('title')[0];

    if (h1?.textContent?.trim()) {
      chapterTitle = h1.textContent.trim();
    } else if (h2?.textContent?.trim()) {
      chapterTitle = h2.textContent.trim();
    } else if (h3?.textContent?.trim()) {
      chapterTitle = h3.textContent.trim();
    } else if (titleTag?.textContent?.trim()) {
      chapterTitle = titleTag.textContent.trim();
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

    // Recursive walk to extract from block elements
    const walkNode = (node: any) => {
      if (!node) return;

      const nodeType = node.nodeType;
      if (nodeType !== 1) return; // Only process ELEMENT_NODE

      const tagName = (node.nodeName || '').toLowerCase();
      if (skipTags.has(tagName)) return;

      if (blockTags.has(tagName)) {
        const fullText = decodeEntities(getFullTextContent(node));
        if (fullText.length >= 2) {
          // Generate XPath
          tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
          const xpath = `/body[1]/${tagName}[${tagCounts[tagName]}]`;

          textNodes.push({
            xpath,
            text: fullText,
            html: getInnerHtml(node),
            orderIndex: orderIndex++,
          });
        }
        return; // Don't recurse into block elements
      }

      // Recurse into children
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          walkNode(children[i]);
        }
      }
    };

    // Walk body children
    for (let i = 0; i < bodyChildren.length; i++) {
      walkNode(bodyChildren[i]);
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
   * Translate book content (V2 - XPath based)
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
      0
    );
    let completedItems = 0;

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
        title: bookData.title,
        originalTitle: bookData.title,
        author: bookData.author,
        languagePair: `${sourceLanguage}-${targetLanguage}`,
        styles: bookData.styles || '',
      },
      chapters: translatedChapters,
    };
  }

  /**
   * Process EPUB file V2: parse and translate with XPath
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
