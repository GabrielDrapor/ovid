// EPUB Parser utilities for extracting Japanese text
import * as fs from 'fs';
import * as path from 'path';
const { DOMParser } = require('xmldom');
import { promisify } from 'util';

export interface BilingualContent {
  id: string;
  original: string;
  translated: string;
  type: 'title' | 'chapter' | 'paragraph';
}

export interface EPUBParseResult {
  title: string;
  author: string;
  chapters: Array<{
    id: string;
    title: string;
    content: string;
  }>;
}

export class EPUBParser {
  private static isNavigationOrCopyright(text: string): boolean {
    const lowerText = text.toLowerCase().trim();

    // Navigation/copyright indicators
    const indicators = [
      'table of contents',
      'contents',
      'chapter',
      'section',
      'copyright',
      '©',
      'all rights reserved',
      'license',
      'legal',
      'disclaimer',
      'imprint',
      'impressum',
      'publisher',
      'previous',
      'next',
      'back',
      'forward',
      'home',
      'page',
      'pg.',
      'cover',
      'title page',
      'index',
    ];

    // Check if text is likely navigation/copyright
    const isShortNav =
      lowerText.length < 50 &&
      indicators.some((ind) => lowerText.includes(ind));
    const isCopyrightBlock =
      lowerText.length < 300 &&
      (lowerText.includes('copyright') ||
        lowerText.includes('©') ||
        lowerText.includes('all rights reserved'));

    return isShortNav || isCopyrightBlock;
  }

  private static extractTextFromHTML(html: string): {
    title: string;
    styles: string;
    content: Array<{
      type: 'chapter' | 'paragraph';
      content: string;
      className?: string;
      tagName?: string;
      styles?: string;
    }>;
  } {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc) return { title: '', styles: '', content: [] };

      // Extract title from the <title> tag
      const titleTag = doc.getElementsByTagName('title')[0];
      const title =
        titleTag && titleTag.textContent ? titleTag.textContent.trim() : '';

      // Extract CSS styles from <style> tags
      let styles = '';
      const styleTags = doc.getElementsByTagName('style');
      for (let i = 0; i < styleTags.length; i++) {
        const styleContent = styleTags[i].textContent;
        if (styleContent) {
          styles += styleContent.trim() + '\n';
        }
      }

      const body = doc.getElementsByTagName('body')[0];
      if (!body) return { title, styles, content: [] };

      const content: Array<{
        type: 'chapter' | 'paragraph';
        content: string;
        className?: string;
        tagName?: string;
        styles?: string;
      }> = [];
      const processedTexts = new Set<string>(); // Prevent duplicate content

      const shouldSkipElement = (element: Element): boolean => {
        const tagName = element.tagName.toLowerCase();
        const className = (element.getAttribute('class') || '').toLowerCase();
        const id = (element.getAttribute('id') || '').toLowerCase();

        // Skip non-content elements
        if (
          ['script', 'style', 'nav', 'header', 'footer', 'aside'].includes(
            tagName
          )
        ) {
          return true;
        }

        // Skip navigation/copyright containers
        const skipIndicators = [
          'nav',
          'navigation',
          'toc',
          'table-of-contents',
          'menu',
          'sidebar',
          'copyright',
          'license',
          'legal',
          'disclaimer',
          'footer',
          'header',
          'breadcrumb',
          'pagination',
          'prev',
          'next',
          'index',
          'cover',
        ];

        return skipIndicators.some(
          (indicator) => className.includes(indicator) || id.includes(indicator)
        );
      };

