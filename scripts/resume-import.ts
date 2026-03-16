#!/usr/bin/env ts-node
/**
 * Resume an interrupted import. Picks up from where quick-import left off.
 */
import * as dotenv from 'dotenv';
dotenv.config({ override: true });
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { BookProcessor } from '../src/utils/book-processor';
import { Translator, SimpleKVStore } from '../src/utils/translator';

process.env.XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || path.resolve(process.cwd(), '.wrangler_cfg');

function d1exec(sql: string): any {
  const escaped = sql.replace(/'/g, "'\\''");
  const result = execSync(
    `npx wrangler d1 execute ovid-db --remote --json --command='${escaped}'`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(result);
}

async function main() {
  const filePath = process.argv.find(a => a.startsWith('--file='))?.split('=')[1];
  const bookUuid = process.argv.find(a => a.startsWith('--uuid='))?.split('=')[1];
  const target = process.argv.find(a => a.startsWith('--target='))?.split('=')[1] || 'zh';
  const source = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'en';

  if (!filePath || !bookUuid) {
    console.error('Usage: ts-node resume-import.ts --file=book.epub --uuid=<book-uuid> --target=zh');
    process.exit(1);
  }

  // Get existing book info
  const bookRow = d1exec(`SELECT id FROM books_v2 WHERE uuid = '${bookUuid}'`);
  const bookId = bookRow[0].results[0].id;
  console.log(`📖 Resuming book ID ${bookId} (${bookUuid})`);

  // Get existing chapters
  const existingChapters = d1exec(`SELECT chapter_number FROM chapters_v2 WHERE book_id = ${bookId} ORDER BY chapter_number`);
  const existingNums = new Set(existingChapters[0].results.map((r: any) => r.chapter_number));
  console.log(`   Existing chapters: ${existingNums.size}`);

  // Parse EPUB
  const buf = fs.readFileSync(filePath);
  const processor = new BookProcessor(1, {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_API_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENAI_MODEL || 'anthropic/claude-3.7-sonnet',
  });

  console.log('📖 Parsing EPUB...');
  const bookData = await processor.parseEPUBV2(buf.buffer);
  const contentChapters = bookData.chapters.filter(ch => {
    const title = ch.originalTitle.toUpperCase();
    return !title.includes('GUTENBERG') && !title.includes('LICENSE');
  });
  console.log(`   Total content chapters: ${contentChapters.length}`);

  // Setup translator
  const kvStore = new SimpleKVStore();
  const translator = new Translator({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_API_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.OPENAI_MODEL || 'anthropic/claude-3.7-sonnet',
    concurrency: 5,
    kvStore,
  });

  // Process missing chapters
  for (let ci = 0; ci < contentChapters.length; ci++) {
    const chNum = ci + 1;
    if (existingNums.has(chNum)) {
      console.log(`   ⏭️  Chapter ${chNum} exists, skipping`);
      continue;
    }

    const chapter = contentChapters[ci];

    // Translate chapter title
    let translatedChTitle = chapter.originalTitle;
    try {
      translatedChTitle = await translator.translateText(chapter.originalTitle, {
        sourceLanguage: source,
        targetLanguage: target,
      });
    } catch {}

    // Insert chapter
    const rawHtmlSize = new TextEncoder().encode(chapter.rawHtml).length;
    try {
      if (rawHtmlSize < 50000) {
        const escapedHtml = chapter.rawHtml.replace(/'/g, "''");
        d1exec(`INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, raw_html, order_index)
          VALUES (${bookId}, ${chNum}, '${translatedChTitle.replace(/'/g, "''")}', '${chapter.originalTitle.replace(/'/g, "''")}', '${escapedHtml}', ${chNum})`);
      } else {
        d1exec(`INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index)
          VALUES (${bookId}, ${chNum}, '${translatedChTitle.replace(/'/g, "''")}', '${chapter.originalTitle.replace(/'/g, "''")}', ${chNum})`);
      }
    } catch (e) {
      d1exec(`INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index)
        VALUES (${bookId}, ${chNum}, '${translatedChTitle.replace(/'/g, "''")}', '${chapter.originalTitle.replace(/'/g, "''")}', ${chNum})`);
    }

    const chRow = d1exec(`SELECT id FROM chapters_v2 WHERE book_id = ${bookId} AND chapter_number = ${chNum}`);
    const chapterId = chRow[0].results[0].id;

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
        d1exec(`INSERT OR REPLACE INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index)
          VALUES (${chapterId}, '${node.xpath}', '${node.text.replace(/'/g, "''")}', '${node.html.replace(/'/g, "''")}', '${translated.replace(/'/g, "''")}', ${node.orderIndex})`);
      }
      process.stdout.write(`   ${Math.min(bi + batchSize, chapter.textNodes.length)}/${chapter.textNodes.length} `);
    }
    console.log('✅');
  }

  // Also fix chapter titles that show as [zh: ...]
  console.log('\n🔧 Fixing chapter titles...');
  for (let ci = 0; ci < contentChapters.length; ci++) {
    const chNum = ci + 1;
    const chRow = d1exec(`SELECT id, title FROM chapters_v2 WHERE book_id = ${bookId} AND chapter_number = ${chNum}`);
    const ch = chRow[0].results[0];
    if (ch && ch.title.startsWith('[zh:')) {
      const chapter = contentChapters[ci];
      try {
        const translated = await translator.translateText(chapter.originalTitle, {
          sourceLanguage: source,
          targetLanguage: target,
        });
        d1exec(`UPDATE chapters_v2 SET title = '${translated.replace(/'/g, "''")}' WHERE id = ${ch.id}`);
        console.log(`   Ch ${chNum}: "${chapter.originalTitle}" → "${translated}"`);
      } catch {}
    }
  }

  // Fix book title
  const bookInfo = d1exec(`SELECT title FROM books_v2 WHERE uuid = '${bookUuid}'`);
  if (bookInfo[0].results[0].title.startsWith('[zh:')) {
    try {
      const translated = await translator.translateText(bookData.title, {
        sourceLanguage: source,
        targetLanguage: target,
      });
      d1exec(`UPDATE books_v2 SET title = '${translated.replace(/'/g, "''")}' WHERE uuid = '${bookUuid}'`);
      console.log(`   Book title: "${bookData.title}" → "${translated}"`);
    } catch {}
  }

  // Mark as ready
  d1exec(`UPDATE books_v2 SET status = 'ready' WHERE uuid = '${bookUuid}'`);
  console.log(`\n🎉 Done!`);
}

main().catch(e => { console.error(e); process.exit(1); });
