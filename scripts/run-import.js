// Direct import runner - bypasses npx/fork (for zombie-process environments)
process.argv = [
  'node', 'import-book.ts',
  '--file=/data/workspace/books/The Picture of Dorian Gray_ (z-library.sk, 1lib.sk, z-lib.sk) (Oscar Wilde).epub',
  '--target=zh'
];
require('ts-node').register({ project: 'scripts/tsconfig.json' });
const BookImporter = require('./import-book.ts').default;

// Manually parse and run
const options = {
  file: '/data/workspace/books/The Picture of Dorian Gray_ (z-library.sk, 1lib.sk, z-lib.sk) (Oscar Wilde).epub',
  target: 'zh',
  source: 'en',
  concurrency: 10,
  chapterConcurrency: 3,
  delay: 200,
};

const importer = new BookImporter(options);
importer.import().then(uuid => {
  console.log('✅ Done! UUID:', uuid);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
