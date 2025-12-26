#!/usr/bin/env ts-node

/**
 * Ovid Book Removal Tool
 *
 * Safely removes books from the database with confirmation
 *
 * Usage:
 *   ts-node scripts/remove-book.ts --uuid="book-uuid-here"
 *   npm run remove-book -- --uuid="book-uuid-here"
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

interface BookInfo {
  id: number;
  title: string;
  author: string;
  languagePair: string;
  chapterCount: number;
  contentCount: number;
}

interface RemoveOptions {
  uuid?: string;
  mode?: string;
  help?: boolean;
}

type DatabaseMode = 'local' | 'remote';

class BookRemover {
  private uuid: string;
  private mode: DatabaseMode;

  constructor(uuid: string, mode: DatabaseMode = 'local') {
    this.uuid = uuid;
    this.mode = mode;
    this.validateInputs();
  }

  private validateInputs(): void {
    if (!this.uuid) {
      throw new Error('Book UUID is required. Use --uuid="your-book-uuid"');
    }
  }

  async remove(): Promise<void> {
    const modeLabel = this.mode === 'local' ? 'Local' : 'Remote';
    console.log(`📚 Ovid Book Removal Tool (${modeLabel})`);
    console.log('='.repeat(40));
    console.log(`🔍 UUID: ${this.uuid}`);
    console.log('');

    try {
      // Step 1: Check if book exists and get details
      console.log('🔍 Step 1: Checking if book exists...');
      const bookInfo = await this.getBookInfo();

      if (!bookInfo) {
        console.log('❌ Book not found with the specified UUID');
        process.exit(1);
      }

      console.log(
        `   ✅ Found book: "${bookInfo.title}" by ${bookInfo.author}`
      );
      console.log(
        `   📊 Chapters: ${bookInfo.chapterCount}, Content items: ${bookInfo.contentCount}`
      );
      console.log('');

      // Step 2: Ask for confirmation
      const confirmed = await this.askForConfirmation(bookInfo);

      if (!confirmed) {
        console.log('❌ Book removal cancelled');
        process.exit(0);
      }

      // Step 3: Remove the book
      console.log('🗑️  Step 2: Removing book from database...');
      await this.removeFromDatabase(bookInfo.id);

      console.log('');
      console.log('🎉 Book removed successfully!');
      console.log(`📱 Book "${bookInfo.title}" is no longer accessible`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Removal failed:', errorMessage);
      process.exit(1);
    }
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

  private async queryRemote(sql: string): Promise<any[]> {
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
    return data?.result?.[0]?.results || data?.result?.results || [];
  }

  private async getBookInfo(): Promise<BookInfo | null> {
    try {
      if (this.mode === 'local') {
        return await this.getLocalBookInfo();
      } else {
        return await this.getRemoteBookInfo();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fetch book info: ${errorMessage}`);
    }
  }

  private async getLocalBookInfo(): Promise<BookInfo | null> {
    try {
      // Get book details
      const bookSql = `SELECT id, title, author, language_pair FROM books WHERE uuid = '${this.uuid}';`;
      const bookResult = execSync(`npm run db:local -- "${bookSql}"`, {
        encoding: 'utf8',
        env: this.getCleanEnv(),
      });

      // Parse JSON response more robustly
      let bookId: number;
      let title: string;
      let author: string;
      let languagePair: string;

      try {
        const resultsMatch = bookResult.match(
          /\[\s*{\s*"results":\s*\[(.*?)\]/s
        );
        if (!resultsMatch) return null;

        const resultsContent = resultsMatch[1];
        const idMatch = resultsContent.match(/"id":\s*(\d+)/);
        const titleMatch = resultsContent.match(/"title":\s*"([^"]*)"/);
        const authorMatch = resultsContent.match(/"author":\s*"([^"]*)"/);
        const languagePairMatch = resultsContent.match(
          /"language_pair":\s*"([^"]*)"/
        );

        if (!idMatch || !titleMatch) return null;

        bookId = parseInt(idMatch[1]);
        title = titleMatch[1];
        author = authorMatch ? authorMatch[1] : 'Unknown Author';
        languagePair = languagePairMatch ? languagePairMatch[1] : 'unknown';
      } catch (e) {
        return null;
      }

      // Get chapter count
      const chapterSql = `SELECT COUNT(*) as count FROM chapters WHERE book_id = ${bookId};`;
      const chapterResult = execSync(`npm run db:local -- "${chapterSql}"`, {
        encoding: 'utf8',
        env: this.getCleanEnv(),
      });
      const chapterMatch = chapterResult.match(/"count":\s*(\d+)/);
      const chapterCount = chapterMatch ? parseInt(chapterMatch[1]) : 0;

      // Get content count
      const contentSql = `SELECT COUNT(*) as count FROM content_items WHERE book_id = ${bookId};`;
      const contentResult = execSync(`npm run db:local -- "${contentSql}"`, {
        encoding: 'utf8',
        env: this.getCleanEnv(),
      });
      const contentMatch = contentResult.match(/"count":\s*(\d+)/);
      const contentCount = contentMatch ? parseInt(contentMatch[1]) : 0;

      return {
        id: bookId,
        title,
        author,
        languagePair,
        chapterCount,
        contentCount,
      };
    } catch (error) {
      return null;
    }
  }

  private async getRemoteBookInfo(): Promise<BookInfo | null> {
    try {
      // Get book details
      const bookSql = `SELECT id, title, author, language_pair FROM books WHERE uuid = '${this.uuid}';`;
      const bookResults = await this.queryRemote(bookSql);

      if (!bookResults || bookResults.length === 0) return null;

      const book = bookResults[0];
      const bookId = book.id;
      const title = book.title;
      const author = book.author || 'Unknown Author';
      const languagePair = book.language_pair || 'unknown';

      // Get chapter count
      const chapterSql = `SELECT COUNT(*) as count FROM chapters WHERE book_id = ${bookId};`;
      const chapterResults = await this.queryRemote(chapterSql);
      const chapterCount = chapterResults[0]?.count || 0;

      // Get content count
      const contentSql = `SELECT COUNT(*) as count FROM content_items WHERE book_id = ${bookId};`;
      const contentResults = await this.queryRemote(contentSql);
      const contentCount = contentResults[0]?.count || 0;

      return {
        id: bookId,
        title,
        author,
        languagePair,
        chapterCount,
        contentCount,
      };
    } catch (error) {
      return null;
    }
  }

  private async askForConfirmation(bookInfo: BookInfo): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      console.log('⚠️  WARNING: This action cannot be undone!');
      console.log(
        `   This will permanently delete "${bookInfo.title}" and all its content.`
      );
      console.log(`   - ${bookInfo.chapterCount} chapters will be deleted`);
      console.log(
        `   - ${bookInfo.contentCount} content items will be deleted`
      );
      console.log('');

      rl.question(
        'Are you sure you want to delete this book? (yes/no): ',
        (answer) => {
          rl.close();
          const confirmed =
            answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y';
          resolve(confirmed);
        }
      );
    });
  }

  private async removeFromDatabase(bookId: number): Promise<void> {
    if (this.mode === 'local') {
      await this.removeFromLocalDatabase(bookId);
    } else {
      await this.removeFromRemoteDatabase(bookId);
    }
  }

  private async removeFromLocalDatabase(bookId: number): Promise<void> {
    try {
      // Remove in correct order due to foreign key constraints
      console.log('   🗑️  Removing content items...');
      const contentSql = `DELETE FROM content_items WHERE book_id = ${bookId};`;
      execSync(`npm run db:local -- "${contentSql}"`, {
        stdio: 'pipe',
        env: this.getCleanEnv(),
      });

      console.log('   🗑️  Removing chapters...');
      const chapterSql = `DELETE FROM chapters WHERE book_id = ${bookId};`;
      execSync(`npm run db:local -- "${chapterSql}"`, {
        stdio: 'pipe',
        env: this.getCleanEnv(),
      });

      console.log('   🗑️  Removing book...');
      const bookSql = `DELETE FROM books WHERE id = ${bookId};`;
      execSync(`npm run db:local -- "${bookSql}"`, {
        stdio: 'pipe',
        env: this.getCleanEnv(),
      });

      console.log('   ✅ All data removed successfully');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Database removal failed: ${errorMessage}`);
    }
  }

  private async removeFromRemoteDatabase(bookId: number): Promise<void> {
    try {
      // Remove in correct order due to foreign key constraints
      console.log('   🗑️  Removing content items...');
      await this.queryRemote(
        `DELETE FROM content_items WHERE book_id = ${bookId};`
      );

      console.log('   🗑️  Removing chapters...');
      await this.queryRemote(`DELETE FROM chapters WHERE book_id = ${bookId};`);

      console.log('   🗑️  Removing book...');
      await this.queryRemote(`DELETE FROM books WHERE id = ${bookId};`);

      console.log('   ✅ All data removed successfully');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Database removal failed: ${errorMessage}`);
    }
  }
}

// CLI Interface
function parseArgs(): RemoveOptions {
  const args = process.argv.slice(2);
  const options: any = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.split('=');
      const cleanKey = key.replace('--', '');
      options[cleanKey] = value;
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
📚 Ovid Book Removal Tool

Usage:
  ts-node scripts/remove-book.ts --uuid="book-uuid-here" [--mode=local|remote]
  npm run remove-book:local -- --uuid="book-uuid-here"
  npm run remove-book:remote -- --uuid="book-uuid-here"

Options:
  --uuid         UUID of the book to remove (required)
  --mode=MODE    Database mode: 'local' or 'remote' (default: local)
  --help, -h     Show this help message

Environment variables (required for remote mode):
  CLOUDFLARE_API_TOKEN      Your Cloudflare API token
  CLOUDFLARE_ACCOUNT_ID     Your Cloudflare account ID
  CLOUDFLARE_D1_DATABASE_ID Database ID (or set in wrangler.toml)

Examples:
  npm run remove-book:local -- --uuid="cc2b6711-82f6-443e-a174-d8897a4f4f6c"
  npm run remove-book:remote -- --uuid="cc2b6711-82f6-443e-a174-d8897a4f4f6c"

⚠️  WARNING: This operation is irreversible. The book and all its content will be permanently deleted.
`);
}

// Main execution
async function main() {
  const options = parseArgs();

  if (options.help || !options.uuid) {
    showHelp();
    process.exit(0);
  }

  try {
    // Parse mode from arguments
    let mode: DatabaseMode = 'local';
    if (options.mode) {
      if (options.mode === 'remote' || options.mode === 'local') {
        mode = options.mode;
      } else {
        console.error('❌ Invalid mode. Use --mode=local or --mode=remote');
        process.exit(1);
      }
    }

    const remover = new BookRemover(options.uuid, mode);
    await remover.remove();
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

export default BookRemover;
