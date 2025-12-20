#!/usr/bin/env node

/**
 * Ovid Book Import System
 *
 * Imports EPUB/TXT files and generates bilingual content using translation APIs
 *
 * Usage:
 *   node scripts/import-book.js --file="book.epub" --target="zh" --provider="openai"
 *   node scripts/import-book.js --file="book.txt" --title="Book Title" --author="Author" --target="es" --provider="google"
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const OpenAI = require('openai');
// Ensure Wrangler writes config/logs inside the workspace to avoid permission issues
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || require('path').resolve(process.cwd(), '.wrangler_cfg');

// Configuration
const SUPPORTED_FORMATS = ['.epub', '.txt', '.pdf'];
const SUPPORTED_LANGUAGES = {
  'zh': 'Chinese',
  'es': 'Spanish', 
  'fr': 'French',
  'de': 'German',
  'ja': 'Japanese',
  'ko': 'Korean',
  'ru': 'Russian'
};

const TRANSLATION_PROVIDERS = {
  'openai': 'OpenAI GPT-4',
  'google': 'Google Translate',
  'deepl': 'DeepL'
};

class BookImporter {
  constructor(options = {}) {
    this.file = options.file;
    this.targetLang = options.target || 'zh';
    this.provider = options.provider || 'openai';
    this.title = options.title;
    this.author = options.author;
    this.sourceLang = options.source || 'en';
    this.limitChapters = options['limit-chapters'] ? parseInt(options['limit-chapters'], 10) : undefined;
    this.limitParagraphs = options['limit-paragraphs'] ? parseInt(options['limit-paragraphs'], 10) : undefined;
    // Concurrency (optional)
    const cc = options['chapters-concurrency'] || options['chaptersConcurrency'];
    const ic = options['items-concurrency'] || options['itemsConcurrency'] || options['concurrency'];
    this.chapterConcurrency = cc ? Math.max(1, parseInt(cc, 10)) : 2;   // default: 2 chapters at a time
    this.itemConcurrency = ic ? Math.max(1, parseInt(ic, 10)) : 8;      // default: 8 items per chapter
    // Optional: generate a single SQL file instead of executing per-statement
    this.sqlOut = options['sql-out'] || options['sqlOut'] || null; // e.g., path/to/book.sql
    this.applyMode = options['apply'] || null; // 'local' | 'remote' | null
    
    // Initialize OpenAI client if using OpenAI provider
    if (this.provider === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      const baseURL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
      
      if (!apiKey) {
        console.warn('⚠️  OPENAI_API_KEY not found in environment variables. Using mock translations.');
        this.openaiConfigured = false;
      } else {
        this.openai = new OpenAI({
          apiKey: apiKey,
          baseURL: baseURL
        });
        this.openaiConfigured = true;
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
        console.log(`🔧 OpenAI API configured with base URL: ${baseURL}`);
        console.log(`🤖 Using model: ${model}`);
      }
    }
    
    this.validateInputs();
  }

  validateInputs() {
    // Resolve input file path with support for epubs and @epubs directories
    this.file = this.resolveFilePath(this.file);
    if (!this.file) {
      throw new Error(`File not found. Looked in: ./, ./epubs, ./@epubs`);
    }

    // Check file format
    const ext = path.extname(this.file).toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext)) {
      throw new Error(`Unsupported format: ${ext}. Supported: ${SUPPORTED_FORMATS.join(', ')}`);
    }

    // Check target language
    if (!SUPPORTED_LANGUAGES[this.targetLang]) {
      throw new Error(`Unsupported target language: ${this.targetLang}. Supported: ${Object.keys(SUPPORTED_LANGUAGES).join(', ')}`);
    }

    // Check translation provider
    if (!TRANSLATION_PROVIDERS[this.provider]) {
      throw new Error(`Unsupported provider: ${this.provider}. Supported: ${Object.keys(TRANSLATION_PROVIDERS).join(', ')}`);
    }
  }

  resolveFilePath(input) {
    const p = require('path');
    const fs = require('fs');
    if (!input || typeof input !== 'string') return null;

    // If absolute and exists, return as-is
    if (p.isAbsolute(input) && fs.existsSync(input)) return input;

    // Normalize potential @epubs/ alias and common relative forms
    const candidates = [];
    const cleaned = input.replace(/^\.\//, '');

    // As provided (relative to CWD)
    candidates.push(input);

    // If user used 'epubs/...', also try '@epubs/...', and vice versa
    if (cleaned.startsWith('epubs/')) {
      candidates.push(`@${cleaned}`); // @epubs/...
    }
    if (cleaned.startsWith('@epubs/')) {
      candidates.push(cleaned.replace(/^@/, ''));
    }

    // Try within ./epubs and ./@epubs if input is a bare filename or path not starting there
    const baseName = p.basename(cleaned);
    if (!cleaned.includes('/')) {
      candidates.push(p.join('epubs', baseName));
      candidates.push(p.join('@epubs', baseName));
    }

    // Resolve to absolute paths and check existence
    for (const c of candidates) {
      const abs = p.resolve(process.cwd(), c);
      if (fs.existsSync(abs)) return abs;
    }

    return null;
  }

  async import() {
    console.log('📚 Ovid Book Import System');
    console.log('='.repeat(40));
    console.log(`📖 File: ${this.file}`);
    console.log(`🌍 Target Language: ${SUPPORTED_LANGUAGES[this.targetLang]}`);
    console.log(`🔧 Provider: ${TRANSLATION_PROVIDERS[this.provider]}`);
    console.log('');

    try {
      // Step 1: Parse book file
      console.log('🔍 Step 1: Parsing book file...');
      const bookData = await this.parseBook();
      console.log(`   ✅ Found ${bookData.chapters.length} chapters`);

      // Step 2: Generate translations
      console.log('🔄 Step 2: Generating translations...');
      const translatedContent = await this.translateContent(bookData);
      console.log(`   ✅ Translated ${translatedContent.totalSegments} text segments`);

      // Step 3: Import to database (or generate SQL file)
      console.log('💾 Step 3: Importing to database...');
      const bookId = await this.importToDatabase(bookData, translatedContent);
      console.log(`   ✅ Book imported with UUID: ${bookId}`);

      console.log('');
      console.log('🎉 Import completed successfully!');
      console.log(`📱 Access your book at: /book/${bookId}`);

      return bookId;

    } catch (error) {
      console.error('❌ Import failed:', error.message);
      process.exit(1);
    }
  }

  async parseBook() {
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

  parseTxtFile() {
    const content = fs.readFileSync(this.file, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    // Simple chapter detection - lines starting with "Chapter" or numbers
    const chapters = [];
    let currentChapter = null;
    let chapterCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Detect chapter headers
      if (this.isChapterHeader(trimmed)) {
        if (currentChapter) {
          chapters.push(currentChapter);
        }
        chapterCount++;
        currentChapter = {
          number: chapterCount,
          title: trimmed,
          originalTitle: trimmed,
          content: []
        };
      } else if (trimmed && currentChapter) {
        // Add paragraph to current chapter
        currentChapter.content.push({
          id: `p-${currentChapter.number}-${currentChapter.content.length + 1}`,
          text: trimmed,
          type: 'paragraph'
        });
      }
    }

    if (currentChapter) {
      chapters.push(currentChapter);
    }

    return {
      title: this.title || path.basename(this.file, '.txt'),
      author: this.author || 'Unknown Author',
      language: this.sourceLang,
      chapters: chapters
    };
  }

  isChapterHeader(line) {
    // Simple heuristics for chapter detection
    return /^(Chapter|CHAPTER|第.{1,3}章|\d+\.)/i.test(line) && line.length < 100;
  }

  parseEpubFile() {
    const { EPub } = require('epub2');
    const fs = require('fs');
    const path = require('path');
    const posixPath = path.posix || path; // ensure posix-style normalization for hrefs
    
    return new Promise((resolve, reject) => {
      const epub = new EPub(this.file);
      epub.on("end", () => {
        try {
          const metadata = {
            title: this.title || epub.metadata.title || path.basename(this.file, '.epub'),
            author: this.author || epub.metadata.creator || 'Unknown Author',
            language: this.sourceLang || epub.metadata.language || 'en'
          };
          
          console.log(`   Using TOC-based chapter detection`);
          console.log(`   Found ${epub.toc.length} TOC entries`);

          // Prefer TOC order as-is to preserve original author-defined order.
          // Lightly filter out obvious non-reading items like cover/toc if present.
          let chapterEntries = (epub.toc || []).filter(entry => {
            const title = (entry.title || '').toLowerCase();
            const href = (entry.href || '').toLowerCase();
            const isCover = title.includes('cover') || href.includes('cover');
            const isToc = title.includes('table of contents') || title === 'contents' || href.includes('nav') || title.includes('toc');
            return !(isCover || isToc);
          });

          // Fallback: if filtering removed everything, use all TOC entries
          if (chapterEntries.length === 0 && epub.toc && epub.toc.length > 0) {
            chapterEntries = epub.toc.slice();
          }

          console.log(`   TOC chapters considered: ${chapterEntries.length}`);


          // Build href -> manifest id map for reliable resolution
          const hrefToId = {};
          for (const id in epub.manifest) {
            const hrefRaw = epub.manifest[id].href || '';
            const normalized = posixPath.normalize(decodeURI(hrefRaw)).replace(/^\/*/, '');
            hrefToId[normalized] = id;
            // also map by filename as a fallback key
            const filename = normalized.split('/').pop();
            if (filename && !hrefToId[filename]) {
              hrefToId[filename] = id;
            }
          }

          // Build spine order map (manifest id -> spine index) using OPF spine reading order
          const spineIndexById = {};
          const spineIndexByHref = {};
          (epub.spine.contents || []).forEach((item, idx) => {
            spineIndexById[item.id] = idx;
            // also map by href if available
            const man = epub.manifest[item.id];
            if (man && man.href) {
              const n = posixPath.normalize(decodeURI(man.href)).replace(/^\/*/, '');
              spineIndexByHref[n] = idx;
            }
          });

          // We will fill results by TOC index to keep deterministic order
          const orderedChapters = new Array(chapterEntries.length).fill(null);
          let processedChapters = 0;
          
          const self = this; // capture for inner functions
          // Process each chapter entry
          chapterEntries.forEach((entry, index) => {
            // Extract the file ID from href (e.g., "OEBPS/text/file.xhtml" -> find matching ID)
            const href = (entry.href || '').split('#')[0]; // Remove anchor
            const normalizedHref = posixPath.normalize(decodeURI(href)).replace(/^\/*/, '');
            
            // Find the corresponding spine/manifest item by href
            let fileId = null;
            
            // First try exact/normalized match
            if (hrefToId[normalizedHref]) {
              fileId = hrefToId[normalizedHref];
            } else {
              // Fallback: try by filename only
              const filename = normalizedHref.split('/').pop();
              if (filename && hrefToId[filename]) {
                fileId = hrefToId[filename];
              }
            }
            
            if (!fileId) {
              console.log(`   ❌ Could not find file for: ${entry.title} (${href})`);
              processedChapters++;
              if (processedChapters === chapterEntries.length) {
                finalizeParsing();
              }
              return;
            }
            
            // Determine spine index for this entry for canonical ordering
            const spineIndex = (spineIndexById[fileId] !== undefined)
              ? spineIndexById[fileId]
              : (spineIndexByHref[normalizedHref] !== undefined ? spineIndexByHref[normalizedHref] : Number.POSITIVE_INFINITY);

            // Get the chapter content
            epub.getChapter(fileId, (err, text) => {
              if (err || !text) {
                console.log(`   ⚠️ Could not read content for: ${entry.title} (${fileId})`);
              } else {
                processChapter(index, spineIndex, entry.title, text);
              }
              
              processedChapters++;
              if (processedChapters === chapterEntries.length) {
                finalizeParsing();
              }
            });
          });
          
          function processChapter(tocIndex, spineIndex, title, text) {
            // Better HTML cleanup preserving paragraph structure
            let cleanText = text
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<\/?(p|div|h[1-6]|br)\s*[^>]*>/gi, '\n\n')
              .replace(/<[^>]+>/g, ' ')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n\s*\n\s*\n+/g, '\n\n')
              .trim();
            
            // Skip threshold set to 0 to include all chapters
            if (cleanText.length < 0) {
              console.log(`   Skipped: "${title}" (${cleanText.length} chars, too short)`);
              return;
            }
            
            // Split into paragraphs on double line breaks
            let paragraphs = cleanText
              .split(/\n\s*\n/)
              .map(p => p.replace(/\n/g, ' ').trim())
              .filter(p => p.length > 30)
              .map((p, i) => ({
                // Use TOC index for deterministic IDs; will be renumbered later
                id: `p-${tocIndex + 1}-${i + 1}`,
                text: p,
                type: 'paragraph',
                tagName: 'p'
              }));

            if (typeof self.limitParagraphs === 'number' && self.limitParagraphs > 0) {
              paragraphs = paragraphs.slice(0, self.limitParagraphs);
            }

            if (paragraphs.length > 0) {
              // Prepend a synthetic chapter title item so reader displays it
              const titleItem = {
                id: `t-${tocIndex + 1}`,
                text: String(title || `Chapter ${tocIndex + 1}`),
                type: 'chapter',
                tagName: 'h3'
              };

              const items = [titleItem, ...paragraphs];

              orderedChapters[tocIndex] = {
                // number will be assigned after filtering to preserve sequence
                number: tocIndex + 1,
                orderIndex: tocIndex + 1,
                tocIndex,
                spineIndex,
                title: title,
                originalTitle: title,
                content: items
              };
              console.log(`   ✅ "${title}" (${paragraphs.length} paragraphs)`);
            }
          }
          
          function finalizeParsing() {
            // Drop null/short entries, then order by OPF spine index with TOC index as tiebreaker
            let present = orderedChapters
              .filter(ch => ch && ch.content && ch.content.length > 0)
              .map(ch => ch);
            present.sort((a, b) => {
              const sa = a.spineIndex === undefined ? Number.POSITIVE_INFINITY : a.spineIndex;
              const sb = b.spineIndex === undefined ? Number.POSITIVE_INFINITY : b.spineIndex;
              if (sa !== sb) return sa - sb;
              return (a.tocIndex || 0) - (b.tocIndex || 0);
            });

            if (typeof self.limitChapters === 'number' && self.limitChapters > 0) {
              present = present.slice(0, self.limitChapters);
            }

            // Assign final chapter numbers in displayed order
            present.forEach((ch, index) => {
              ch.number = index + 1;
              ch.orderIndex = index + 1;
              // Renumber paragraph IDs to reflect final chapter number for consistency
              if (Array.isArray(ch.content)) {
                ch.content = ch.content.map((p, i) => ({
                  ...p,
                  // Keep title item with 't-' prefix; paragraphs use running index
                  id: p.type === 'chapter' ? `t-${index + 1}` : `p-${index + 1}-${i}`
                }));
              }
            });
            
            console.log(`   Final result: ${present.length} chapters`);
            
            resolve({
              title: metadata.title,
              author: metadata.author,
              language: metadata.language,
              chapters: present
            });
          }
          
          if (chapterEntries.length === 0) {
            // As a fallback, attempt to use spine order to preserve reading sequence
            console.log('   ⚠️  No TOC entries found. Falling back to spine order.');
            const spineItems = epub.spine.contents || [];
            let processed = 0;
            if (spineItems.length === 0) {
              reject(new Error('No chapters found in TOC or spine'));
              return;
            }
            spineItems.forEach((item, idx) => {
              epub.getChapter(item.id, (err, text) => {
                if (!err && text) {
                  processChapter(idx, item.title || `Chapter ${idx + 1}`, text);
                }
                processed++;
                if (processed === spineItems.length) {
                  finalizeParsing();
                }
              });
            });
          }

        } catch (parseError) {
          reject(parseError);
        }
      });
      
      epub.on("error", (err) => {
        reject(err);
      });
      
      epub.parse();
    });
  }

  parsePdfFile() {
    // TODO: Implement PDF parsing using pdf-parse library
    throw new Error('PDF parsing not yet implemented. Use TXT files for now.');
  }

  async translateContent(bookData) {
    let totalSegments = 0;
    const translatedChapters = new Array(bookData.chapters.length);

    // Limited-parallel map helper
    const mapPool = async (arr, limit, iterator) => {
      const results = new Array(arr.length);
      let i = 0;
      const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
        while (true) {
          const idx = i++;
          if (idx >= arr.length) break;
          results[idx] = await iterator(arr[idx], idx);
        }
      });
      await Promise.all(workers);
      return results;
    };

    // Translate multiple chapters concurrently
    await mapPool(bookData.chapters, this.chapterConcurrency, async (chapter, chapterIdx) => {
      console.log(`   📄 Translating Chapter ${chapter.number}: ${chapter.title.substring(0, 50)}...`);

      // Translate items within a chapter with limited concurrency
      const translatedContent = await mapPool(chapter.content, this.itemConcurrency, async (item) => {
        const translation = await this.translateText(item.text);
        totalSegments++;
        if (totalSegments % 10 === 0) process.stdout.write('.');
        return {
          ...item,
          originalText: item.text,
          translatedText: translation
        };
      });

      const translatedTitle = await this.translateText(chapter.title);
      translatedChapters[chapterIdx] = {
        ...chapter,
        translatedTitle,
        content: translatedContent
      };
    });

    console.log(''); // New line after progress dots
    return {
      chapters: translatedChapters,
      totalSegments
    };
  }

  async translateText(text) {
    switch (this.provider) {
      case 'openai':
        return this.translateWithOpenAI(text);
      case 'google':
        return this.translateWithGoogle(text);
      case 'deepl':
        return this.translateWithDeepL(text);
      default:
        throw new Error(`Translation provider not implemented: ${this.provider}`);
    }
  }

  async translateWithOpenAI(text) {
    if (!this.openaiConfigured) {
      return `[${this.targetLang.toUpperCase()}] ${text}`;
    }

    try {
      const targetLanguage = SUPPORTED_LANGUAGES[this.targetLang] || this.targetLang;
      
      const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
      
      const response = await this.openai.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: `You are a professional literary translator. Translate the following English text to ${targetLanguage}. Maintain the original style, tone, and meaning. Preserve paragraph breaks and formatting. Return only the translation without any additional commentary.`
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.3,
        max_tokens: text.length * 2, // Allow for expansion in translation
      });

      const translation = response.choices[0]?.message?.content;
      if (!translation) {
        throw new Error('Empty response from OpenAI API');
      }

      return translation.trim();

    } catch (error) {
      console.warn(`⚠️  OpenAI API error for text "${text.substring(0, 50)}...": ${error.message}`);
      console.warn('   Falling back to mock translation');
      return `[${this.targetLang.toUpperCase()}] ${text}`;
    }
  }

  async translateWithGoogle(text) {
    // Mock implementation - replace with actual Google Translate API call
    console.log('⚠️  Using mock translation (Google Translate not configured)');
    return `[${this.targetLang.toUpperCase()}] ${text}`;
  }

  async translateWithDeepL(text) {
    // Mock implementation - replace with actual DeepL API call
    console.log('⚠️  Using mock translation (DeepL not configured)');
    return `[${this.targetLang.toUpperCase()}] ${text}`;
  }

  buildImportSql(bookData, translatedContent, bookUuid, languagePair) {
    const lines = [];
    lines.push('-- Ovid import SQL');
    // Insert book
    lines.push(`INSERT INTO books (title, original_title, author, language_pair, styles, uuid) VALUES ('${this.escapeSql(bookData.title)}', '${this.escapeSql(bookData.title)}', '${this.escapeSql(bookData.author)}', '${this.escapeSql(languagePair)}', '{}' , '${bookUuid}');`);
    const bookIdExpr = `(SELECT id FROM books WHERE uuid='${bookUuid}')`;
    // Chapters
    for (let i = 0; i < translatedContent.chapters.length; i++) {
      const chapter = translatedContent.chapters[i];
      lines.push(`INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) VALUES (${bookIdExpr}, ${chapter.number}, '${this.escapeSql(chapter.translatedTitle)}', '${this.escapeSql(chapter.title)}', ${chapter.number});`);
    }
    // Content items
    let globalContentOrder = 1;
    for (let i = 0; i < translatedContent.chapters.length; i++) {
      const chapter = translatedContent.chapters[i];
      const chapterIdExpr = `(SELECT id FROM chapters WHERE book_id=${bookIdExpr} AND chapter_number=${chapter.number})`;
      for (let j = 0; j < chapter.content.length; j++) {
        const item = chapter.content[j];
        const itemType = item.type ? this.escapeSql(item.type) : 'paragraph';
        const tagName = item.tagName ? this.escapeSql(item.tagName) : (item.type === 'chapter' ? 'h3' : 'p');
        lines.push(`INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, tag_name, order_index) VALUES (${bookIdExpr}, ${chapterIdExpr}, '${this.escapeSql(item.id)}', '${this.escapeSql(item.originalText)}', '${this.escapeSql(item.translatedText)}', '${itemType}', '${tagName}', ${globalContentOrder});`);
        globalContentOrder++;
      }
    }
    return lines.join('\n');
  }

  async importToDatabase(bookData, translatedContent) {
    const bookUuid = uuidv4();
    const languagePair = `${this.sourceLang}-${this.targetLang}`;

    // If user requested SQL file generation, build and write it, and optionally apply.
    if (this.sqlOut) {
      const outPath = path.resolve(process.cwd(), this.sqlOut);
      const sql = this.buildImportSql(bookData, translatedContent, bookUuid, languagePair);
      // Ensure parent directory exists
      const dir = require('path').dirname(outPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outPath, sql, 'utf8');
      console.log(`   📝 Wrote SQL to ${outPath}`);

      if (this.applyMode === 'local') {
        console.log('   📥 Applying SQL file to local D1...');
        execSync(`npx wrangler d1 execute polyink-db --local --file=${outPath}`, { stdio: 'inherit' });
      } else if (this.applyMode === 'remote') {
        console.log('   ☁️  Applying SQL file to remote D1...');
        execSync(`npx wrangler d1 execute polyink-db --remote --file=${outPath}`, { stdio: 'inherit' });
      } else {
        console.log('   ℹ️  SQL not applied automatically (use --apply=local|remote to apply).');
      }

      return bookUuid;
    }

    // Default: per-statement execution (existing behavior)
    try {
      // Insert book
      const bookSql = `INSERT INTO books (title, original_title, author, language_pair, styles, uuid) VALUES ('${bookData.title}', '${bookData.title}', '${bookData.author}', '${languagePair}', '{}', '${bookUuid}');`;
      execSync(`npm run db:local -- "${bookSql}"`, { stdio: 'inherit' });

      // Get book ID
      const getBookIdSql = `SELECT id FROM books WHERE uuid = '${bookUuid}';`;
      const result = execSync(`npm run db:local -- "${getBookIdSql}"`, { encoding: 'utf8' });
      const bookId = this.extractBookIdFromResult(result);

      // Insert chapters and content
      let globalContentOrder = 1; // maintain a single increasing order across the whole book
      for (let i = 0; i < translatedContent.chapters.length; i++) {
        const chapter = translatedContent.chapters[i];
        
        // Insert chapter
        const chapterSql = `INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) VALUES (${bookId}, ${chapter.number}, '${this.escapeSql(chapter.translatedTitle)}', '${this.escapeSql(chapter.title)}', ${chapter.number});`;
        execSync(`npm run db:local -- "${chapterSql}"`, { stdio: 'inherit' });

        // Get actual chapter ID from database
        const getChapterIdSql = `SELECT id FROM chapters WHERE book_id = ${bookId} AND chapter_number = ${chapter.number};`;
        const chapterResult = execSync(`npm run db:local -- "${getChapterIdSql}"`, { encoding: 'utf8' });
        const chapterId = this.extractIdFromResult(chapterResult);

        // Insert content items
        for (let j = 0; j < chapter.content.length; j++) {
          const item = chapter.content[j];
          const itemType = item.type ? this.escapeSql(item.type) : 'paragraph';
          const tagName = item.tagName ? this.escapeSql(item.tagName) : (item.type === 'chapter' ? 'h3' : 'p');
          const contentSql = `INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, tag_name, order_index) VALUES (${bookId}, ${chapterId}, '${item.id}', '${this.escapeSql(item.originalText)}', '${this.escapeSql(item.translatedText)}', '${itemType}', '${tagName}', ${globalContentOrder});`;
          
          try {
            execSync(`npm run db:local -- "${contentSql}"`, { stdio: 'pipe' });
          } catch (error) {
            console.log(`⚠️  Warning: Failed to insert content item ${item.id}: ${error.message}`);
            console.log(`   SQL: ${contentSql.substring(0, 200)}...`);
          }
          globalContentOrder++;
        }
      }

      return bookUuid;

    } catch (error) {
      console.error('Database import error:', error.message);
      throw error;
    }
  }

  extractBookIdFromResult(result) {
    // Extract book ID from SQL result - simplified parsing
    const match = result.match(/"id":\s*(\d+)/);
    return match ? parseInt(match[1]) : 1;
  }
  
  extractIdFromResult(result) {
    // Extract ID from SQL result - simplified parsing
    const match = result.match(/"id":\s*(\d+)/);
    return match ? parseInt(match[1]) : 1;
  }

  escapeSql(text) {
    if (!text) return '';
    // Escape single quotes by doubling them and escape backslashes
    return text.replace(/\\/g, '\\\\').replace(/'/g, "''");
  }
}