      const extractTextFromElement = (element: Element): void => {
        if (shouldSkipElement(element)) {
          return;
        }

        const tagName = element.tagName.toLowerCase();
        const text = element.textContent?.trim();

        if (!text || text.length < 2) return; // Skip empty or very short content

        // Skip if this exact text was already processed
        if (processedTexts.has(text)) return;

        // Skip navigation/copyright content
        if (this.isNavigationOrCopyright(text)) return;

        // Determine content type based on tag and context
        let type: 'chapter' | 'paragraph' = 'paragraph';
        if (tagName.match(/^h[1-6]$/)) {
          type = 'chapter';
        }

        // Check for letter-related classes and handle nested structures
        const className = (element.getAttribute('class') || '').toLowerCase();
        const parent = element.parentElement;
        const parentClass = parent
          ? (parent.getAttribute('class') || '').toLowerCase()
          : '';

        const isLetterComponent =
          className.includes('letter') ||
          parentClass.includes('letter') ||
          className.includes('letter-') ||
          parentClass.includes('letter-') ||
          (tagName === 'div' &&
            (className.includes('letter') || parentClass.includes('letter')));

        // Include letter components and meaningful content
        const meaningfulTags = [
          'p',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'li',
          'dt',
          'dd',
          'blockquote',
          'pre',
          'address',
          'caption',
          'figcaption',
          'div',
        ];

        const meaningfulClasses = [
          'letter',
          'telegram',
          'note',
          'message',
          'quote',
          'dialogue',
          'poem',
          'verse',
          'monologue',
          'speech',
          'letter-address',
          'letter-block',
          'letter-signature',
        ];

        const hasMeaningfulClass = meaningfulClasses.some(
          (cls) => className.includes(cls) || parentClass.includes(cls)
        );

        // Always include letter-related content and meaningful elements
        if (
          isLetterComponent ||
          meaningfulTags.includes(tagName) ||
          hasMeaningfulClass ||
          text.length >= 5
        ) {
          // Add content with styling information
          const contentItem: {
            type: 'chapter' | 'paragraph';
            content: string;
            className?: string;
            tagName?: string;
            styles?: string;
          } = {
            type,
            content: text,
            tagName: tagName,
          };

          // Add class name if present
          if (className) {
            contentItem.className = className;
          }

          // Add inline styles if present
          const inlineStyle = element.getAttribute('style');
          if (inlineStyle) {
            contentItem.styles = inlineStyle;
          }

          content.push(contentItem);
          processedTexts.add(text);
        }
      };

      // Process elements in document order to maintain proper sequence
      const processElementsInOrder = () => {
        // Get all relevant elements in document order
        const allElements = body.getElementsByTagName('*');
        const elementsToProcess: Element[] = [];

        for (let i = 0; i < allElements.length; i++) {
          const element = allElements[i] as Element;
          const tagName = element.tagName.toLowerCase();
          const className = (element.getAttribute('class') || '').toLowerCase();

          // Check if this is an element we want to process
          const isHeader = tagName.match(/^h[1-6]$/);
          const isParagraph = tagName === 'p';
          const isDivWithMeaningfulClass =
            tagName === 'div' &&
            [
              'letter',
              'telegram',
              'note',
              'message',
              'quote',
              'dialogue',
              'poem',
              'verse',
              'monologue',
              'speech',
              'letter-address',
              'letter-block',
              'letter-signature',
            ].some((cls) => className.includes(cls));

          if (isHeader || isParagraph || isDivWithMeaningfulClass) {
            elementsToProcess.push(element);
          }
        }

        // Process elements in document order
        for (const element of elementsToProcess) {
          const tagName = element.tagName.toLowerCase();
          const text = element.textContent?.trim();

          if (!text || text.length < 2) continue;
          if (processedTexts.has(text)) continue;
          if (this.isNavigationOrCopyright(text)) continue;

          const className = (element.getAttribute('class') || '').toLowerCase();

          // Determine content type
          let type: 'chapter' | 'paragraph' = 'paragraph';
          if (tagName.match(/^h[1-6]$/)) {
            type = 'chapter';
          }

          const contentItem: {
            type: 'chapter' | 'paragraph';
            content: string;
            className?: string;
            tagName?: string;
            styles?: string;
          } = {
            type,
            content: text,
            tagName: tagName,
          };

          if (className) {
            contentItem.className = className;
          }

          const inlineStyle = element.getAttribute('style');
          if (inlineStyle) {
            contentItem.styles = inlineStyle;
          }

          content.push(contentItem);
          processedTexts.add(text);
        }
      };

      processElementsInOrder();

