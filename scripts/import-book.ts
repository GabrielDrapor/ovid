#!/usr/bin/env ts-node

/**
 * @deprecated This is the V1 import script.
 * Use import-book-v2.ts instead, which uses XPath-based translations
 * and preserves original EPUB HTML formatting.
 *
 * Ovid Book Import System (V1 - DEPRECATED)
 *
 * Imports EPUB/TXT files and generates bilingual content using translation APIs
 *
 * Usage:
 *   ts-node scripts/import-book.ts --file="book.epub" --target="zh"
 *   ts-node scripts/import-book.ts --file="book.txt" --title="Book Title" --author="Author" --target="es"
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import { DOMParser } from '@xmldom/xmldom';

import {
  Translator,
  SUPPORTED_LANGUAGES,
} from '../src/utils/translator';
import { KVStore } from '../src/utils/KVStore';
import { buildBookImportSql } from '../src/utils/sql-builder';
import type {
  ContentItem,
  Chapter,
  BookData,
  TranslatedContentItem,
  TranslatedChapter,
} from '../src/utils/book-processor';

// Ensure Wrangler writes config/logs inside the workspace
process.env.XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || path.resolve(process.cwd(), '.wrangler_cfg');

const SUPPORTED_FORMATS = ['.epub', '.txt', '.pdf'];

interface ImportOptions {
  file: string;
  target?: string;
  title?: string;
  author?: string;
  source?: string;
  'limit-chapters'?: string;
  'limit-paragraphs'?: string;
  'chapters-concurrency'?: string;
  chaptersConcurrency?: string;
  'items-concurrency'?: string;
  itemsConcurrency?: string;
  concurrency?: string;
  'sql-out'?: string;
  sqlOut?: string;
  apply?: 'local' | 'remote' | null;
  help?: boolean;
}

interface TranslatedContent {
  chapters: TranslatedChapter[];
  totalSegments: number;
}

// Extended chapter type for CLI (includes extra metadata)
interface CLIChapter extends Chapter {
  orderIndex?: number;
  tocIndex?: number;
  spineIndex?: number;
}

class BookImporter {
  private file: string;
  private targetLang: string;
  private title?: string;
  private author?: string;
  private sourceLang: string;
  private limitChapters?: number;
  private limitParagraphs?: number;
  private chapterConcurrency: number;
  private itemConcurrency: number;
  private sqlOut: string | null;
  private applyMode: 'local' | 'remote' | null;
  private translator: Translator;

  constructor(options: ImportOptions) {
    this.file = options.file;
    this.targetLang = options.target || 'zh';
    this.title = options.title;
    this.author = options.author;
    this.sourceLang = options.source || 'en';
    this.limitChapters = options['limit-chapters']
      ? parseInt(options['limit-chapters'], 10)
      : undefined;
    this.limitParagraphs = options['limit-paragraphs']
      ? parseInt(options['limit-paragraphs'], 10)
      : undefined;

    const cc = options['chapters-concurrency'] || options['chaptersConcurrency'];
    const ic = options['items-concurrency'] || options['itemsConcurrency'] || options['concurrency'];
    this.chapterConcurrency = cc ? Math.max(1, parseInt(cc, 10)) : 2;
    this.itemConcurrency = ic ? Math.max(1, parseInt(ic, 10)) : 8;

    this.sqlOut = options['sql-out'] || options['sqlOut'] || null;
    this.applyMode = options['apply'] || null;

    this.translator = new Translator({
      concurrency: this.itemConcurrency,
      kvStore: new KVStore(),
    });

    this.validateInputs();
  }

  private validateInputs(): void {
    this.file = this.resolveFilePath(this.file) || '';
    if (!this.file) {
      throw new Error(`File not found. Looked in: ./, ./epubs, ./@epubs`);
    }

    const ext = path.extname(this.file).toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      throw new Error(`Unsupported format: ${ext}. Supported: ${SUPPORTED_FORMATS.join(', ')}`);
    }

    if (!SUPPORTED_LANGUAGES[this.targetLang]) {
      throw new Error(
        `Unsupported target language: ${this.targetLang}. Supported: ${Object.keys(SUPPORTED_LANGUAGES).join(', ')}`
      );
    }
  }

  private resolveFilePath(input: string): string | null {
    if (!input || typeof input !== 'string') return null;
    if (path.isAbsolute(input) && fs.existsSync(input)) return input;

    const candidates: string[] = [];
    const cleaned = input.replace(/^\.\//, '');

    candidates.push(input);
    if (cleaned.startsWith('epubs/')) candidates.push(`@${cleaned}`);
    if (cleaned.startsWith('@epubs/')) candidates.push(cleaned.replace(/^@/, ''));

    const baseName = path.basename(cleaned);
    if (!cleaned.includes('/')) {
      candidates.push(path.join('epubs', baseName));
      candidates.push(path.join('@epubs', baseName));
    }

    for (const c of candidates) {
      const abs = path.resolve(process.cwd(), c);
      if (fs.existsSync(abs)) return abs;
    }

    return null;
  }

  async import(): Promise<string> {
    console.log('📚 Ovid Book Import System');
    console.log('='.repeat(40));
    console.log(`📖 File: ${this.file}`);
    console.log(`🌍 Target Language: ${SUPPORTED_LANGUAGES[this.targetLang]}`);
    console.log('');

    try {
      console.log('🔍 Step 1: Parsing book file...');
      const bookData = await this.parseBook();
      console.log(`   ✅ Found ${bookData.chapters.length} chapters`);

      console.log('🔄 Step 2: Generating translations...');
      const translatedContent = await this.translateContent(bookData);
      console.log(`   ✅ Translated ${translatedContent.totalSegments} text segments`);

      console.log('💾 Step 3: Importing to database...');
      const bookId = await this.importToDatabase(bookData, translatedContent);
      console.log(`   ✅ Book imported with UUID: ${bookId}`);

      console.log('');
      console.log('🎉 Import completed successfully!');
      console.log(`📱 Access your book at: /book/${bookId}`);

      return bookId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Import failed:', errorMessage);
      process.exit(1);
    }
  }

  private async parseBook(): Promise<BookData> {
    const ext = path.extname(this.file).toLowerCase();

    switch (ext) {
      case '.txt':
        return this.parseTxtFile();
      case '.epub':
        return this.parseEpubFile();
      case '.pdf':
        return this.parsePdfFile();
      default:
        throw new Error(`Parser not implemented for ${ext}`);
    }
  }

  private parseTxtFile(): BookData {
    const content = fs.readFileSync(this.file, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim());

    const chapters: CLIChapter[] = [];
    let currentChapter: CLIChapter | null = null;
    let chapterCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (this.isChapterHeader(trimmed)) {
        if (currentChapter) chapters.push(currentChapter);
        chapterCount++;
        currentChapter = {
          number: chapterCount,
          title: trimmed,
          originalTitle: trimmed,
          content: [],
        };
      } else if (trimmed && currentChapter) {
        currentChapter.content.push({
          id: `p-${currentChapter.number}-${currentChapter.content.length + 1}`,
          text: trimmed,
          type: 'paragraph',
        });
      }
    }

    if (currentChapter) chapters.push(currentChapter);

    return {
      title: this.title || path.basename(this.file, '.txt'),
      originalTitle: this.title || path.basename(this.file, '.txt'),
      author: this.author || 'Unknown Author',
      language: this.sourceLang,
      chapters,
    };
  }

  private isChapterHeader(line: string): boolean {
    return /^(Chapter|CHAPTER|第.{1,3}章|\d+\.)/i.test(line) && line.length < 100;
  }

  private parseEpubFile(): Promise<BookData> {
    const { EPub } = require('epub2');
    const crypto = require('crypto');

    return new Promise((resolve, reject) => {
      const epub = new EPub(this.file);
      epub.on('end', async () => {
        try {
          const metadata = {
            title: this.title || epub.metadata.title || path.basename(this.file, '.epub'),
            author: this.author || epub.metadata.creator || 'Unknown Author',
            language: this.sourceLang || epub.metadata.language || 'en',
          };

          console.log(`   Using TOC-based chapter detection`);
          console.log(`   Found ${epub.toc.length} TOC entries`);

          // Extract styles
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
                console.warn(`      ⚠️  Failed to read style ${item.href}`);
              }
            }
          }

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

          if (chapterEntries.length === 0 && epub.toc?.length > 0) {
            chapterEntries = epub.toc.slice();
          }

          console.log(`   TOC chapters considered: ${chapterEntries.length}`);

          // Build href to id mapping
          const hrefToId: Record<string, string> = {};
          for (const id in epub.manifest) {
            const hrefRaw = epub.manifest[id].href || '';
            const normalized = path.posix.normalize(decodeURI(hrefRaw)).replace(/^\/*/, '');
            hrefToId[normalized] = id;
            const filename = normalized.split('/').pop();
            if (filename && !hrefToId[filename]) hrefToId[filename] = id;
          }

          // Build spine index mapping
          const spineIndexById: Record<string, number> = {};
          const spineIndexByHref: Record<string, number> = {};
          (epub.spine.contents || []).forEach((item: any, idx: number) => {
            spineIndexById[item.id] = idx;
            const man = epub.manifest[item.id];
            if (man?.href) {
              const n = path.posix.normalize(decodeURI(man.href)).replace(/^\/*/, '');
              spineIndexByHref[n] = idx;
            }
          });

          const orderedChapters: (CLIChapter | null)[] = new Array(chapterEntries.length).fill(null);
          let processedChapters = 0;
          const processedHashes = new Set<string>();
          const self = this;

          chapterEntries.forEach((entry: any, index: number) => {
            const href = (entry.href || '').split('#')[0];
            const normalizedHref = path.posix.normalize(decodeURI(href)).replace(/^\/*/, '');

            let fileId: string | null = null;
            if (hrefToId[normalizedHref]) {
              fileId = hrefToId[normalizedHref];
            } else {
              const filename = normalizedHref.split('/').pop();
              if (filename && hrefToId[filename]) fileId = hrefToId[filename];
            }

            if (!fileId) {
              console.log(`   ❌ Could not find file for: ${entry.title} (${href})`);
              processedChapters++;
              if (processedChapters === chapterEntries.length) finalizeParsing();
              return;
            }

            const spineIndex = spineIndexById[fileId] !== undefined
              ? spineIndexById[fileId]
              : spineIndexByHref[normalizedHref] !== undefined
                ? spineIndexByHref[normalizedHref]
                : Number.POSITIVE_INFINITY;

            epub.getChapter(fileId, (err: any, html: string) => {
              if (err || !html) {
                console.log(`   ⚠️ Could not read content for: ${entry.title} (${fileId})`);
              } else {
                const fragment = (entry.href || '').split('#')[1];
                const contentHash = crypto.createHash('md5').update(html + (fragment || '')).digest('hex');

                if (processedHashes.has(contentHash)) {
                  console.log(`   ⏭️  Skipping duplicate content: "${entry.title}"`);
                } else {
                  processChapter(index, spineIndex, entry.title, html, fileId!, fragment);
                  processedHashes.add(contentHash);
                }
              }

              processedChapters++;
              if (processedChapters === chapterEntries.length) finalizeParsing();
            });
          });

          const processChapter = (
            tocIndex: number,
            spineIndex: number,
            title: string,
            html: string,
            fileId: string,
            fragment?: string
          ) => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Extract internal styles
            const styleTags = doc.getElementsByTagName('style');
            for (let i = 0; i < styleTags.length; i++) {
              const s = styleTags[i].textContent;
              if (s) globalStyles += `/* Internal ${fileId} */\n${s}\n`;
            }

            let startNode: any = doc.getElementsByTagName('body')[0] || doc;
            if (fragment) {
              const target = doc.getElementById(fragment);
              if (target) {
                console.log(`      📍 Starting at fragment: ${fragment}`);
                startNode = target;
              }
            }

            const fragmentIds = chapterEntries
              .filter((e: any) => (e.href || '').startsWith(fileId + '#'))
              .map((e: any) => e.href.split('#')[1]);

            let stopExtracting = false;
            const items: ContentItem[] = [];

            items.push({
              id: `t-${tocIndex + 1}-0`,
              text: title,
              type: 'chapter',
              tagName: 'h3',
            });

            let started = !fragment;
            stopExtracting = false;

            const extractItems = (node: any) => {
              if (!node || stopExtracting) return;

              if (node.getAttribute && node.getAttribute('id')) {
                const id = node.getAttribute('id');
                if (id === fragment) {
                  started = true;
                } else if (fragmentIds.includes(id)) {
                  if (started) {
                    stopExtracting = true;
                    return;
                  }
                }
              }

              const nodeName = (node.nodeName || '').toLowerCase();
              if (nodeName === 'script' || nodeName === 'style') return;

              const meaningfulTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'section', 'header', 'footer'];

              if (started && meaningfulTags.includes(nodeName)) {
                let text = (node.textContent || '').trim();
                if (text.length > 0) {
                  let rawText = '';
                  const children = node.childNodes;
                  if (children) {
                    for (let i = 0; i < children.length; i++) {
                      const child = children[i];
                      const childName = (child.nodeName || '').toLowerCase();

                      if (child.nodeType === 3) {
                        rawText += child.nodeValue;
                      } else if (childName === 'sup' || (child.getAttribute && (child.getAttribute('class') || '').includes('footnote'))) {
                        rawText += `<sup>${child.textContent}</sup>`;
                      } else if (childName === 'a') {
                        const linkText = (child.textContent || '').trim();
                        const footnoteMatch = linkText.match(/^(.*?)(\d+)$/);
                        if (footnoteMatch && (footnoteMatch[1] === '' || footnoteMatch[1].length < 5)) {
                          rawText += `${footnoteMatch[1]}<sup>${footnoteMatch[2]}</sup>`;
                        } else {
                          rawText += child.textContent || '';
                        }
                      } else {
                        rawText += child.textContent || '';
                      }
                    }
                  } else {
                    rawText = text;
                  }

                  const className = node.getAttribute ? node.getAttribute('class') : '';
                  const inlineStyle = node.getAttribute ? node.getAttribute('style') : '';

                  const cleanText = rawText.replace(/<[^>]*>/g, '').trim();
                  if (items.length > 0) {
                    const prevItem = items[items.length - 1];
                    const prevText = prevItem.text.replace(/<[^>]*>/g, '').trim();
                    if (cleanText === prevText && cleanText.length > 0) {
                      console.log(`      ⏭️  Skipping internal duplicate text: "${cleanText.substring(0, 30)}..."`);
                      return;
                    }
                  }

                  items.push({
                    id: `p-${tocIndex + 1}-${items.length}`,
                    text: rawText.trim(),
                    type: nodeName.startsWith('h') ? 'chapter' : 'paragraph',
                    tagName: nodeName,
                    className: className || undefined,
                    styles: inlineStyle || undefined,
                  });
                  return;
                }
              }

              const children = node.childNodes;
              if (children) {
                for (let i = 0; i < children.length; i++) {
                  extractItems(children[i]);
                }
              }
            };

            extractItems(doc.getElementsByTagName('body')[0] || doc);

            let filteredItems = items.filter(
              (it) => it.type === 'chapter' || it.text.length > 5 || it.className?.includes('part')
            );

            // Deduplicate headers
            if (filteredItems.length > 1) {
              const normalize = (s: string) =>
                s.toLowerCase()
                  .replace(/^((chapter|part|section|appendix|book)\s+)?(\d+|[ivx]+)[:.]?\s*/gi, '')
                  .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
                  .trim();

              const tocTitleClean = normalize(title);

              if (tocTitleClean.length > 0) {
                let itemsToRemove = 0;
                let currentAccumulator = '';

                for (let i = 1; i < Math.min(filteredItems.length, 4); i++) {
                  currentAccumulator += ' ' + filteredItems[i].text;
                  const accClean = normalize(currentAccumulator);

                  if (accClean === tocTitleClean ||
                    (accClean.length > 5 && accClean.includes(tocTitleClean)) ||
                    (tocTitleClean.length > 5 && tocTitleClean.includes(accClean))) {
                    itemsToRemove = i;
                  } else if (accClean.length > tocTitleClean.length + 10) {
                    break;
                  }
                }

                if (itemsToRemove > 0) {
                  console.log(`      ✨ Deduplicated ${itemsToRemove} content header items for: "${title}"`);
                  filteredItems.splice(1, itemsToRemove);
                }
              }
            }

            if (filteredItems.length > 0) {
              orderedChapters[tocIndex] = {
                number: tocIndex + 1,
                orderIndex: tocIndex + 1,
                tocIndex,
                spineIndex,
                title,
                originalTitle: title,
                content: filteredItems,
              };
              console.log(`   ✅ "${title}" (${filteredItems.length - 1} items)`);
            }
          };

          const finalizeParsing = () => {
            let present = orderedChapters
              .filter((ch) => ch && ch.content && ch.content.length > 0)
              .map((ch) => ch as CLIChapter);

            present.sort((a, b) => {
              const sa = a.spineIndex ?? Number.POSITIVE_INFINITY;
              const sb = b.spineIndex ?? Number.POSITIVE_INFINITY;
              if (sa !== sb) return sa - sb;
              return (a.tocIndex || 0) - (b.tocIndex || 0);
            });

            if (typeof self.limitChapters === 'number' && self.limitChapters > 0) {
              present = present.slice(0, self.limitChapters);
            }

            present.forEach((ch, index) => {
              ch.number = index + 1;
              ch.orderIndex = index + 1;
              if (Array.isArray(ch.content)) {
                ch.content = ch.content.map((p, i) => ({
                  ...p,
                  id: p.type === 'chapter' ? `t-${index + 1}-${i}` : `p-${index + 1}-${i}`,
                }));
              }
            });

            console.log(`   Final result: ${present.length} chapters`);

            resolve({
              title: metadata.title,
              originalTitle: metadata.title,
              author: metadata.author,
              language: metadata.language,
              chapters: present,
              styles: globalStyles,
            });
          };

          if (chapterEntries.length === 0) {
            console.log('   ⚠️  No TOC entries found. Falling back to spine order.');
            const spineItems = epub.spine.contents || [];
            let processed = 0;
            if (spineItems.length === 0) {
              reject(new Error('No chapters found in TOC or spine'));
              return;
            }
            spineItems.forEach((item: any, idx: number) => {
              epub.getChapter(item.id, (err: any, html: string) => {
                if (!err && html) {
                  processChapter(idx, idx, item.title || `Chapter ${idx + 1}`, html, item.id);
                }
                processed++;
                if (processed === spineItems.length) finalizeParsing();
              });
            });
          }
        } catch (parseError) {
          reject(parseError);
        }
      });

      epub.on('error', (err: any) => reject(err));
      epub.parse();
    });
  }

  private parsePdfFile(): BookData {
    throw new Error('PDF parsing not yet implemented. Use TXT files for now.');
  }

  private async translateContent(bookData: BookData): Promise<TranslatedContent> {
    let totalSegments = 0;

    const chaptersToTranslate = bookData.chapters.map((chapter) => ({
      title: chapter.title,
      items: chapter.content.map((item) => item.text),
    }));

    const translatedChapters = await this.translator.translateChapters(
      chaptersToTranslate,
      {
        sourceLanguage: this.sourceLang,
        targetLanguage: this.targetLang,
        chapterConcurrency: this.chapterConcurrency,
        onProgress: (progress, current, total) => {
          totalSegments = current;
          if (current % 10 === 0) process.stdout.write('.');
        },
      }
    );

    const results: TranslatedChapter[] = bookData.chapters.map((chapter, idx) => {
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
    });

    console.log('');
    return { chapters: results, totalSegments };
  }

  private async importToDatabase(
    bookData: BookData,
    translatedContent: TranslatedContent
  ): Promise<string> {
    const bookUuid = uuidv4();
    const languagePair = `${this.sourceLang}-${this.targetLang}`;

    // Use shared SQL builder
    const sql = buildBookImportSql({
      bookUuid,
      metadata: {
        title: bookData.title,
        originalTitle: bookData.title,
        author: bookData.author,
        languagePair,
        styles: bookData.styles,
      },
      chapters: translatedContent.chapters,
      userId: null, // CLI imports are public
    });

    if (this.sqlOut) {
      const outPath = path.resolve(process.cwd(), this.sqlOut);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, sql, 'utf8');
      console.log(`   📝 Wrote SQL to ${outPath}`);

      if (this.applyMode === 'local') {
        console.log('   📥 Applying SQL file to local D1...');
        execSync(`npx wrangler d1 execute ovid-db --local --file=${outPath}`, { stdio: 'inherit' });
      } else if (this.applyMode === 'remote') {
        console.log('   ☁️  Applying SQL file to remote D1...');
        execSync(`npx wrangler d1 execute ovid-db --remote --file=${outPath}`, { stdio: 'inherit' });
      } else {
        console.log('   ℹ️  SQL not applied automatically (use --apply=local|remote to apply).');
      }

      return bookUuid;
    }

    // Default: local execution
    const tempSqlPath = path.resolve(process.cwd(), `.temp_import_${bookUuid}.sql`);

    try {
      console.log('   📝 Generating temporary SQL for import...');
      fs.writeFileSync(tempSqlPath, sql, 'utf8');

      console.log('   📥 Executing SQL import...');
      const env = { ...process.env };
      Object.keys(env).forEach((key) => {
        if (key.startsWith('npm_config_')) delete env[key];
      });

      execSync(`npx wrangler d1 execute ovid-db --local --file="${tempSqlPath}"`, {
        stdio: 'inherit',
        env,
      });

      return bookUuid;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Database import error:', errorMessage);
      throw error;
    } finally {
      if (fs.existsSync(tempSqlPath)) fs.unlinkSync(tempSqlPath);
    }
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
📚 Ovid Book Import System

