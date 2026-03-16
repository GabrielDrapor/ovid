#!/usr/bin/env node
// Push a book from local better-sqlite3 DB to remote D1 via HTTP API
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const uuid = process.argv[2];
if (!uuid) { console.error('Usage: node push-to-remote.js <uuid>'); process.exit(1); }

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '62a8e032d033b6946aafa0fa7d38b1b3';
const databaseId = 'df1769fb-c23b-4151-85cc-0e00ed591f2b';

const db = new Database(path.resolve(__dirname, '..', '.wrangler/state/v3/d1/ovid-db.sqlite3'));

function esc(s) { return s ? s.replace(/'/g, "''") : ''; }

async function query(sqls) {
  const arr = Array.isArray(sqls) ? sqls : [sqls];
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: arr.join('\n') })
  });
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return json;
}

async function main() {
  const book = db.prepare('SELECT * FROM books WHERE uuid=?').get(uuid);
  if (!book) { console.error('Book not found locally'); process.exit(1); }
  
  console.log(`📚 Pushing "${book.title}" (${uuid}) to remote D1...`);
  
  // Delete existing book on remote
  await query(`DELETE FROM content_items WHERE book_id IN (SELECT id FROM books WHERE uuid='${esc(uuid)}');`);
  await query(`DELETE FROM chapters WHERE book_id IN (SELECT id FROM books WHERE uuid='${esc(uuid)}');`);
  await query(`DELETE FROM books WHERE uuid='${esc(uuid)}';`);
  console.log('🗑️  Cleaned remote');
  
  // Insert book
  const coverUrl = book.book_cover_img_url ? `'${esc(book.book_cover_img_url)}'` : 'NULL';
  const spineUrl = book.book_spine_img_url ? `'${esc(book.book_spine_img_url)}'` : 'NULL';
  const styles = book.styles ? `'${esc(book.styles)}'` : 'NULL';
  await query(`INSERT INTO books (title, original_title, author, language_pair, styles, uuid, book_cover_img_url, book_spine_img_url) VALUES ('${esc(book.title)}', '${esc(book.original_title)}', '${esc(book.author)}', '${esc(book.language_pair)}', ${styles}, '${esc(uuid)}', ${coverUrl}, ${spineUrl});`);
  console.log('📖 Book inserted');
  
  // Insert chapters
  const chapters = db.prepare('SELECT * FROM chapters WHERE book_id=? ORDER BY order_index').all(book.id);
  for (const ch of chapters) {
    await query(`INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) VALUES ((SELECT id FROM books WHERE uuid='${esc(uuid)}'), ${ch.chapter_number}, '${esc(ch.title)}', '${esc(ch.original_title)}', ${ch.order_index});`);
  }
  console.log(`📑 ${chapters.length} chapters inserted`);
  
  // Insert content_items in batches
  const items = db.prepare('SELECT * FROM content_items WHERE book_id=? ORDER BY chapter_id, order_index').all(book.id);
  const batchSize = 10;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const stmts = batch.map(it => {
      const chapterExpr = `(SELECT c.id FROM chapters c JOIN books b ON c.book_id=b.id WHERE b.uuid='${esc(uuid)}' AND c.chapter_number=${db.prepare('SELECT chapter_number FROM chapters WHERE id=?').get(it.chapter_id).chapter_number})`;
      return `INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, class_name, tag_name, styles, order_index) VALUES ((SELECT id FROM books WHERE uuid='${esc(uuid)}'), ${chapterExpr}, '${esc(it.item_id)}', '${esc(it.original_text)}', '${esc(it.translated_text)}', '${esc(it.type || 'paragraph')}', ${it.class_name ? `'${esc(it.class_name)}'` : 'NULL'}, ${it.tag_name ? `'${esc(it.tag_name)}'` : 'NULL'}, ${it.styles ? `'${esc(it.styles)}'` : 'NULL'}, ${it.order_index});`;
    });
    await query(stmts.join('\n'));
    process.stdout.write(`\r📝 ${Math.min(i + batchSize, items.length)}/${items.length} items`);
  }
  console.log('\n✅ Done!');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
