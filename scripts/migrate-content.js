const fs = require('fs');
const path = require('path');

// Read the bilingual content JSON
const contentPath = path.join(__dirname, '..', 'src', 'bilingual-content.json');
const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));

// Generate SQL statements for migration
function generateMigrationSQL() {
  const statements = [];

  // Insert book record
  const bookSQL = `INSERT INTO books (title, original_title, author, language_pair, styles) 
    VALUES ('${content.title.replace(/'/g, "''")}', '${content.originalTitle.replace(/'/g, "''")}', '${content.author.replace(/'/g, "''")}', 'en-zh', '${content.styles.replace(/'/g, "''").replace(/\n/g, ' ')}');`;
  statements.push(bookSQL);

  let currentChapterNumber = 0;
  let currentChapterId = null;
  let orderIndex = 0;

  // Process content items
  content.content.forEach((item, index) => {
    if (item.type === 'chapter') {
      currentChapterNumber++;

      // Insert chapter record
      const chapterSQL = `INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) 
        VALUES (1, ${currentChapterNumber}, '${item.translated.replace(/'/g, "''")}', '${item.original.replace(/'/g, "''")}', ${orderIndex});`;
      statements.push(chapterSQL);

      currentChapterId = currentChapterNumber;
    }

    // Insert content item
    const chapterIdValue = currentChapterId ? currentChapterId : 'NULL';
    const classNameValue = item.className
      ? `'${item.className.replace(/'/g, "''")}'`
      : 'NULL';
    const tagNameValue = item.tagName
      ? `'${item.tagName.replace(/'/g, "''")}'`
      : 'NULL';
    const stylesValue = item.styles
      ? `'${item.styles.replace(/'/g, "''")}'`
      : 'NULL';

    const contentSQL = `INSERT INTO content_items (book_id, item_id, original_text, translated_text, type, class_name, tag_name, styles, order_index, chapter_id) 
      VALUES (1, '${item.id}', '${item.original.replace(/'/g, "''")}', '${item.translated.replace(/'/g, "''")}', '${item.type || 'paragraph'}', ${classNameValue}, ${tagNameValue}, ${stylesValue}, ${orderIndex}, ${chapterIdValue});`;
    statements.push(contentSQL);

    orderIndex++;
  });

  return statements;
}

// Generate the migration SQL
const sqlStatements = generateMigrationSQL();

// Write to file
const migrationSQL = sqlStatements.join('\n\n');
fs.writeFileSync(
  path.join(__dirname, '..', 'database', 'migration_002_import_content.sql'),
  migrationSQL
);

console.log(`Generated migration with ${sqlStatements.length} SQL statements`);
console.log('File written to: database/migration_002_import_content.sql');