Usage:
  ts-node scripts/import-book.ts --file="book.epub" --target="zh"

Options:
  --file         Path to book file (TXT, EPUB, PDF)
  --target       Target language code (${Object.keys(SUPPORTED_LANGUAGES).join(', ')})
  --title        Book title (for TXT files)
  --author       Book author (for TXT files)
  --source       Source language code (default: en)
  --sql-out      Write a single SQL file with all INSERTs instead of executing
  --apply        Apply the generated SQL automatically: local | remote
  --chapters-concurrency  Number of chapters to translate in parallel (default: 2)
  --items-concurrency     Number of items per chapter to translate in parallel (default: 8)
  --concurrency           Alias for --items-concurrency

Environment Variables:
  OPENAI_API_KEY        Your OpenAI API key (required for translation)
  OPENAI_API_BASE_URL   API base URL (default: https://api.openai.com/v1)
  OPENAI_MODEL          Model to use (default: gpt-4o-mini)

Examples:
  ts-node scripts/import-book.ts --file="book.txt" --target="zh" --title="My Book"
  ts-node scripts/import-book.ts --file="novel.epub" --target="es"
  ts-node scripts/import-book.ts --file="novel.epub" --target="zh" --sql-out=exports/novel.sql --apply=local

Supported Languages: ${Object.entries(SUPPORTED_LANGUAGES)
    .map(([k, v]) => `${k}(${v})`)
    .join(', ')}
`);
}

async function main() {
  const options = parseArgs();

  if (options.help || !options.file) {
    showHelp();
    process.exit(0);
  }

  try {
    const importer = new BookImporter(options);
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

export default BookImporter;