      return { title, styles, content };
    } catch (error) {
      console.error('Error parsing HTML:', error);
      return { title: '', styles: '', content: [] };
    }
  }

  private static async extractEPUBContent(filePath: string): Promise<{
    title: string;
    author: string;
    htmlFiles: string[];
  }> {
    const JSZip = require('jszip');
    const zip = new JSZip();

    const fileBuffer = fs.readFileSync(filePath);
    const zipContent = await zip.loadAsync(fileBuffer);

    let title = 'Unknown Title';
    let author = 'Unknown Author';
    let htmlFiles: string[] = [];

    // Try to find and parse the OPF file
    const opfFile = Object.keys(zipContent.files).find((name) =>
      name.endsWith('.opf')
    );

    if (opfFile) {
      const opfContent = await zipContent.files[opfFile].async('text');
      const doc = new DOMParser().parseFromString(opfContent, 'text/xml');

      if (doc) {
        // Extract title and author
        const titleElement = doc.getElementsByTagName('dc:title')[0];
        const authorElement = doc.getElementsByTagName('dc:creator')[0];

        if (titleElement && titleElement.textContent) {
          title = titleElement.textContent.trim();
        }
        if (authorElement && authorElement.textContent) {
          author = authorElement.textContent.trim();
        }

        // Extract reading order from spine
        const manifestItems = new Map<string, string>();
        const manifestElements = doc.getElementsByTagName('item');

        // Build manifest map: id -> href
        for (let i = 0; i < manifestElements.length; i++) {
          const item = manifestElements[i];
          const id = item.getAttribute('id');
          const href = item.getAttribute('href');
          const mediaType = item.getAttribute('media-type');

          if (id && href && mediaType === 'application/xhtml+xml') {
            manifestItems.set(id, href);
          }
        }

        // Get spine order
        const spineItems = doc.getElementsByTagName('itemref');
        const orderedFiles: string[] = [];

        for (let i = 0; i < spineItems.length; i++) {
          const itemref = spineItems[i];
          const idref = itemref.getAttribute('idref');

          if (idref && manifestItems.has(idref)) {
            const href = manifestItems.get(idref)!;
            // Add directory path if needed
            const basePath = opfFile.substring(0, opfFile.lastIndexOf('/') + 1);
            const fullPath = href.startsWith('/')
              ? href.substring(1)
              : basePath + href;
            orderedFiles.push(fullPath);
          }
        }

        htmlFiles = orderedFiles;
      }
    }

    // Fallback: if OPF parsing failed, use numerical sorting
    if (htmlFiles.length === 0) {
      htmlFiles = Object.keys(zipContent.files)
        .filter((name) => name.match(/\.(x?html?)$/i))
        .sort((a, b) => {
          const aMatch = a.match(/(\d+)\.x?html?$/i);
          const bMatch = b.match(/(\d+)\.x?html?$/i);

          if (aMatch && bMatch) {
            const aNum = parseInt(aMatch[1]);
            const bNum = parseInt(bMatch[1]);
            return aNum - bNum;
          }

          return a.localeCompare(b);
        });
    }

    return { title, author, htmlFiles };
  }

  public static async parseEPUBToStructured(filePath: string): Promise<{
    title: string;
    author: string;
    styles: string;
    content: Array<{
      id: string;
      type: 'title' | 'chapter' | 'paragraph';
      content: string;
      className?: string;
      tagName?: string;
      styles?: string;
    }>;
  }> {
    const JSZip = require('jszip');
    const zip = new JSZip();

    const fileBuffer = fs.readFileSync(filePath);
    const zipContent = await zip.loadAsync(fileBuffer);

    const {
      title: opfTitle,
      author,
      htmlFiles,
    } = await this.extractEPUBContent(filePath);

    // htmlFiles are already in proper reading order from OPF spine
    const structuredContent: Array<{
      id: string;
      type: 'title' | 'chapter' | 'paragraph';
      content: string;
      className?: string;
      tagName?: string;
      styles?: string;
    }> = [];

    let bookTitle: string | null = null;
    let contentId = 1;
    let allStyles = '';

    for (let i = 0; i < htmlFiles.length; i++) {
      const fileName = htmlFiles[i];
      const file = zipContent.files[fileName];

      if (file) {
        const htmlContent = await file.async('text');
        const {
          title: pageTitle,
          styles: pageStyles,
          content: pageContent,
        } = this.extractTextFromHTML(htmlContent);

        // Collect CSS styles from all pages
        if (pageStyles) {
          allStyles += `/* Styles from ${fileName} */\n${pageStyles}\n`;
        }

        if (pageTitle && !bookTitle) {
          bookTitle = pageTitle;
        }

        pageContent.forEach((item) => {
          structuredContent.push({
            id: `content-${contentId++}`,
            type: item.type,
            content: item.content,
            className: item.className,
            tagName: item.tagName,
            styles: item.styles,
          });
        });
      }
    }

    const finalTitle = bookTitle || opfTitle;

    return {
      title: finalTitle,
      author,
      styles: allStyles,
      content: structuredContent,
    };
  }
}
