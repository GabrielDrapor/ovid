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
  help?: boolean;
}

class BookRemover {
  private uuid: string;

  constructor(uuid: string) {
    this.uuid = uuid;
    this.validateInputs();
  }

  private validateInputs(): void {
    if (!this.uuid) {
      throw new Error('Book UUID is required. Use --uuid="your-book-uuid"');
    }

    // Basic UUID format validation
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(this.uuid)) {
      throw new Error(
        'Invalid UUID format. Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
      );
    }
  }

  async remove(): Promise<void> {
    console.log('📚 Ovid Book Removal Tool');
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

      console.log(`   ✅ Found book: "${bookInfo.title}" by ${bookInfo.author}`);
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

  private async getBookInfo(): Promise<BookInfo | null> {
    try {
      // Get book details
      const bookSql = `SELECT id, title, author, language_pair FROM books WHERE uuid = '${this.uuid}';`;
      const bookResult = execSync(`npm run db:local -- "${bookSql}"`, {
        encoding: 'utf8',
      });

      // Parse JSON response more robustly
      let bookId: number;
      let title: string;
      let author: string;
      let languagePair: string;

      try {
        const resultsMatch = bookResult.match(/\[\s*{\s*"results":\s*\[(.*?)\]/s);
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
      });
      const chapterMatch = chapterResult.match(/"count":\s*(\d+)/);
      const chapterCount = chapterMatch ? parseInt(chapterMatch[1]) : 0;

      // Get content count
      const contentSql = `SELECT COUNT(*) as count FROM content_items WHERE book_id = ${bookId};`;
      const contentResult = execSync(`npm run db:local -- "${contentSql}"`, {
        encoding: 'utf8',
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
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fetch book info: ${errorMessage}`);
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
      console.log(`   - ${bookInfo.contentCount} content items will be deleted`);
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
    try {
      // Remove in correct order due to foreign key constraints
      console.log('   🗑️  Removing content items...');
      const contentSql = `DELETE FROM content_items WHERE book_id = ${bookId};`;
      execSync(`npm run db:local -- "${contentSql}"`, { stdio: 'pipe' });

      console.log('   🗑️  Removing chapters...');
      const chapterSql = `DELETE FROM chapters WHERE book_id = ${bookId};`;
      execSync(`npm run db:local -- "${chapterSql}"`, { stdio: 'pipe' });

      console.log('   🗑️  Removing book...');
      const bookSql = `DELETE FROM books WHERE id = ${bookId};`;
      execSync(`npm run db:local -- "${bookSql}"`, { stdio: 'pipe' });

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
  ts-node scripts/remove-book.ts --uuid="book-uuid-here"
  npm run remove-book -- --uuid="book-uuid-here"

Options:
  --uuid         UUID of the book to remove (required)

Examples:
  npm run remove-book -- --uuid="cc2b6711-82f6-443e-a174-d8897a4f4f6c"

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
    const remover = new BookRemover(options.uuid);
    await remover.remove();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Error:', errorMessage);
    process.exit(1);
  }
}

// Only run if called directly
if (require.main === module) {
  main();
}

export default BookRemover;
