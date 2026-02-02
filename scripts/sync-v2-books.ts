#!/usr/bin/env ts-node

/**
 * Sync all V2 books from local to remote database
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function escapeSql(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text).replace(/'/g, "''");
}

function parseWranglerJson(output: string): any {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const json = JSON.parse(output.slice(start, end + 1));
    return json && json[0] ? json[0] : null;
  } catch (e) {
    return null;
  }
}

function runLocal(sql: string): any[] {
  const cmd = `npx wrangler d1 execute ovid-db --local --command "${sql.replace(/"/g, '\\"')}"`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    const parsed = parseWranglerJson(out) || { results: [] };
    return parsed.results || [];
  } catch (e) {
    return [];
  }
}

async function main() {
  console.log('📡 Sync V2 Books: Local → Remote');
  console.log('='.repeat(50));

  // Get all local V2 books
  const books = runLocal('SELECT * FROM books_v2 ORDER BY created_at ASC;');
  console.log(`📚 Found ${books.length} books to sync\n`);

  if (books.length === 0) {
    console.log('No books to sync.');
    return;
  }

  // Create temp directory for SQL files
  const tempDir = path.resolve(process.cwd(), '.temp_sync');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  for (const book of books) {
    console.log(`\n📖 Syncing: ${book.title} (${book.uuid})`);

    // Get chapters for this book
    const chapters = runLocal(`SELECT * FROM chapters_v2 WHERE book_id = ${book.id} ORDER BY order_index ASC;`);
    console.log(`   📄 ${chapters.length} chapters`);

    // Build SQL statements
    const sqlLines: string[] = [];

    // Delete existing book if present
    sqlLines.push(`DELETE FROM translations_v2 WHERE chapter_id IN (SELECT id FROM chapters_v2 WHERE book_id = (SELECT id FROM books_v2 WHERE uuid = '${escapeSql(book.uuid)}'));`);
    sqlLines.push(`DELETE FROM chapters_v2 WHERE book_id = (SELECT id FROM books_v2 WHERE uuid = '${escapeSql(book.uuid)}');`);
    sqlLines.push(`DELETE FROM books_v2 WHERE uuid = '${escapeSql(book.uuid)}';`);

    // Insert book
    sqlLines.push(`INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, book_cover_img_url, book_spine_img_url) VALUES ('${escapeSql(book.uuid)}', '${escapeSql(book.title)}', '${escapeSql(book.original_title)}', '${escapeSql(book.author)}', '${escapeSql(book.language_pair)}', ${book.styles ? `'${escapeSql(book.styles)}'` : 'NULL'}, ${book.book_cover_img_url ? `'${escapeSql(book.book_cover_img_url)}'` : 'NULL'}, ${book.book_spine_img_url ? `'${escapeSql(book.book_spine_img_url)}'` : 'NULL'});`);

    // Insert chapters and translations
    for (const chapter of chapters) {
      // Insert chapter (skip raw_html to avoid size issues)
      sqlLines.push(`INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index) VALUES ((SELECT id FROM books_v2 WHERE uuid = '${escapeSql(book.uuid)}'), ${chapter.chapter_number}, '${escapeSql(chapter.title)}', '${escapeSql(chapter.original_title)}', ${chapter.order_index});`);

      // Get translations for this chapter
      const translations = runLocal(`SELECT * FROM translations_v2 WHERE chapter_id = ${chapter.id} ORDER BY order_index ASC;`);

      for (const t of translations) {
        sqlLines.push(`INSERT INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index) VALUES ((SELECT id FROM chapters_v2 WHERE book_id = (SELECT id FROM books_v2 WHERE uuid = '${escapeSql(book.uuid)}') AND chapter_number = ${chapter.chapter_number}), '${escapeSql(t.xpath)}', '${escapeSql(t.original_text)}', '${escapeSql(t.original_html)}', '${escapeSql(t.translated_text)}', ${t.order_index});`);
      }
    }

    // Write SQL file
    const sqlPath = path.join(tempDir, `book_${book.uuid}.sql`);
    fs.writeFileSync(sqlPath, sqlLines.join('\n'), 'utf8');
    console.log(`   💾 SQL file: ${sqlLines.length} statements`);

    // Apply to remote
    console.log(`   ☁️  Uploading to remote...`);
    try {
      execSync(`npx wrangler d1 execute ovid-db --remote --file="${sqlPath}"`, {
        stdio: 'inherit',
      });
      console.log(`   ✅ Done!`);
    } catch (e: any) {
      console.log(`   ❌ Failed: ${e.message}`);
    }

    // Clean up
    fs.unlinkSync(sqlPath);
  }

  // Clean up temp directory
  try {
    fs.rmdirSync(tempDir);
  } catch (e) {}

  console.log('\n🎉 All books synced!');
}

main().catch((err) => {
  console.error('❌ Sync failed:', err.message);
  process.exit(1);
});
