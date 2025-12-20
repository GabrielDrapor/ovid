#!/usr/bin/env node

/**
 * Sync a locally imported book to the remote D1 database.
 * - Verifies/updates remote schema before inserting
 * - Replaces existing remote copy (by UUID)
 *
 * Usage:
 *   node scripts/sync-remote-book.js --uuid="<book-uuid>"
 */

require('dotenv').config();
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Ensure Wrangler writes config/logs inside the workspace to avoid permission issues
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || require('path').resolve(process.cwd(), '.wrangler_cfg');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  for (const a of args) {
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      options[k.replace(/^--/, '')] = v || true;
    }
  }
  return options;
}

function escapeSql(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function parseWranglerJson(output) {
  // Extract the first JSON array in wrangler's mixed output
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

function execWithTTY(cmd, { inherit = false } = {}) {
  try {
    // First try normal execution (may work if token is present)
    return execSync(cmd, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  } catch (err) {
    const msg = String(err?.stdout || err?.stderr || err?.message || '');
    const needsInteractive = msg.includes('non-interactive environment') || msg.includes('CLOUDFLARE_API_TOKEN');
    // Try to allocate a pseudo-TTY via `script` (Linux/WSL)
    if (needsInteractive) {
      try {
        // Linux style
        const wrapped = `script -q -c ${JSON.stringify(cmd)} /dev/null`;
        return execSync(wrapped, { encoding: 'utf8', stdio: 'pipe' });
      } catch (err2) {
        try {
          // macOS style
          const wrappedMac = `script -q /dev/null ${cmd}`;
          return execSync(wrappedMac, { encoding: 'utf8', stdio: 'pipe' });
        } catch (err3) {
          throw err; // rethrow original for clarity
        }
      }
    }
    throw err;
  }
}

function runLocal(sql, opts = { silent: false, maxBufferMB: 64, config: 'wrangler.toml' }) {
  // Force persistence to the default local D1 directory so we read existing data
  const cfg = (opts && opts.config) || 'wrangler.toml';
  const cmd = `npx wrangler d1 execute polyink-db --local --config ${cfg} --command "${sql}"`;
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: opts && opts.silent ? 'pipe' : 'pipe',
      maxBuffer: ((opts && opts.maxBufferMB) || 64) * 1024 * 1024
    });
    const parsed = parseWranglerJson(out) || { results: [] };
    return parsed.results || [];
  } catch (e) {
    return [];
  }
}

// -------- Remote via Cloudflare D1 HTTP API (no wrangler) --------
function readDatabaseIdFromWrangler() {
  const candidates = [
    path.resolve(process.cwd(), 'wrangler.toml.local'),
    path.resolve(process.cwd(), 'wrangler.toml')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8');
      const m = txt.match(/database_id\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

async function remoteQueryHTTP(sqlArray) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID || readDatabaseIdFromWrangler();

  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');
  if (!databaseId) throw new Error('CLOUDFLARE_D1_DATABASE_ID (or database_id in wrangler.toml(.local)) not found');

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  // API expects a single SQL string; join multiple statements with semicolons
  let sqlText = '';
  if (Array.isArray(sqlArray)) {
    sqlText = sqlArray
      .map((s) => String(s).trim().replace(/;+\s*$/, ''))
      .filter((s) => s.length > 0)
      .join('; ');
    if (!sqlText.endsWith(';')) sqlText += ';';
  } else {
    sqlText = String(sqlArray || '').trim();
    if (!sqlText.endsWith(';')) sqlText += ';';
  }
  const payload = { sql: sqlText };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`D1 API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (Array.isArray(data?.result)) {
    const first = data.result[0];
    return first && first.results ? first.results : [];
  }
  if (data?.result && data.result.results) {
    return data.result.results;
  }
  return [];
}

function splitSqlStatements(sqlText) {
  const lines = sqlText.split(/\r?\n/)
    .map((l) => l.replace(/^\s*--.*$/, ''))
    .join('\n');
  return lines.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runRemote(sql, _opts = { silent: false }) {
  return await remoteQueryHTTP([sql]);
}

function ensureWranglerAuthInteractive() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    // Token present; wrangler should work non-interactively
    return;
  }

  try {
    execSync('npx wrangler whoami', { encoding: 'utf8', stdio: 'pipe' });
    return; // Auth already set locally
  } catch (e) {
    console.log('🔐 Wrangler is not authenticated. Opening interactive login...');
    const res = spawnSync('npx', ['wrangler', 'auth', 'login'], { stdio: 'inherit' });
    if (res.status !== 0) {
      throw new Error('Wrangler login failed. You can also set CLOUDFLARE_API_TOKEN in your environment.');
    }
    // Re-check
    try {
      execSync('npx wrangler whoami', { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      throw new Error('Wrangler still not authenticated after login. Ensure login succeeded or set CLOUDFLARE_API_TOKEN.');
    }
  }
}

async function applyRemoteSchemaIfNeeded() {
  // Check required tables and columns exist, else apply schema.sql
  const required = {
    books: ['id', 'title', 'original_title', 'author', 'language_pair', 'styles', 'uuid'],
    chapters: ['id', 'book_id', 'chapter_number', 'title', 'original_title', 'order_index'],
    content_items: ['id', 'book_id', 'chapter_id', 'item_id', 'original_text', 'translated_text', 'type', 'tag_name', 'order_index']
  };

  const missing = [];
  for (const table of Object.keys(required)) {
    const t = await runRemote(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}';`, { silent: true });
    if (!t || t.length === 0) {
      missing.push(table);
      continue;
    }
    const colsRows = await runRemote(`PRAGMA table_info(${table});`, { silent: true });
    const cols = colsRows.map((r) => r.name);
    for (const col of required[table]) {
      if (!cols.includes(col)) {
        missing.push(`${table}.${col}`);
      }
    }
  }

  if (missing.length > 0) {
    console.log(`🔧 Remote schema missing/old (${missing.join(', ')}). Applying database/schema.sql...`);
    const schemaPath = path.resolve(process.cwd(), 'database', 'schema.sql');
    const sqlText = fs.readFileSync(schemaPath, 'utf8');
    const stmts = splitSqlStatements(sqlText);
    const chunkSize = 50;
    for (let i = 0; i < stmts.length; i += chunkSize) {
      const chunk = stmts.slice(i, i + chunkSize);
      await remoteQueryHTTP(chunk);
    }
  } else {
    console.log('✅ Remote schema up to date');
  }
}

