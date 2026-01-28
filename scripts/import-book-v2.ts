#!/usr/bin/env ts-node

/**
 * Ovid Book Import V2
 *
 * New architecture: Preserves original EPUB HTML and uses XPath for translations
 * This approach ensures 100% fidelity to the original EPUB formatting.
 *
 * Usage:
 *   ts-node scripts/import-book-v2.ts --file="book.epub" --target="zh"
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// Ensure Wrangler writes config/logs inside the workspace
process.env.XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || path.resolve(process.cwd(), '.wrangler_cfg');

interface TextNode {
  xpath: string;
  text: string; // Plain text content (for translation)
  html: string; // Original innerHTML (preserves formatting)
  orderIndex: number;
}

interface ChapterData {
  number: number;
  title: string;
  originalTitle: string;
  rawHtml: string;
  textNodes: TextNode[];
}

interface BookData {
  title: string;
  author: string;
  language: string;
  styles: string;
  chapters: ChapterData[];
}

interface TranslatedChapter extends ChapterData {
  translations: Map<string, string>; // xpath -> translated text
}

interface ImportOptions {
  file: string;
  target?: string;
  source?: string;
  'limit-chapters'?: string;
  concurrency?: string;
  cover?: string;
  spine?: string;
  help?: boolean;
}

const SUPPORTED_LANGUAGES: Record<string, string> = {
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  en: 'English',
};

class BookImporterV2 {
  private file: string;
  private targetLang: string;
  private sourceLang: string;
  private limitChapters?: number;
  private concurrency: number;
  private apiKey: string;
  private apiBaseUrl: string;
  private model: string;
  private coverUrl?: string;
  private spineUrl?: string;

  constructor(options: ImportOptions) {
    this.file = this.resolveFilePath(options.file) || '';
    if (!this.file) {
      throw new Error('File not found');
    }

    this.targetLang = options.target || 'zh';
    this.sourceLang = options.source || 'en';
    this.limitChapters = options['limit-chapters']
      ? parseInt(options['limit-chapters'], 10)
      : undefined;
    this.concurrency = options.concurrency
      ? parseInt(options.concurrency, 10)
      : 5;
    this.coverUrl = options.cover;
    this.spineUrl = options.spine;

    // API configuration - using OpenRouter
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.apiBaseUrl = process.env.OPENAI_API_BASE_URL || 'https://openrouter.ai/api/v1';
    this.model = process.env.OPENAI_MODEL || 'google/gemini-3-flash-preview';

    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required');
    }
  }

  private resolveFilePath(input: string): string | null {
    if (!input) return null;
    if (path.isAbsolute(input) && fs.existsSync(input)) return input;

    const candidates = [
      input,
      path.join(process.cwd(), input),
      path.join(process.cwd(), 'epubs', input),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  async import(): Promise<string> {
    console.log('📚 Ovid Book Import V2 (XPath-based)');
    console.log('='.repeat(50));
    console.log(`📖 File: ${this.file}`);
    console.log(`🌍 Target Language: ${SUPPORTED_LANGUAGES[this.targetLang]}`);
    console.log(`🤖 Model: ${this.model}`);
    console.log('');

    try {
      console.log('🔍 Step 1: Parsing EPUB and extracting HTML...');
      const bookData = await this.parseEpub();
      console.log(`   ✅ Found ${bookData.chapters.length} chapters`);

      const totalTextNodes = bookData.chapters.reduce(
        (sum, ch) => sum + ch.textNodes.length, 0
      );
      console.log(`   ✅ Found ${totalTextNodes} text nodes to translate`);

      console.log('🔄 Step 2: Translating text nodes...');
      const translatedChapters = await this.translateBook(bookData);
      console.log('   ✅ Translation complete');

      console.log('💾 Step 3: Saving to database...');
      const bookUuid = await this.saveToDatabase(bookData, translatedChapters);
      console.log(`   ✅ Book saved with UUID: ${bookUuid}`);

      console.log('');
      console.log('🎉 Import completed successfully!');
      console.log(`📱 Access your book at: /book/${bookUuid}`);

      return bookUuid;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Import failed:', errorMessage);
      throw error;
    }
  }

  private async parseEpub(): Promise<BookData> {
    const { EPub } = require('epub2');

    return new Promise((resolve, reject) => {
      const epub = new EPub(this.file);

      epub.on('end', async () => {
        try {
          const metadata = {
            title: epub.metadata.title || path.basename(this.file, '.epub'),
            author: epub.metadata.creator || 'Unknown Author',
            language: epub.metadata.language || 'en',
          };

          // Extract global styles
          let globalStyles = '';
          for (const id in epub.manifest) {
            const item = epub.manifest[id];
            if (item['media-type'] === 'text/css') {
              try {
                const styleContent = await new Promise<string>((res, rej) => {
                  epub.getFile(id, (err: any, data: any) => {
                    if (err) rej(err);
                    else res(data.toString());
                  });
                });
                globalStyles += `/* ${item.href} */\n${styleContent}\n`;
              } catch (e) {
                console.warn(`   ⚠️ Failed to read style: ${item.href}`);
              }
            }
          }

          // Build href to id mapping
          const hrefToId: Record<string, string> = {};
          for (const id in epub.manifest) {
            const hrefRaw = epub.manifest[id].href || '';
            const normalized = path.posix.normalize(decodeURI(hrefRaw)).replace(/^\/*/, '');
            hrefToId[normalized] = id;
            const filename = normalized.split('/').pop();
            if (filename && !hrefToId[filename]) hrefToId[filename] = id;
          }

          // Use TOC for chapter detection (supports fragment IDs for single-file EPUBs)
          let chapterEntries = (epub.toc || []).filter((entry: any) => {
            const title = (entry.title || '').toLowerCase();
            const href = (entry.href || '').toLowerCase();
            const isCover = title.includes('cover') || href.includes('cover');
            const isToc = title.includes('table of contents') ||
              title === 'contents' ||
              href.includes('nav') ||
              title.includes('toc');
            return !(isCover || isToc);
          });

          // Fallback to spine if no TOC entries
          if (chapterEntries.length === 0) {
            console.log('   ⚠️ No TOC entries found, falling back to spine items');
            for (const item of (epub.spine?.contents || [])) {
              const manifest = epub.manifest[item.id];
              if (manifest) {
                const href = manifest.href || '';
                const isTitle = href.includes('title') || href.includes('cover');
                if (!isTitle) {
                  chapterEntries.push({
                    title: `Chapter ${chapterEntries.length + 1}`,
                    href: manifest.href,
                    id: item.id,
                  });
                }
              }
            }
          }

          console.log(`   📚 Found ${chapterEntries.length} chapters in TOC`);

          // Group TOC entries by file to detect fragment boundaries
          const tocEntriesByFile = new Map<string, Array<{ fragment?: string; index: number }>>();
          chapterEntries.forEach((entry: any, index: number) => {
            const [filePath, fragment] = (entry.href || '').split('#');
            const normalizedPath = path.posix.normalize(decodeURI(filePath)).replace(/^\/*/, '');
            if (!tocEntriesByFile.has(normalizedPath)) {
              tocEntriesByFile.set(normalizedPath, []);
            }
            tocEntriesByFile.get(normalizedPath)!.push({ fragment, index });
          });

          // Limit chapters if specified
          let entriesToProcess = chapterEntries;
          if (this.limitChapters && this.limitChapters > 0) {
            entriesToProcess = chapterEntries.slice(0, this.limitChapters);
          }

          const chapters: ChapterData[] = [];
          const processedHashes = new Set<string>();

          for (let i = 0; i < entriesToProcess.length; i++) {
            const entry = entriesToProcess[i];
            const [filePath, fragment] = (entry.href || '').split('#');
            const normalizedPath = path.posix.normalize(decodeURI(filePath)).replace(/^\/*/, '');

            // Find manifest ID for this file
            let fileId: string | null = null;
            if (hrefToId[normalizedPath]) {
              fileId = hrefToId[normalizedPath];
            } else {
              const filename = normalizedPath.split('/').pop();
              if (filename && hrefToId[filename]) {
                fileId = hrefToId[filename];
              }
            }

            if (!fileId) {
              console.log(`   ❌ Could not find file for: ${entry.title} (${filePath})`);
              continue;
            }

            const html = await new Promise<string>((res, rej) => {
              epub.getChapter(fileId!, (err: any, data: string) => {
                if (err) rej(err);
                else res(data);
              });
            });

            // Get fragment IDs for this file to detect chapter boundaries
            const fileFragments = tocEntriesByFile.get(normalizedPath) || [];
            const currentFragmentIndex = fileFragments.findIndex(f => f.index === i);
            const nextFragment = currentFragmentIndex >= 0 && currentFragmentIndex < fileFragments.length - 1
              ? fileFragments[currentFragmentIndex + 1].fragment
              : undefined;

            // Extract text nodes - use fragment-aware extraction if needed
            let textNodes: TextNode[];
            let rawHtml: string;

            if (fragment) {
              // Fragment-based extraction for single-file EPUBs
              const result = this.extractTextNodesFromFragment(html, fragment, nextFragment);
              textNodes = result.textNodes;
              rawHtml = result.rawHtml;
            } else {
              // Full file extraction
              textNodes = this.extractTextNodes(html);
              const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
              rawHtml = bodyMatch ? bodyMatch[1].trim() : html;
            }

            // Skip duplicate content (same file without fragment boundary changes)
            const contentHash = crypto.createHash('md5').update(rawHtml + (fragment || '')).digest('hex');
            if (processedHashes.has(contentHash)) {
              console.log(`   ⏭️  Skipping duplicate content: "${entry.title}"`);
              continue;
            }
            processedHashes.add(contentHash);

            // Use TOC title, or extract from content if available
            let title = entry.title || `Chapter ${chapters.length + 1}`;

            chapters.push({
              number: chapters.length + 1,
              title: title,
              originalTitle: title,
              rawHtml,
              textNodes,
            });

            console.log(`   📖 Chapter ${chapters.length}: "${title}" (${textNodes.length} text nodes)${fragment ? ` [fragment: #${fragment}]` : ''}`);
          }

          resolve({
            title: metadata.title,
            author: metadata.author,
            language: metadata.language,
            styles: globalStyles,
            chapters,
          });
        } catch (parseError) {
          reject(parseError);
        }
      });

      epub.on('error', (err: any) => reject(err));
      epub.parse();
    });
  }

  /**
   * Extract meaningful text from block-level elements only.
   * This preserves paragraph structure - inline elements (em, i, strong, span)
   * are included in their parent block's text, not extracted separately.
   */
  private extractTextNodes(html: string): TextNode[] {
    const textNodes: TextNode[] = [];
    let orderIndex = 0;

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

    // Skip these tags entirely
    const skipTags = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link']);

    // Block-level elements - extract full textContent from these
    const blockTags = new Set([
      'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'blockquote', 'pre', 'td', 'th', 'dt', 'dd',
      'figcaption', 'article', 'section', 'aside', 'header', 'footer'
    ]);

    // Try to extract body content first
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const contentToProcess = bodyMatch ? bodyMatch[1] : html;

    // Parse with xmldom - use text/xml for XHTML
    const parser = new DOMParser();
    // Wrap in a root element to ensure valid XML
    const wrappedHtml = `<root>${contentToProcess}</root>`;
    const doc = parser.parseFromString(wrappedHtml, 'text/xml');

    // Find the root element we created
    const root = doc.getElementsByTagName('root')[0];
    if (!root) {
      console.warn('   ⚠️ Failed to parse HTML, falling back to regex extraction');
      return this.extractTextNodesRegex(html);
    }

    // Helper to get full text content of an element (including all children)
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

    // Helper to get innerHTML of an element (preserves formatting tags)
    const serializer = new XMLSerializer();
    const getInnerHtml = (node: any): string => {
      let html = '';
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child.nodeType === 3) { // TEXT_NODE
            html += child.textContent || '';
          } else if (child.nodeType === 1) { // ELEMENT_NODE
            html += serializer.serializeToString(child);
          }
        }
      }
      return html;
    };

    // Recursive function to walk DOM and extract from block elements
    const walkNode = (node: any, pathSegments: string[]) => {
      const nodeType = node.nodeType;

      if (nodeType === 1) { // Node.ELEMENT_NODE
        const tagName = (node.tagName || node.nodeName || '').toLowerCase();

        // Skip certain tags
        if (skipTags.has(tagName)) return;

        // Count this element's index among siblings of same tag name
        let elementIndex = 1;
        let sibling = node.previousSibling;
        while (sibling) {
          if (sibling.nodeType === 1) { // ELEMENT_NODE
            const sibTagName = (sibling.tagName || sibling.nodeName || '').toLowerCase();
            if (sibTagName === tagName) {
              elementIndex++;
            }
          }
          sibling = sibling.previousSibling;
        }

        const currentPath = [...pathSegments, `${tagName}[${elementIndex}]`];

        // If this is a block element, extract full text content
        if (blockTags.has(tagName)) {
          const fullText = decodeEntities(getFullTextContent(node));
          if (fullText.length >= 2) {
            // XPath points to this block element (not text() child)
            const xpath = '/' + currentPath.join('/');
            textNodes.push({
              xpath,
              text: fullText,
              html: getInnerHtml(node), // Preserve formatting
              orderIndex: orderIndex++,
            });
          }
          // Don't recurse into block elements - we've captured all their text
          return;
        }

        // For non-block elements (like divs containing blocks), recurse
        const children = node.childNodes;
        if (children) {
          for (let i = 0; i < children.length; i++) {
            walkNode(children[i], currentPath);
          }
        }
      }
    };

    // Walk from root's children, treating root as body[1]
    const children = root.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) {
        const child = children[i] as any;
        if (child.nodeType === 1) { // ELEMENT_NODE
          const tagName = ((child as any).tagName || (child as any).nodeName || '').toLowerCase();
          if (skipTags.has(tagName)) continue;

          let elementIndex = 1;
          let sibling = child.previousSibling as any;
          while (sibling) {
            if (sibling.nodeType === 1) {
              const sibTagName = (sibling.tagName || sibling.nodeName || '').toLowerCase();
              if (sibTagName === tagName) {
                elementIndex++;
              }
            }
            sibling = sibling.previousSibling;
          }

          const currentPath = ['body[1]', `${tagName}[${elementIndex}]`];

          // If this top-level element is a block, extract its text
          if (blockTags.has(tagName)) {
            const fullText = decodeEntities(getFullTextContent(child));
            if (fullText.length >= 2) {
              const xpath = '/' + currentPath.join('/');
              textNodes.push({
                xpath,
                text: fullText,
                html: getInnerHtml(child), // Preserve formatting
                orderIndex: orderIndex++,
              });
            }
          } else {
            // Otherwise recurse to find block elements inside
            walkNode(child, ['body[1]']);
          }
        }
      }
    }

    // If no text nodes found, fall back to regex
    if (textNodes.length === 0) {
      console.warn('   ⚠️ DOM walk found no text, falling back to regex extraction');
      return this.extractTextNodesRegex(html);
    }

    return textNodes;
  }

  /**
   * Extract text nodes from a fragment within an HTML file.
   * Used for single-file EPUBs where multiple chapters are in one file,
   * separated by fragment IDs (e.g., chapter.html#section2).
   */
  private extractTextNodesFromFragment(
    html: string,
    startFragment: string,
    endFragment?: string
  ): { textNodes: TextNode[]; rawHtml: string } {
    const textNodes: TextNode[] = [];
    let orderIndex = 0;

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

    const skipTags = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link']);
    const blockTags = new Set([
      'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'blockquote', 'pre', 'td', 'th', 'dt', 'dd',
      'figcaption', 'article', 'section', 'aside', 'header', 'footer'
    ]);

    // Parse the HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.getElementsByTagName('body')[0] || doc;

    // Find the starting element by fragment ID
    let startNode: any = null;
    const findById = (node: any, id: string): any => {
      if (node.getAttribute && node.getAttribute('id') === id) {
        return node;
      }
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const result = findById(children[i], id);
          if (result) return result;
        }
      }
      return null;
    };

    startNode = findById(body, startFragment);
    if (!startNode) {
      console.warn(`   ⚠️ Fragment #${startFragment} not found, extracting from beginning`);
      startNode = body;
    }

    // Track element counts for XPath generation (chapter-scoped, starting from 1)
    const tagCounts: Record<string, number> = {};
    const serializer = new XMLSerializer();
    let rawHtmlParts: string[] = [];
    let started = !startFragment || startNode === body;
    let stopped = false;

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

    // Helper to get innerHTML
    const getInnerHtml = (node: any): string => {
      let innerHtml = '';
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child.nodeType === 3) {
            innerHtml += child.textContent || '';
          } else if (child.nodeType === 1) {
            innerHtml += serializer.serializeToString(child);
          }
        }
      }
      return innerHtml;
    };

    // Recursive walk to extract text nodes within fragment boundaries
    const walkNode = (node: any) => {
      if (!node || stopped) return;

      const nodeType = node.nodeType;

      if (nodeType === 1) { // ELEMENT_NODE
        const tagName = (node.tagName || node.nodeName || '').toLowerCase();

        // Check if this is the end fragment
        if (endFragment && node.getAttribute && node.getAttribute('id') === endFragment) {
          stopped = true;
          return;
        }

        // Check if this is the start fragment
        if (!started && node.getAttribute && node.getAttribute('id') === startFragment) {
          started = true;
        }

        if (skipTags.has(tagName)) return;

        // If we've started and this is a block element, extract it
        if (started && blockTags.has(tagName)) {
          const fullText = decodeEntities(getFullTextContent(node));
          if (fullText.length >= 2) {
            // Generate chapter-scoped XPath
            tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
            const xpath = `/body[1]/${tagName}[${tagCounts[tagName]}]`;

            textNodes.push({
              xpath,
              text: fullText,
              html: getInnerHtml(node),
              orderIndex: orderIndex++,
            });

            // Add to raw HTML for this fragment
            rawHtmlParts.push(serializer.serializeToString(node));
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
      }
    };

    // Start walking from the body or start node
    if (startNode === body) {
      const children = body.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          walkNode(children[i]);
        }
      }
    } else {
      // If we have a specific start node, first include it if it's a block element
      const startTagName = (startNode.tagName || startNode.nodeName || '').toLowerCase();
      if (blockTags.has(startTagName)) {
        const fullText = decodeEntities(getFullTextContent(startNode));
        if (fullText.length >= 2) {
          tagCounts[startTagName] = (tagCounts[startTagName] || 0) + 1;
          const xpath = `/body[1]/${startTagName}[${tagCounts[startTagName]}]`;
          textNodes.push({
            xpath,
            text: fullText,
            html: getInnerHtml(startNode),
            orderIndex: orderIndex++,
          });
          rawHtmlParts.push(serializer.serializeToString(startNode));
        }
      }

      // Then continue from the start node's next siblings and parent's siblings
      started = true;
      let currentNode = startNode.nextSibling;
      while (currentNode && !stopped) {
        walkNode(currentNode);
        currentNode = currentNode.nextSibling;
      }

      // If we haven't hit the end fragment, continue up and to the right
      if (!stopped && startNode.parentNode && startNode.parentNode !== body) {
        let parent = startNode.parentNode;
        while (parent && parent !== body && !stopped) {
          let sibling = parent.nextSibling;
          while (sibling && !stopped) {
            walkNode(sibling);
            sibling = sibling.nextSibling;
          }
          parent = parent.parentNode;
        }
      }
    }

    // If no text nodes found, fall back to full extraction
    if (textNodes.length === 0) {
      console.warn(`   ⚠️ No content found in fragment #${startFragment}, trying full extraction`);
      return {
        textNodes: this.extractTextNodes(html),
        rawHtml: html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html,
      };
    }

    return {
      textNodes,
      rawHtml: rawHtmlParts.join('\n'),
    };
  }

  /**
   * Fallback regex-based text extraction
   */
  private extractTextNodesRegex(html: string): TextNode[] {
    const textNodes: TextNode[] = [];
    let orderIndex = 0;

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

    // Remove script and style content
    let cleanHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleanHtml = cleanHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Extract text from paragraph-like elements
    const tagPattern = /<(p|h[1-6]|div|li|blockquote|td|th|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    const tagCounts: Record<string, number> = {};
    const seen = new Set<string>();
    let match;

    while ((match = tagPattern.exec(cleanHtml)) !== null) {
      const tagName = match[1].toLowerCase();
      const content = match[2];

      // Strip nested tags to get text content
      const textContent = decodeEntities(content.replace(/<[^>]+>/g, ' '));

      // Skip empty or very short content
      if (textContent.length < 2) continue;

      // Skip duplicates
      if (seen.has(textContent)) continue;
      seen.add(textContent);

      // Increment tag counter
      tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;

      textNodes.push({
        xpath: `/body[1]/${tagName}[${tagCounts[tagName]}]`,
        text: textContent,
        html: content, // Original content with HTML tags
        orderIndex: orderIndex++,
      });
    }

    return textNodes;
  }

  /**
   * Translate all text nodes in the book
   */
  private async translateBook(bookData: BookData): Promise<TranslatedChapter[]> {
    const translatedChapters: TranslatedChapter[] = [];

    for (const chapter of bookData.chapters) {
      console.log(`   📖 Translating chapter ${chapter.number}: "${chapter.title}"...`);

      const translations = new Map<string, string>();
      const texts = chapter.textNodes.map(n => n.text);

      // Batch translate with concurrency control
      const batchSize = this.concurrency;
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchNodes = chapter.textNodes.slice(i, i + batchSize);

        const translatedBatch = await this.translateBatch(batch);

        for (let j = 0; j < batchNodes.length; j++) {
          translations.set(batchNodes[j].xpath, translatedBatch[j]);
        }

        const progress = Math.min(i + batchSize, texts.length);
        process.stdout.write(`\r      Progress: ${progress}/${texts.length}`);
      }
      console.log(''); // New line after progress

      // Also translate chapter title
      const translatedTitle = await this.translateText(chapter.title);

      translatedChapters.push({
        ...chapter,
        title: translatedTitle,
        translations,
      });
    }

    return translatedChapters;
  }

  /**
   * Translate a batch of texts in parallel
   */
  private async translateBatch(texts: string[]): Promise<string[]> {
    const promises = texts.map(text => this.translateText(text));
    return Promise.all(promises);
  }

  /**
   * Translate a single text using the API
   */
  private async translateText(text: string): Promise<string> {
    const targetLangName = SUPPORTED_LANGUAGES[this.targetLang] || this.targetLang;
    const sourceLangName = SUPPORTED_LANGUAGES[this.sourceLang] || this.sourceLang;

    try {
      const response = await fetch(`${this.apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: `You are a professional literary translator. Translate ${sourceLangName} text to ${targetLangName}.
Rules:
1. Return ONLY the translation, nothing else.
2. Maintain the original style and tone.
3. Do not add explanations or notes.
4. If the text is a name or proper noun, transliterate appropriately.`,
            },
            {
              role: 'user',
              content: text,
            },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as any;
      return data.choices?.[0]?.message?.content?.trim() || text;
    } catch (error) {
      console.warn(`\n   ⚠️ Translation failed for: "${text.substring(0, 30)}..."`);
      return `[翻译失败: ${text}]`;
    }
  }

  /**
   * Save the book to the database in batches
   */
  private async saveToDatabase(
    bookData: BookData,
    translatedChapters: TranslatedChapter[]
  ): Promise<string> {
    const bookUuid = uuidv4();
    const languagePair = `${this.sourceLang}-${this.targetLang}`;

    // Escape SQL string
    const escapeSQL = (str: string): string => {
      if (str === null || str === undefined) return 'NULL';
      return "'" + str.replace(/'/g, "''") + "'";
    };

    // First, initialize the v2 schema if needed
    console.log('   📋 Ensuring v2 schema exists...');
    execSync(`./node_modules/.bin/wrangler d1 execute ovid-db --local --file=database/schema_v2.sql`, {
      stdio: 'inherit',
    });

    // Insert book (small statement)
    console.log('   📥 Inserting book metadata...');
    const bookSql = `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, book_cover_img_url, book_spine_img_url) VALUES (${escapeSQL(bookUuid)}, ${escapeSQL(translatedChapters[0]?.title || bookData.title)}, ${escapeSQL(bookData.title)}, ${escapeSQL(bookData.author)}, ${escapeSQL(languagePair)}, ${escapeSQL(bookData.styles)}, ${this.coverUrl ? escapeSQL(this.coverUrl) : 'NULL'}, ${this.spineUrl ? escapeSQL(this.spineUrl) : 'NULL'});`;

    const bookSqlPath = path.resolve(process.cwd(), `.temp_book_${bookUuid}.sql`);
    fs.writeFileSync(bookSqlPath, bookSql, 'utf8');
    try {
      execSync(`./node_modules/.bin/wrangler d1 execute ovid-db --local --file="${bookSqlPath}"`, { stdio: 'inherit' });
    } finally {
      if (fs.existsSync(bookSqlPath)) fs.unlinkSync(bookSqlPath);
    }

    // Insert chapters and translations
    // D1/Wrangler has a max statement size limit, so skip raw_html for large chapters
    // D1's limit appears to be around 100KB for statements
    // Skip raw_html storage entirely - we now store original_html per translation instead
    // This avoids D1/wrangler statement size limits
    const MAX_RAW_HTML_SIZE = 0; // Disabled - use per-translation original_html instead

    for (const chapter of translatedChapters) {
      console.log(`   📥 Inserting chapter ${chapter.number}...`);

      // Check if raw_html is too large
      const rawHtmlSize = Buffer.byteLength(chapter.rawHtml, 'utf8');
      const shouldStoreRawHtml = rawHtmlSize < MAX_RAW_HTML_SIZE;

      if (!shouldStoreRawHtml) {
        console.log(`      ⚠️ Raw HTML too large (${Math.round(rawHtmlSize / 1024)}KB), will reconstruct at runtime`);
      }

      // Insert chapter - only include raw_html if it's small enough
      const chapterSql = shouldStoreRawHtml
        ? `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, raw_html, order_index) VALUES ((SELECT id FROM books_v2 WHERE uuid = ${escapeSQL(bookUuid)}), ${chapter.number}, ${escapeSQL(chapter.title)}, ${escapeSQL(chapter.originalTitle)}, ${escapeSQL(chapter.rawHtml)}, ${chapter.number});`
        : `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index) VALUES ((SELECT id FROM books_v2 WHERE uuid = ${escapeSQL(bookUuid)}), ${chapter.number}, ${escapeSQL(chapter.title)}, ${escapeSQL(chapter.originalTitle)}, ${chapter.number});`;

      const chapterSqlPath = path.resolve(process.cwd(), `.temp_chapter_${bookUuid}_${chapter.number}.sql`);
      fs.writeFileSync(chapterSqlPath, chapterSql, 'utf8');
      try {
        execSync(`./node_modules/.bin/wrangler d1 execute ovid-db --local --file="${chapterSqlPath}"`, { stdio: 'inherit' });
      } finally {
        if (fs.existsSync(chapterSqlPath)) fs.unlinkSync(chapterSqlPath);
      }

      // Insert translations in batches of 50
      const batchSize = 50;
      const totalNodes = chapter.textNodes.length;

      for (let i = 0; i < totalNodes; i += batchSize) {
        const batch = chapter.textNodes.slice(i, i + batchSize);
        const translationsSql = batch.map(node => {
          const translatedText = chapter.translations.get(node.xpath) || node.text;
          return `INSERT INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index) VALUES ((SELECT id FROM chapters_v2 WHERE book_id = (SELECT id FROM books_v2 WHERE uuid = ${escapeSQL(bookUuid)}) AND chapter_number = ${chapter.number}), ${escapeSQL(node.xpath)}, ${escapeSQL(node.text)}, ${escapeSQL(node.html)}, ${escapeSQL(translatedText)}, ${node.orderIndex});`;
        }).join('\n');

        const transSqlPath = path.resolve(process.cwd(), `.temp_trans_${bookUuid}_${chapter.number}_${i}.sql`);
        fs.writeFileSync(transSqlPath, translationsSql, 'utf8');
        try {
          execSync(`./node_modules/.bin/wrangler d1 execute ovid-db --local --file="${transSqlPath}"`, { stdio: 'pipe' });
          process.stdout.write(`\r      Translations: ${Math.min(i + batchSize, totalNodes)}/${totalNodes}`);
        } finally {
          if (fs.existsSync(transSqlPath)) fs.unlinkSync(transSqlPath);
        }
      }
      console.log(''); // New line after progress
    }

    return bookUuid;
  }
}

// CLI Interface
function parseArgs(): ImportOptions {
  const args = process.argv.slice(2);
  const options: any = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.split('=');
      const cleanKey = key.replace('--', '');
      options[cleanKey] = value || true;
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
📚 Ovid Book Import V2 (XPath-based)

Usage:
  ts-node scripts/import-book-v2.ts --file="book.epub" --target="zh"

Options:
  --file              Path to EPUB file
  --target            Target language code (zh, es, fr, de, ja, ko, ru)
  --source            Source language code (default: en)
  --limit-chapters    Limit number of chapters to import
  --concurrency       Number of parallel translations (default: 5)
  --help              Show this help

Environment Variables:
  OPENAI_API_KEY        API key (for OpenRouter or OpenAI-compatible API)
  OPENAI_API_BASE_URL   API base URL (default: https://openrouter.ai/api/v1)
  OPENAI_MODEL          Model to use (default: google/gemini-3-flash-preview)

Examples:
  ts-node scripts/import-book-v2.ts --file="animal_farm.epub" --target="zh"
  ts-node scripts/import-book-v2.ts --file="book.epub" --target="zh" --limit-chapters=2
`);
}

async function main() {
  const options = parseArgs();

  if (options.help || !options.file) {
    showHelp();
    process.exit(0);
  }

  try {
    const importer = new BookImporterV2(options);
    await importer.import();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Error:', errorMessage);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export default BookImporterV2;