// CLI Interface
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.split('=');
      const cleanKey = key.replace('--', '');
      options[cleanKey] = value || true;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
📚 Ovid Book Import System

Usage:
  node scripts/import-book.js --file="book.txt" --target="zh" --provider="openai"

Options:
  --file         Path to book file (TXT, EPUB, PDF)
  --target       Target language code (${Object.keys(SUPPORTED_LANGUAGES).join(', ')})
  --provider     Translation provider (${Object.keys(TRANSLATION_PROVIDERS).join(', ')})
  --title        Book title (for TXT files)
  --author       Book author (for TXT files)
  --source       Source language code (default: en)
  --sql-out      Write a single SQL file with all INSERTs instead of executing
  --apply        Apply the generated SQL automatically: local | remote
  --chapters-concurrency  Number of chapters to translate in parallel (default: 2)
  --items-concurrency     Number of items per chapter to translate in parallel (default: 8)
  --concurrency           Alias for --items-concurrency

Examples:
  node scripts/import-book.js --file="book.txt" --target="zh" --title="My Book"
  node scripts/import-book.js --file="novel.epub" --target="es" --provider="google"
  node scripts/import-book.js --file="novel.epub" --target="zh" --sql-out=exports/novel.sql --apply=local
  node scripts/import-book.js --file="novel.epub" --target="zh" --chapters-concurrency=3 --concurrency=10

Notes:
  - You can place files under ./epubs or ./@epubs and pass either path.
    The importer will resolve among ./, ./epubs, and ./@epubs automatically.

Supported Languages: ${Object.entries(SUPPORTED_LANGUAGES).map(([k,v]) => `${k}(${v})`).join(', ')}
`);
}

// Main execution
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
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Only run if called directly
if (require.main === module) {
  main();
}

module.exports = BookImporter;