function loadLocalBook(uuid) {
  // Try current config first, then legacy config (older local DB)
  let configInUse = 'wrangler.toml';
  let bookRows = runLocal(`SELECT * FROM books WHERE uuid='${escapeSql(uuid)}';`, { silent: true, config: configInUse });
  if (!bookRows || bookRows.length === 0) {
    configInUse = 'wrangler.legacy.toml';
    bookRows = runLocal(`SELECT * FROM books WHERE uuid='${escapeSql(uuid)}';`, { silent: true, config: configInUse });
  }
  if (!bookRows || bookRows.length === 0) {
    throw new Error(`Local book with uuid=${uuid} not found`);
  }
  const book = bookRows[0];
  const chapters = runLocal(`SELECT id, chapter_number, title, original_title, order_index FROM chapters WHERE book_id=${book.id} ORDER BY order_index ASC;`, { silent: true, config: configInUse });
  // Page through content items to avoid large buffer overflows
  const pageSize = 500;
  const contents = [];
  let offset = 0;
  const cols = 'item_id, original_text, translated_text, type, class_name, tag_name, styles, order_index, chapter_id';
  while (true) {
    const page = runLocal(`SELECT ${cols} FROM content_items WHERE book_id=${book.id} ORDER BY order_index ASC LIMIT ${pageSize} OFFSET ${offset};`, { silent: true, maxBufferMB: 32, config: configInUse });
    if (!page || page.length === 0) break;
    contents.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return { book, chapters, contents };
}

async function removeRemoteBookIfExists(uuid) {
  const rows = await runRemote(`SELECT id FROM books WHERE uuid='${escapeSql(uuid)}';`, { silent: true });
  if (!rows || rows.length === 0) return false;
  const id = rows[0].id;
  console.log(`🗑️  Removing existing remote book (id=${id})...`);
  // Remove in safe order
  await runRemote(`DELETE FROM content_items WHERE book_id=${id};`);
  await runRemote(`DELETE FROM chapters WHERE book_id=${id};`);
  await runRemote(`DELETE FROM books WHERE id=${id};`);
  return true;
}

async function insertRemote({ book, chapters, contents }) {
  console.log('🚀 Inserting book into remote...');
  const insertBookSQL = `INSERT INTO books (title, original_title, author, language_pair, styles, uuid) VALUES ('${escapeSql(book.title)}', '${escapeSql(book.original_title)}', '${escapeSql(book.author)}', '${escapeSql(book.language_pair)}', ${book.styles ? `'${escapeSql(book.styles)}'` : 'NULL'}, '${escapeSql(book.uuid)}');`;
  await runRemote(insertBookSQL);

  const bookIdRows = await runRemote(`SELECT id FROM books WHERE uuid='${escapeSql(book.uuid)}';`, { silent: true });
  if (!bookIdRows || bookIdRows.length === 0) {
    throw new Error('Failed to retrieve remote book id after insert');
  }
  const remoteBookId = bookIdRows[0].id;

  // Map local chapter_id -> remote chapter_id
  const chapterIdMap = new Map();

  console.log(`📄 Inserting ${chapters.length} chapters...`);
  if (chapters.length > 0) {
    const stmts = [];
    for (const ch of chapters) {
      const chSQL = `INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) VALUES (${remoteBookId}, ${ch.chapter_number}, '${escapeSql(ch.title)}', '${escapeSql(ch.original_title)}', ${ch.order_index})`;
      stmts.push(chSQL);
    }
    await remoteQueryHTTP(stmts);
    // Fetch IDs mapping after bulk insert
    const idRowsAll = await runRemote(`SELECT id, chapter_number FROM chapters WHERE book_id=${remoteBookId};`, { silent: true });
    const byNumber = new Map(idRowsAll.map((r) => [r.chapter_number, r.id]));
    for (const ch of chapters) {
      const cid = byNumber.get(ch.chapter_number);
      if (!cid) throw new Error(`Failed to fetch remote chapter id for chapter_number=${ch.chapter_number}`);
      chapterIdMap.set(ch.id, cid);
    }
  }

  console.log(`🧩 Inserting ${contents.length} content items...`);
  let inserted = 0;
  const batchSize = 200; // number of INSERT statements per HTTP call
  for (let i = 0; i < contents.length; i += batchSize) {
    const batch = contents.slice(i, i + batchSize);
    const stmts = [];
    for (const it of batch) {
      const remoteChapterId = it.chapter_id ? (chapterIdMap.get(it.chapter_id) || 'NULL') : 'NULL';
      const type = it.type ? `'${escapeSql(it.type)}'` : `'paragraph'`;
      const tagName = it.tag_name ? `'${escapeSql(it.tag_name)}'` : (it.type === 'chapter' ? `'h3'` : `'p'`);
      const className = it.class_name ? `'${escapeSql(it.class_name)}'` : 'NULL';
      const styles = it.styles ? `'${escapeSql(it.styles)}'` : 'NULL';
      const contentSQL = `INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, class_name, tag_name, styles, order_index) VALUES (${remoteBookId}, ${remoteChapterId}, '${escapeSql(it.item_id)}', '${escapeSql(it.original_text)}', '${escapeSql(it.translated_text)}', ${type}, ${className}, ${tagName}, ${styles}, ${it.order_index})`;
      stmts.push(contentSQL);
    }
    try {
      await remoteQueryHTTP(stmts);
      inserted += batch.length;
      process.stdout.write('.');
    } catch (e) {
      console.log(`\n⚠️  Failed to insert a batch starting at index ${i}: ${e.message}`);
      // Fallback to single inserts for this batch to isolate the problematic row
      for (const it of batch) {
        try {
          const remoteChapterId = it.chapter_id ? (chapterIdMap.get(it.chapter_id) || 'NULL') : 'NULL';
          const type = it.type ? `'${escapeSql(it.type)}'` : `'paragraph'`;
          const tagName = it.tag_name ? `'${escapeSql(it.tag_name)}'` : (it.type === 'chapter' ? `'h3'` : `'p'`);
          const className = it.class_name ? `'${escapeSql(it.class_name)}'` : 'NULL';
          const styles = it.styles ? `'${escapeSql(it.styles)}'` : 'NULL';
          const contentSQL = `INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, class_name, tag_name, styles, order_index) VALUES (${remoteBookId}, ${remoteChapterId}, '${escapeSql(it.item_id)}', '${escapeSql(it.original_text)}', '${escapeSql(it.translated_text)}', ${type}, ${className}, ${tagName}, ${styles}, ${it.order_index});`;
          await runRemote(contentSQL);
          inserted++;
        } catch (inner) {
          console.log(`\n   ↳ Item ${it.item_id} failed: ${inner.message}`);
        }
      }
    }
  }
  if (contents.length > 0) process.stdout.write('\n');
  console.log(`✅ Inserted ${inserted}/${contents.length} content items.`);

  return remoteBookId;
}

async function main() {
  const opts = parseArgs();
  if (!opts.uuid) {
    console.log('\nUsage: node scripts/sync-remote-book.js --uuid="<book-uuid>"\n');
    process.exit(1);
  }

  console.log('📡 Sync Local → Remote');
  console.log('='.repeat(40));
  console.log(`UUID: ${opts.uuid}`);

  // 0) Ensure required env for HTTP D1 API
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.log('⚠️  CLOUDFLARE_API_TOKEN is not set. Set it to allow remote D1 access.');
  }
  if (!(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID)) {
    console.log('⚠️  CLOUDFLARE_ACCOUNT_ID is not set. Set it or run `npx wrangler whoami` to find it.');
  }

  // 1) Schema check/update on remote
  await applyRemoteSchemaIfNeeded();

  // 2) Load local book data
  const data = loadLocalBook(opts.uuid);
  console.log(`📘 Local book: ${data.book.title} (id=${data.book.id})`);
  console.log(`   Chapters: ${data.chapters.length}, Content items: ${data.contents.length}`);

  // 3) Remove existing remote copy (if any)
  const removed = await removeRemoteBookIfExists(opts.uuid);
  if (removed) console.log('   Existing remote book removed.');

  // Option: write a SQL file for remote ingestion to avoid SQLITE_BUSY
  if (opts['sql-out'] || opts['sqlOut']) {
    const outPath = path.resolve(process.cwd(), opts['sql-out'] || opts['sqlOut']);
    console.log(`📝 Writing SQL export to ${outPath} ...`);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const lines = [];
    lines.push('-- Ovid export SQL for single book sync');
    const bookUuid = data.book.uuid;
    const bookIdExpr = `(SELECT id FROM books WHERE uuid='${bookUuid}')`;
    // Clean existing
    lines.push(`DELETE FROM content_items WHERE book_id=${bookIdExpr};`);
    lines.push(`DELETE FROM chapters WHERE book_id=${bookIdExpr};`);
    lines.push(`DELETE FROM books WHERE uuid='${bookUuid}';`);
    // Insert book
    lines.push(`INSERT INTO books (title, original_title, author, language_pair, styles, uuid) VALUES ('${escapeSql(data.book.title)}', '${escapeSql(data.book.original_title)}', '${escapeSql(data.book.author)}', '${escapeSql(data.book.language_pair)}', ${data.book.styles ? `'${escapeSql(data.book.styles)}'` : 'NULL'}, '${escapeSql(bookUuid)}');`);
    // Chapters
    for (const ch of data.chapters) {
      lines.push(`INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) VALUES (${bookIdExpr}, ${ch.chapter_number}, '${escapeSql(ch.title)}', '${escapeSql(ch.original_title)}', ${ch.order_index});`);
    }
    // Content
    for (const it of data.contents) {
      const type = it.type ? `'${escapeSql(it.type)}'` : `'paragraph'`;
      const tagName = it.tag_name ? `'${escapeSql(it.tag_name)}'` : (it.type === 'chapter' ? `'h3'` : `'p'`);
      const className = it.class_name ? `'${escapeSql(it.class_name)}'` : 'NULL';
      const styles = it.styles ? `'${escapeSql(it.styles)}'` : 'NULL';
      const chapIdExpr = it.chapter_id ? `(SELECT id FROM chapters WHERE book_id=${bookIdExpr} AND chapter_number=(SELECT chapter_number FROM chapters WHERE id=${it.chapter_id}))` : 'NULL';
      lines.push(`INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, class_name, tag_name, styles, order_index) VALUES (${bookIdExpr}, ${chapIdExpr}, '${escapeSql(it.item_id)}', '${escapeSql(it.original_text)}', '${escapeSql(it.translated_text)}', ${type}, ${className}, ${tagName}, ${styles}, ${it.order_index});`);
    }
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log('✅ SQL file written.');
    if (opts.apply === 'remote') {
      console.log('☁️  Applying SQL to remote...');
      execSync(`npx wrangler d1 execute polyink-db --remote --file=${outPath}`, { stdio: 'inherit' });
      console.log('🎉 Sync complete via SQL file');
      return;
    } else if (opts.apply === 'local') {
      console.log('📥 Applying SQL to local...');
      execSync(`npx wrangler d1 execute polyink-db --local --file=${outPath}`, { stdio: 'inherit' });
      console.log('🎉 Local apply complete');
      return;
    } else {
      console.log('ℹ️  Not applied automatically (use --apply=remote|local to apply).');
      return;
    }
  }

  // 4) Insert into remote directly
  const remoteBookId = await insertRemote(data);
  console.log(`🎯 Remote book id: ${remoteBookId}`);
  console.log('🎉 Sync complete');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  });
}
