/**
 * Book Processor for Worker Environment
 * Handles EPUB parsing and translation in Cloudflare Workers
 */

import { Translator } from './translator';

const JSZip = require('jszip');
const { DOMParser } = require('xmldom');

export interface ContentItem {
  id: string;
  text: string;
  type: string;
  tagName?: string;
  className?: string;
  styles?: string;
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

  constructor(concurrency: number = 8) {
    this.translator = new Translator({ concurrency });
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
   */
  async translateBook(
    bookData: BookData,
    targetLanguage: string,
    sourceLanguage: string = 'en',
    chapterConcurrency: number = 2,
    onProgress?: (current: number, total: number) => void
  ): Promise<ProcessedBook> {
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
   * Process EPUB file: parse and translate
   */
  async processEPUB(
    buffer: ArrayBuffer,
    targetLanguage: string,
    sourceLanguage: string = 'en',
    options?: {
      chapterConcurrency?: number;
      onProgress?: (current: number, total: number) => void;
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
      options?.onProgress
    );

    return processedBook;
  }
}

export default BookProcessor;
