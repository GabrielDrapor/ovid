#!/usr/bin/env ts-node

/**
 * Import a book into remote D1 and trigger Railway translation.
 * Skips local translation — Railway handles it.
 *
 * Usage:
 *   yarn ts-node --project scripts/tsconfig.json scripts/import-for-railway.ts \
 *     --file="book.epub" --target="zh" --railway-url="https://..." --railway-secret="..."
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

// D1 REST API client (same pattern as Railway translator)
class D1Client {
  private accountId: string;
  private apiToken: string;
  private databaseId: string;

  constructor(opts: { accountId: string; apiToken: string; databaseId: string }) {
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
    this.databaseId = opts.databaseId;
  }

  async execute(sql: string, params: any[] = []): Promise<any> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
    const data = await res.json() as any;
    if (!data.success) {
      throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
    }
    return data.result?.[0];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=').slice(1).join('=') : undefined;
  };

  const filePath = getArg('file');
  const targetLang = getArg('target') || 'zh';
  const sourceLang = getArg('source') || 'en';
  const railwayUrl = getArg('railway-url') || process.env.TRANSLATOR_SERVICE_URL || 'https://ovid-production.up.railway.app';
  const railwaySecret = getArg('railway-secret') || process.env.TRANSLATOR_SECRET;

  if (!filePath) {
    console.error('Usage: --file="book.epub" [--target=zh] [--railway-url=...] [--railway-secret=...]');
    process.exit(1);
  }

  if (!railwaySecret) {
    console.error('❌ TRANSLATOR_SECRET required (env or --railway-secret)');
    process.exit(1);
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN!;
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID!;

  if (!accountId || !apiToken || !databaseId) {
    console.error('❌ Missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, or CLOUDFLARE_D1_DATABASE_ID');
    process.exit(1);
  }

  const db = new D1Client({ accountId, apiToken, databaseId });

  // Parse EPUB
  console.log('📖 Parsing EPUB...');
  const { BookProcessor } = require('../src/utils/book-processor');
  const processor = new BookProcessor(1, {
    apiKey: 'unused',
    baseURL: 'unused',
    model: 'unused',
  });

  const buffer = fs.readFileSync(filePath);
  const bookData = await processor.parseEPUBV2(buffer.buffer);

  console.log(`   Title: ${bookData.title}`);
  console.log(`   Author: ${bookData.author}`);
  console.log(`   Chapters: ${bookData.chapters.length}`);

  let totalNodes = 0;
  for (const ch of bookData.chapters) {
    totalNodes += ch.textNodes.length;
  }
  console.log(`   Text nodes: ${totalNodes}`);

  // Insert book
  const bookUuid = uuidv4();
  const languagePair = `${sourceLang}-${targetLang}`;

  console.log('\n💾 Inserting book into remote D1...');
  await db.execute(
    `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, status)
     VALUES (?, ?, ?, ?, ?, ?, 'processing')`,
    [bookUuid, bookData.title, bookData.title, bookData.author, languagePair, bookData.styles || '']
  );

  const bookRow = await db.execute('SELECT id FROM books_v2 WHERE uuid = ?', [bookUuid]);
  const bookId = bookRow.results[0].id;
  console.log(`   ✅ Book created: uuid=${bookUuid}, id=${bookId}`);

  // Insert chapters + text nodes
  for (const chapter of bookData.chapters) {
    console.log(`   📥 Chapter ${chapter.number}: "${chapter.originalTitle}" (${chapter.textNodes.length} nodes)`);

    const rawHtmlSize = Buffer.byteLength(chapter.rawHtml || '', 'utf8');
    const shouldStoreRawHtml = rawHtmlSize < 50000;

    if (shouldStoreRawHtml && chapter.rawHtml) {
      await db.execute(
        `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, raw_html, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [bookId, chapter.number, chapter.originalTitle, chapter.originalTitle, chapter.rawHtml, chapter.number]
      );
    } else {
      await db.execute(
        `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index)
         VALUES (?, ?, ?, ?, ?)`,
        [bookId, chapter.number, chapter.originalTitle, chapter.originalTitle, chapter.number]
      );
    }

    // Store text nodes JSON for Railway to pick up
    await db.execute(
      'UPDATE chapters_v2 SET text_nodes_json = ? WHERE book_id = ? AND chapter_number = ?',
      [JSON.stringify(chapter.textNodes), bookId, chapter.number]
    );
  }

  // Create translation job
  console.log('\n📋 Creating translation job...');
  await db.execute(
    `INSERT INTO translation_jobs (book_id, book_uuid, source_language, target_language, total_chapters, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [bookId, bookUuid, sourceLang, targetLang, bookData.chapters.length]
  );
  console.log('   ✅ Translation job created');

  // Trigger Railway
  console.log(`\n🚀 Triggering Railway translation at ${railwayUrl}...`);
  const res = await fetch(`${railwayUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookUuid, secret: railwaySecret }),
  });
  const result = await res.json();
  console.log(`   Response (${res.status}):`, JSON.stringify(result));

  console.log(`\n🎉 Done! Book UUID: ${bookUuid}`);
  console.log(`📱 Access: https://ovid.drapor.workers.dev/book/${bookUuid}`);
  console.log('⏳ Railway is translating in the background. Check /status endpoint for progress.');
}

main().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
