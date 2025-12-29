#!/usr/bin/env ts-node

/**
 * Ovid Book Listing Tool
 *
 * Lists all books in the database with their details
 *
 * Usage:
 *   ts-node scripts/list-books.ts
 *   npm run list-books
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface Book {
  id: number;
  uuid: string;
  title: string;
  author: string;
  language_pair: string;
  book_cover_img_url: string | null;
  book_spine_img_url: string | null;
  created_at: string;
}

type DatabaseMode = 'local' | 'remote';

class BookLister {
  private mode: DatabaseMode;

  constructor(mode: DatabaseMode = 'local') {
    this.mode = mode;
  }

  async list(): Promise<void> {
    const modeLabel = this.mode === 'local' ? 'Local' : 'Remote';
    console.log(`📚 Ovid Book Library (${modeLabel})`);
    console.log('='.repeat(120));
    console.log('');

    try {
      // Query all books from database
      const booksSql = `SELECT id, uuid, title, author, language_pair, book_cover_img_url, book_spine_img_url, created_at FROM books ORDER BY created_at DESC;`;

      let books: Book[];
      if (this.mode === 'local') {
        const result = execSync(`npm run db:local -- "${booksSql}"`, {
          encoding: 'utf8',
          env: this.getCleanEnv(),
        });
        books = this.parseLocalBooks(result);
      } else {
        const remoteResults = await this.queryRemote(booksSql);
        books = remoteResults;
      }

      if (books.length === 0) {
        console.log('📭 No books found in the database.');
        console.log('');
        console.log('💡 Import your first book with:');
        console.log('   yarn import-book -- --file="book.epub" --target="zh"');
        return;
      }

      // Display header
      console.log(
        `${'UUID'.padEnd(38)} | ${'Title'.padEnd(25)} | ${'Author'.padEnd(18)} | ${'Imported'.padEnd(19)} | Lang`
      );
      console.log('-'.repeat(120));

      // Display each book
      for (const book of books) {
        const title = this.truncate(book.title, 25);
        const author = this.truncate(book.author, 18);
        const langPair = book.language_pair || 'unknown';
        const importedAt = this.formatDate(book.created_at);

        console.log(
          `${book.uuid.padEnd(38)} | ${title.padEnd(25)} | ${author.padEnd(18)} | ${importedAt.padEnd(19)} | ${langPair}`
        );
      }

      console.log('');
      console.log(
        `📊 Total: ${books.length} book${books.length > 1 ? 's' : ''}`
      );
      console.log('');
      console.log('💡 Commands:');
      console.log('   View book: /book/{uuid}');
      console.log('   Remove book: yarn remove-book -- --uuid="{uuid}"');
      console.log(
        '   Sync to remote: yarn sync-remote-book -- --uuid="{uuid}"'
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Failed to list books:', errorMessage);
      process.exit(1);
    }
  }

  private async queryRemote(sql: string): Promise<Book[]> {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const accountId =
      process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
    const databaseId =
      process.env.CLOUDFLARE_D1_DATABASE_ID ||
      this.readDatabaseIdFromWrangler();

    if (!token) {
      throw new Error(
        '❌ CLOUDFLARE_API_TOKEN is not set. Set it to query remote database.'
      );
    }
    if (!accountId) {
      throw new Error(
        '❌ CLOUDFLARE_ACCOUNT_ID is not set. Set it to query remote database.'
      );
    }
    if (!databaseId) {
      throw new Error(
        '❌ CLOUDFLARE_D1_DATABASE_ID not found in environment or wrangler.toml'
      );
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`D1 API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as any;
    const results = data?.result?.[0]?.results || data?.result?.results || [];

    return results.map((row: any) => ({
      id: row.id,
      uuid: row.uuid,
      title: row.title,
      author: row.author || 'Unknown',
      language_pair: row.language_pair || 'unknown',
      book_cover_img_url: row.book_cover_img_url || null,
      book_spine_img_url: row.book_spine_img_url || null,
      created_at: row.created_at || new Date().toISOString(),
    }));
  }

  private readDatabaseIdFromWrangler(): string | null {
    const candidates = [
      path.resolve(process.cwd(), 'wrangler.toml.local'),
      path.resolve(process.cwd(), 'wrangler.toml'),
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

  private getCleanEnv(): NodeJS.ProcessEnv {
    // Remove npm_config_* environment variables to avoid warnings
    const env = { ...process.env };
    Object.keys(env).forEach((key) => {
      if (key.startsWith('npm_config_')) {
        delete env[key];
      }
    });
    return env;
  }

  private parseLocalBooks(result: string): Book[] {
    try {
      // Parse the JSON output from wrangler
      // Format: [{ "results": [...], "success": true, "meta": {...} }]

      // Find the JSON array in the output
      const jsonStart = result.indexOf('[');
      if (jsonStart === -1) return [];

      const jsonStr = result.substring(jsonStart);
      const parsed = JSON.parse(jsonStr);

      // Extract results from the first element
      if (!Array.isArray(parsed) || parsed.length === 0) return [];

      const firstResult = parsed[0];
      if (!firstResult.results || !Array.isArray(firstResult.results))
        return [];

      // Map the results to Book objects
      const books: Book[] = firstResult.results.map((row: any) => ({
        id: row.id,
        uuid: row.uuid || '',
        title: row.title || 'Untitled',
        author: row.author || 'Unknown',
        language_pair: row.language_pair || 'unknown',
        book_cover_img_url: row.book_cover_img_url || null,
        book_spine_img_url: row.book_spine_img_url || null,
        created_at: row.created_at || new Date().toISOString(),
      }));

      return books;
    } catch (e) {
      console.warn('⚠️  Warning: Failed to parse book data:', e);
      return [];
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  private formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      // Format as: YYYY-MM-DD HH:MM
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}`;
    } catch (e) {
      return dateStr.substring(0, 19); // fallback to raw string
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
📚 Ovid Book Listing Tool

Usage:
  ts-node scripts/list-books.ts [--mode=local|remote]
  npm run list-books:local   # List books from local database
  npm run list-books:remote  # List books from remote database

Description:
  Lists all books currently imported in your database.
  Shows UUID, title, author, language pair, and import time for each book.

Options:
  --mode=MODE   Database mode: 'local' or 'remote' (default: local)
  --help, -h    Show this help message

Environment variables (required for remote mode):
  CLOUDFLARE_API_TOKEN      Your Cloudflare API token
  CLOUDFLARE_ACCOUNT_ID     Your Cloudflare account ID
  CLOUDFLARE_D1_DATABASE_ID Database ID (or set in wrangler.toml)
`);
    process.exit(0);
  }

  try {
    // Parse mode from arguments
    let mode: DatabaseMode = 'local';
    const modeArg = args.find((arg) => arg.startsWith('--mode='));
    if (modeArg) {
      const modeValue = modeArg.split('=')[1];
      if (modeValue === 'remote' || modeValue === 'local') {
        mode = modeValue;
      } else {
        console.error('❌ Invalid mode. Use --mode=local or --mode=remote');
        process.exit(1);
      }
    }

    const lister = new BookLister(mode);
    await lister.list();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Error:', errorMessage);
    process.exit(1);
  }
}

// Only run if called directly
if (require.main === module) {
  main();
}

export default BookLister;
