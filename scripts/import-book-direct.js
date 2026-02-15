#!/usr/bin/env node

/**
 * Direct SQLite import using better-sqlite3
 * Bypasses wrangler/workerd to avoid runtime crashes
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.resolve(process.cwd(), '.wrangler/state/v3/d1/ovid-db.sqlite3');

// Ensure DB exists and is initialized
if (!fs.existsSync(dbPath)) {
  console.log('📦 Initializing database...');
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });
  
  const db = new Database(dbPath);
  const schema = fs.readFileSync(path.resolve(process.cwd(), 'database/schema.sql'), 'utf-8');
  schema.split(';').forEach(stmt => {
    if (stmt.trim()) db.exec(stmt);
  });
  db.close();
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL'); // Better concurrent access

console.log('✅ Connected to local database');

/**
 * Import book with translations from import-book data
 */
function importBook(bookData) {
  const bookUuid = uuidv4();
  const languagePair = `${bookData.sourceLang || 'en'}-${bookData.targetLang || 'zh'}`;

  // Ensure v2 schema
  const v2Schema = fs.readFileSync(path.resolve(process.cwd(), 'database/schema_v2.sql'), 'utf-8');
  v2Schema.split(';').forEach(stmt => {
    if (stmt.trim()) {
      try {
        db.exec(stmt);
      } catch (e) {
        // Table already exists, ignore
        if (!e.message.includes('already exists')) {
          console.warn('⚠️  Warning:', e.message);
        }
      }
    }
  });

  console.log('\n📚 Importing book:');
  console.log('  UUID:', bookUuid);
  console.log('  Title:', bookData.title);
  console.log('  Author:', bookData.author);
  console.log('  Language pair:', languagePair);

  // Insert book metadata
  const insertBook = db.prepare(`
    INSERT INTO books_v2 
      (uuid, title, original_title, author, language_pair, styles, book_cover_img_url, book_spine_img_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertBook.run(
    bookUuid,
    bookData.translatedTitle || bookData.title,
    bookData.title,
    bookData.author,
    languagePair,
    bookData.styles || '{}',
    bookData.coverUrl || null,
    bookData.spineUrl || null
  );

  console.log('✅ Book inserted');

  // Get book_id
  const getBookId = db.prepare('SELECT id FROM books_v2 WHERE uuid = ?');
  const book = getBookId.get(bookUuid);
  const bookId = book.id;

  // Insert chapters
  const insertChapter = db.prepare(`
    INSERT INTO chapters_v2 
      (book_id, chapter_number, title, original_title, order_index)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertTranslation = db.prepare(`
    INSERT INTO translations_v2
      (chapter_id, xpath, original_text, original_html, translated_text, order_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let totalTranslations = 0;

  for (const chapter of bookData.chapters) {
    const chapResult = insertChapter.run(
      bookId,
      chapter.number,
      chapter.title,
      chapter.originalTitle,
      chapter.number
    );
    const chapterId = chapResult.lastInsertRowid;

    console.log(`  📖 Chapter ${chapter.number}: ${chapter.title}`);

    // Insert translations for this chapter
    if (chapter.translations && Array.isArray(chapter.translations)) {
      chapter.translations.forEach((trans, idx) => {
        insertTranslation.run(
          chapterId,
          trans.xpath || `//p[${idx}]`,
          trans.original_text,
          trans.original_html || null,
          trans.translated_text,
          idx
        );
        totalTranslations++;
      });
    }
  }

  console.log(`✅ Imported ${totalTranslations} translations across ${bookData.chapters.length} chapters`);
  return bookUuid;
}

// Export for use by other modules
module.exports = { importBook, db, dbPath };

// If run directly, show usage
if (require.main === module) {
  console.log('✅ Database connection ready');
  console.log('📝 Usage: node import-book-direct.js (from within ovid project)');
  console.log('\n📦 This script is meant to be required by import-book.ts or used programmatically');
  
  // Example: list current books
  const books = db.prepare('SELECT * FROM books_v2 LIMIT 5').all();
  if (books.length > 0) {
    console.log('\n📚 Current books in v2 schema:');
    books.forEach(b => console.log(`  - ${b.title} (${b.uuid})`));
  } else {
    console.log('\n📚 No books in v2 schema yet');
  }
}
