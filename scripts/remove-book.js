#!/usr/bin/env node

/**
 * Ovid Book Removal Tool
 *
 * Safely removes books from the database with confirmation
 *
 * Usage:
 *   node scripts/remove-book.js --uuid="book-uuid-here"
 *   npm run remove-book -- --uuid="book-uuid-here"
 */

require('dotenv').config();
const { execSync } = require('child_process');
const readline = require('readline');

class BookRemover {
  constructor(uuid) {
    this.uuid = uuid;
    this.validateInputs();
  }

  validateInputs() {
    if (!this.uuid) {
      throw new Error('Book UUID is required. Use --uuid="your-book-uuid"');
    }

    // Basic UUID format validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(this.uuid)) {
      throw new Error('Invalid UUID format. Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
    }
  }

  async remove() {
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
      console.log(`   📊 Chapters: ${bookInfo.chapterCount}, Content items: ${bookInfo.contentCount}`);
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
      console.error('❌ Removal failed:', error.message);
      process.exit(1);
    }
  }

  async getBookInfo() {
    try {
      // Get book details
      const bookSql = `SELECT id, title, author, language_pair FROM books WHERE uuid = '${this.uuid}';`;
      const bookResult = execSync(`npm run db:local -- "${bookSql}"`, { encoding: 'utf8' });
      
      // Parse JSON response more robustly
      let bookId, title, author, languagePair;
      
      try {
        const resultsMatch = bookResult.match(/\[\s*{\s*"results":\s*\[(.*?)\]/s);
        if (!resultsMatch) return null;
        
        const resultsContent = resultsMatch[1];
        const idMatch = resultsContent.match(/"id":\s*(\d+)/);
        const titleMatch = resultsContent.match(/"title":\s*"([^"]*)"/);
        const authorMatch = resultsContent.match(/"author":\s*"([^"]*)"/);
        const languagePairMatch = resultsContent.match(/"language_pair":\s*"([^"]*)"/);
        
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
      const chapterResult = execSync(`npm run db:local -- "${chapterSql}"`, { encoding: 'utf8' });
      const chapterMatch = chapterResult.match(/"count":\s*(\d+)/);
      const chapterCount = chapterMatch ? parseInt(chapterMatch[1]) : 0;

      // Get content count
      const contentSql = `SELECT COUNT(*) as count FROM content_items WHERE book_id = ${bookId};`;
      const contentResult = execSync(`npm run db:local -- "${contentSql}"`, { encoding: 'utf8' });
      const contentMatch = contentResult.match(/"count":\s*(\d+)/);
      const contentCount = contentMatch ? parseInt(contentMatch[1]) : 0;

      return {
        id: bookId,
        title,
        author,
        languagePair,
        chapterCount,
        contentCount
      };

    } catch (error) {
      throw new Error(`Failed to fetch book info: ${error.message}`);
    }
  }

  async askForConfirmation(bookInfo) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      console.log('⚠️  WARNING: This action cannot be undone!');
      console.log(`   This will permanently delete "${bookInfo.title}" and all its content.`);
      console.log(`   - ${bookInfo.chapterCount} chapters will be deleted`);
      console.log(`   - ${bookInfo.contentCount} content items will be deleted`);
      console.log('');

      rl.question('Are you sure you want to delete this book? (yes/no): ', (answer) => {
        rl.close();
        const confirmed = answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y';
        resolve(confirmed);
      });
    });
  }

  async removeFromDatabase(bookId) {
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
      throw new Error(`Database removal failed: ${error.message}`);
    }
  }
}

// CLI Interface
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.split('=');
      const cleanKey = key.replace('--', '');
      options[cleanKey] = value;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
📚 Ovid Book Removal Tool

Usage:
  node scripts/remove-book.js --uuid="book-uuid-here"
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
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Only run if called directly
if (require.main === module) {
  main();
}

module.exports = BookRemover;