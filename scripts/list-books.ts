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

interface Book {
  id: number;
  uuid: string;
  title: string;
  author: string;
  language_pair: string;
  created_at?: string;
}

class BookLister {
  async list(): Promise<void> {
    console.log('📚 Ovid Book Library');
    console.log('='.repeat(80));
    console.log('');

    try {
      // Query all books from database
      const booksSql = `SELECT id, uuid, title, author, language_pair FROM books ORDER BY id DESC;`;
      const result = execSync(`npm run db:local -- "${booksSql}"`, {
        encoding: 'utf8',
      });

      // Parse the results
      const books = this.parseBooks(result);

      if (books.length === 0) {
        console.log('📭 No books found in the database.');
        console.log('');
        console.log('💡 Import your first book with:');
        console.log('   yarn import-book -- --file="book.epub" --target="zh"');
        return;
      }

      // Display header
      console.log(
        `${'UUID'.padEnd(38)} | ${'Title'.padEnd(30)} | ${'Author'.padEnd(20)} | Language`
      );
      console.log('-'.repeat(80));

      // Display each book
      for (const book of books) {
        const title = this.truncate(book.title, 30);
        const author = this.truncate(book.author, 20);
        const langPair = book.language_pair || 'unknown';

        console.log(
          `${book.uuid.padEnd(38)} | ${title.padEnd(30)} | ${author.padEnd(20)} | ${langPair}`
        );
      }

      console.log('');
      console.log(`📊 Total: ${books.length} book${books.length > 1 ? 's' : ''}`);
      console.log('');
      console.log('💡 Commands:');
      console.log('   View book: /book/{uuid}');
      console.log('   Remove book: yarn remove-book -- --uuid="{uuid}"');
      console.log('   Sync to remote: yarn sync-remote-book -- --uuid="{uuid}"');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Failed to list books:', errorMessage);
      process.exit(1);
    }
  }

  private parseBooks(result: string): Book[] {
    try {
      // Extract JSON array from wrangler output
      const resultsMatch = result.match(/\[\s*{\s*"results":\s*\[(.*?)\]\s*}\s*\]/s);
      if (!resultsMatch) return [];

      const resultsContent = resultsMatch[1];

      // Split by book records (each starts with "id":)
      const bookMatches = resultsContent.split(/(?=\s*"id"\s*:)/g);

      const books: Book[] = [];

      for (const bookStr of bookMatches) {
        if (!bookStr.trim()) continue;

        const idMatch = bookStr.match(/"id"\s*:\s*(\d+)/);
        const uuidMatch = bookStr.match(/"uuid"\s*:\s*"([^"]+)"/);
        const titleMatch = bookStr.match(/"title"\s*:\s*"([^"]+)"/);
        const authorMatch = bookStr.match(/"author"\s*:\s*"([^"]+)"/);
        const langMatch = bookStr.match(/"language_pair"\s*:\s*"([^"]+)"/);

        if (idMatch && uuidMatch && titleMatch) {
          books.push({
            id: parseInt(idMatch[1]),
            uuid: uuidMatch[1],
            title: titleMatch[1],
            author: authorMatch ? authorMatch[1] : 'Unknown',
            language_pair: langMatch ? langMatch[1] : 'unknown',
          });
        }
      }

      return books;
    } catch (e) {
      console.warn('⚠️  Warning: Failed to parse book data');
      return [];
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
📚 Ovid Book Listing Tool

Usage:
  ts-node scripts/list-books.ts
  npm run list-books

Description:
  Lists all books currently imported in your local database.
  Shows UUID, title, author, and language pair for each book.

Options:
  --help, -h    Show this help message
`);
    process.exit(0);
  }

  try {
    const lister = new BookLister();
    await lister.list();
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

export default BookLister;
