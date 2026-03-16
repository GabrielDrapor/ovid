#!/usr/bin/env ts-node
/**
 * Quick import using BookProcessor.parseEPUBV2 (known working parser)
 * + Translator for translation. Bypasses the buggy import-book.ts fragment logic.
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import { BookProcessor } from '../src/utils/book-processor';
import { Translator, SimpleKVStore } from '../src/utils/translator';

process.env.XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || path.resolve(process.cwd(), '.wrangler_cfg');

const DB_NAME = 'ovid-db';
const DB_ID = 'df1769fb-c23b-4151-85cc-0e00ed591f2b';

function d1exec(sql: string): any {
  const escaped = sql.replace(/'/g, "'\\''");
  const result = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command='${escaped}'`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(result);
}

async function main() {
  const filePath = process.argv.find(a => a.startsWith('--file='))?.split('=')[1];
  const target = process.argv.find(a => a.startsWith('--target='))?.split('=')[1] || 'zh';
  const source = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'en';
  const coverUrl = process.argv.find(a => a.startsWith('--cover='))?.split('=')[1];
  const spineUrl = process.argv.find(a => a.startsWith('--spine='))?.split('=')[1];

  if (!filePath) {
    console.error('Usage: ts-node quick-import.ts --file=book.epub --target=zh');
    process.exit(1);
  }

  const buf = fs.readFileSync(filePath);
  const processor = new BookProcessor(1, {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_API_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENAI_MODEL || 'anthropic/claude-3.7-sonnet',
  });

  console.log('📖 Parsing EPUB...');
  const bookData = await processor.parseEPUBV2(buf.buffer);

  // Filter out license/gutenberg metadata chapters
  const contentChapters = bookData.chapters.filter(ch => {
    const title = ch.originalTitle.toUpperCase();
    return !title.includes('GUTENBERG') && !title.includes('LICENSE');
  });

  console.log(`✅ Parsed: "${bookData.title}" by ${bookData.author}`);
  console.log(`   ${contentChapters.length} content chapters, ${contentChapters.reduce((s, c) => s + c.textNodes.length, 0)} text nodes`);

  // Setup translator
  const kvStore = new SimpleKVStore();
  const translator = new Translator({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_API_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENAI_MODEL || 'anthropic/claude-3.7-sonnet',
    concurrency: 5,
    kvStore,
  });

  // Extract glossary
  console.log('📝 Extracting glossary...');
  const allTexts = contentChapters.flatMap(ch => ch.textNodes.map(n => n.text));
  const glossary = await translator.extractProperNouns(allTexts, {
    sourceLanguage: source,
    targetLanguage: target,
  });
  console.log(`   ✅ ${Object.keys(glossary).length} proper nouns`);

  // Translate book title
  console.log('📝 Translating title...');
  const translatedTitle = await translator.translateText(bookData.title, {
    sourceLanguage: source,
    targetLanguage: target,
  });
  console.log(`   "${bookData.title}" → "${translatedTitle}"`);

  // Insert book shell
  const bookUuid = uuidv4();
  console.log(`\n📦 Inserting book shell (uuid: ${bookUuid})...`);

  // Auto-assign display_order
  const maxOrderResult = d1exec(`SELECT COALESCE(MAX(display_order), 0) as max_order FROM books_v2`);
  const nextOrder = (maxOrderResult[0].results[0].max_order || 0) + 1;

  d1exec(`INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, user_id, status, display_order, book_cover_img_url, book_spine_img_url)
    VALUES ('${bookUuid}', '${translatedTitle.replace(/'/g, "''")}', '${bookData.title.replace(/'/g, "''")}', '${bookData.author.replace(/'/g, "''")}', '${source}-${target}', '', NULL, 'processing', ${nextOrder}, ${coverUrl ? `'${coverUrl}'` : 'NULL'}, ${spineUrl ? `'${spineUrl}'` : 'NULL'})`);

  const bookRow = d1exec(`SELECT id FROM books_v2 WHERE uuid = '${bookUuid}'`);
  const bookId = bookRow[0].results[0].id;
  console.log(`   Book ID: ${bookId}`);

  // Insert chapters and translate
  for (let ci = 0; ci < contentChapters.length; ci++) {
    const chapter = contentChapters[ci];
    const chNum = ci + 1;

    // Translate chapter title
    let translatedChTitle = chapter.originalTitle;
    try {
      translatedChTitle = await translator.translateText(chapter.originalTitle, {
        sourceLanguage: source,
        targetLanguage: target,
      });
    } catch {}

    // Insert chapter (skip rawHtml if too large)
    const rawHtmlSize = new TextEncoder().encode(chapter.rawHtml).length;
    if (rawHtmlSize < 50000) {
      const escapedHtml = chapter.rawHtml.replace(/'/g, "''");
      try {
        d1exec(`INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, raw_html, order_index)
          VALUES (${bookId}, ${chNum}, '${translatedChTitle.replace(/'/g, "''")}', '${chapter.originalTitle.replace(/'/g, "''")}', '${escapedHtml}', ${chNum})`);
      } catch {
        // If raw_html too big for single statement, skip it
        d1exec(`INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index)
          VALUES (${bookId}, ${chNum}, '${translatedChTitle.replace(/'/g, "''")}', '${chapter.originalTitle.replace(/'/g, "''")}', ${chNum})`);
      }
    } else {
      d1exec(`INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index)
        VALUES (${bookId}, ${chNum}, '${translatedChTitle.replace(/'/g, "''")}', '${chapter.originalTitle.replace(/'/g, "''")}', ${chNum})`);
    }

    const chRow = d1exec(`SELECT id FROM chapters_v2 WHERE book_id = ${bookId} AND chapter_number = ${chNum}`);
    const chapterId = chRow[0].results[0].id;

    // Translate text nodes in batches
    console.log(`\n📖 [${chNum}/${contentChapters.length}] "${chapter.originalTitle}" (${chapter.textNodes.length} nodes)...`);

    const batchSize = 10;
    for (let bi = 0; bi < chapter.textNodes.length; bi += batchSize) {
      const batch = chapter.textNodes.slice(bi, bi + batchSize);
      const textsToTranslate = batch.map(n => n.text);

      let translatedTexts: string[];
      try {
        translatedTexts = await translator.translateBatch(textsToTranslate, {
          sourceLanguage: source,
          targetLanguage: target,
        });
      } catch {
        // Fallback to individual
        translatedTexts = [];
        for (const t of textsToTranslate) {
          try {
            translatedTexts.push(await translator.translateText(t, { sourceLanguage: source, targetLanguage: target }));
          } catch {
            translatedTexts.push('[Translation pending]');
          }
        }
      }

      for (let j = 0; j < batch.length; j++) {
        const node = batch[j];
        const translated = translatedTexts[j] || '[Translation pending]';
        const escapedOriginal = node.text.replace(/'/g, "''");
        const escapedHtml = node.html.replace(/'/g, "''");
        const escapedTranslated = translated.replace(/'/g, "''");

        d1exec(`INSERT OR REPLACE INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index)
          VALUES (${chapterId}, '${node.xpath}', '${escapedOriginal}', '${escapedHtml}', '${escapedTranslated}', ${node.orderIndex})`);
      }

      process.stdout.write(`   ${Math.min(bi + batchSize, chapter.textNodes.length)}/${chapter.textNodes.length} `);
    }
    console.log('✅');
  }

  // Mark as ready
  d1exec(`UPDATE books_v2 SET status = 'ready' WHERE uuid = '${bookUuid}'`);
  console.log(`\n🎉 Done! Book "${translatedTitle}" imported successfully.`);
}

main().catch(e => { console.error(e); process.exit(1); });
