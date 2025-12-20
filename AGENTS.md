# AGENTS.md - Ovid Project Documentation

## Project Overview

**Ovid** is a bilingual reading platform that allows users to import EPUB books and read them with real-time language switching between original and translated text. Users can click any paragraph to toggle between the source language and translation, creating an immersive language learning experience.

### Key Features
- **EPUB Import System**: Parse EPUB files and extract chapter structure from TOC/nav.html
- **Bilingual Content**: Store both original and translated text for each paragraph
- **Interactive Reader**: Click paragraphs to switch between languages instantly  
- **Chapter Navigation**: Navigate through books with proper chapter ordering
- **Deep Links**: Clean URLs like `/book/:uuid/chapter/:number` for direct navigation
- **Translation Integration**: Automated translation using OpenAI/OpenRouter APIs with optional concurrency
- **SQL Import/Export**: Generate SQL files for fast, reliable D1 ingestion
- **Responsive Design**: Works on desktop and mobile devices

## Architecture

### Technology Stack
- **Frontend**: React TypeScript with Create React App
- **Backend**: Cloudflare Worker (serverless)
- **Database**: Cloudflare D1 (SQLite-based)
- **Deployment**: Cloudflare Workers platform
- **Translation**: OpenAI API (via OpenRouter)

### Database Schema
```sql
-- Books table
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  original_title TEXT,
  author TEXT,
  language_pair TEXT, -- e.g., "en-zh" (English to Chinese)
  styles TEXT -- JSON for custom styling
);

-- Chapters table  
CREATE TABLE chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  original_title TEXT,
  order_index INTEGER NOT NULL, -- Correct reading order
  FOREIGN KEY (book_id) REFERENCES books(id),
  UNIQUE(book_id, chapter_number)
);

-- Content items table (paragraphs)
CREATE TABLE content_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  item_id TEXT NOT NULL, -- e.g., "p-1-5" (chapter 1, paragraph 5)
  original_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  type TEXT DEFAULT 'paragraph',
  tag_name TEXT DEFAULT 'p',
  order_index INTEGER NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id),
  FOREIGN KEY (chapter_id) REFERENCES chapters(id)
);
```

## Critical Implementation Details

### 1. EPUB Parsing System (`scripts/import-book.js`)

**Key Learning**: The initial implementation failed because it relied on EPUB spine contents which often lack proper titles. The correct approach is to use the Table of Contents (TOC) structure.

#### TOC-Based Chapter Detection
```javascript
// WRONG: Using spine contents (unreliable)
epub.spine.contents.forEach(item => {
  // Many spine items have no title or are structural files
});

// CORRECT: Using TOC entries (contains actual chapter structure)
const chapterEntries = epub.toc.filter(entry => {
  const title = entry.title.toLowerCase();
  return title.includes('introduction') || 
         title.includes('chapter') || 
         title.includes('part') ||
         (title.includes('conclusion') && title.includes('beyond'));
});
```

#### File ID Resolution Challenge
TOC entries reference files using href paths, but `epub.getChapter()` requires manifest IDs. The mapping between TOC href and manifest ID is critical:

```javascript
// Extract href from TOC entry (remove anchor)
const href = entry.href.split('#')[0]; 

// Find corresponding manifest ID by href matching
let fileId = null;
for (const id in epub.manifest) {
  if (epub.manifest[id].href === href) {
    fileId = id;
    break;
  }
}

// Fallback: match by filename if direct href fails
if (!fileId) {
  const filename = href.split('/').pop();
  for (const id in epub.manifest) {
    if (epub.manifest[id].href.endsWith(filename)) {
      fileId = id;
      break;
    }
  }
}
```

### 2. Content Processing and Cleanup

HTML cleanup is crucial for readable text extraction:

```javascript
// Comprehensive HTML cleanup
let cleanText = text
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')  // Remove scripts
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')    // Remove styles
  .replace(/<\/?(p|div|h[1-6]|br)\s*[^>]*>/gi, '\n\n') // Convert blocks to line breaks
  .replace(/<[^>]+>/g, ' ')                           // Remove remaining tags
  .replace(/[ \t]+/g, ' ')                           // Normalize whitespace
  .replace(/\n\s*\n\s*\n+/g, '\n\n')                // Normalize line breaks
  .trim();

// Split into paragraphs
const paragraphs = cleanText
  .split(/\n\s*\n/)
  .map(p => p.replace(/\n/g, ' ').trim())
  .filter(p => p.length > 30) // Paragraphs shorter than 30 chars are dropped
```

### 3. Chapter Ordering & Filtering

**Critical Issue Discovered**: EPUB import may process chapters in random order due to async operations, but the reading experience requires proper sequential ordering.

#### Filtering Threshold
- Chapter-level minimum length threshold is disabled (set to 0). All TOC chapters are considered; even very short pages (e.g., dedication, copyright) are included.

#### Solution: Dual Ordering System
- `chapter_number`: Display order for frontend (1, 2, 3, ...)
- `order_index`: Logical reading order based on book structure

```sql
-- Fix chapter ordering after import
UPDATE chapters 
SET chapter_number = order_index 
WHERE book_id = ?;
```

### 4. Translation Integration

The system supports multiple translation providers with fallback mechanisms. Translation can run with limited parallelism to speed up imports.

```javascript
async translateWithOpenAI(text) {
  if (!this.openaiConfigured) {
    return `[${this.targetLang.toUpperCase()}] ${text}`; // Fallback
  }

  const response = await this.openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a professional literary translator. Translate to ${targetLanguage}. Maintain original style and tone.`
      },
      { role: "user", content: text }
    ],
    temperature: 0.3,
    max_tokens: text.length * 2
  });

  return response.choices[0]?.message?.content?.trim();
}

// Concurrency (defaults):
// - Chapters: 2 at a time (override with --chapters-concurrency)
// - Items per chapter: 8 at a time (override with --items-concurrency or --concurrency)
```

## Frontend Implementation

### Routing
- Root library: `/`
- Reader deep link: `/book/:uuid/chapter/:number`
  - Direct load supported. Worker serves the SPA for `/book/*` and React reads the URL to fetch the correct chapter.

### Bilingual Reading Component (`src/components/BilingualReader.tsx`)

The core innovation is click-to-toggle paragraph translation:

```typescript
const handleParagraphClick = (itemId: string) => {
  setLanguageStates(prev => ({
    ...prev,
    [itemId]: prev[itemId] === 'original' ? 'translated' : 'original'
  }));
};

// Render paragraphs with click handlers
{content.map(item => (
  <p key={item.item_id} 
     onClick={() => handleParagraphClick(item.item_id)}
     className="paragraph-clickable">
    {languageStates[item.item_id] === 'original' 
      ? item.original_text 
      : item.translated_text}
  </p>
))}
```

### Chapter Navigation
- Single-chapter loading for performance
- Automatic next/previous chapter loading on scroll
- Chapter menu with proper ordering

## Deployment Architecture

### Cloudflare Worker Setup (`src/worker/index.ts`)
```typescript
// API routes
app.get('/api/book/chapter/:number', getChapter);
app.get('/api/book/chapters', getChapters);

// Static file serving for React app
app.get('/*', serveStatic);

// Environment configuration
const DB = env.DB; // Cloudflare D1 database binding
```

### Database Configuration (`wrangler.toml`)
```toml
[[ d1_databases ]]
binding = "DB"
database_name = "polyink-db"  # keeping existing database name
database_id = "your-database-id"
```

Notes:
- `wrangler.toml` is used for deploy and preview. A `wrangler.toml.local` can override values for local dev.
- A `wrangler.legacy.toml` is included to access a previous local D1 store (useful if earlier imports were written under an old config hash).

## Critical Commands for Agents

### Development
```bash
npm start                    # Start React dev server
npm run build               # Build for production
npm run deploy              # Deploy to Cloudflare Workers
```

### Book Import
```bash
# Import EPUB with translation
npm run import-book -- --file="book.epub" --target="zh" --provider="openai"

# Faster/robust import via SQL file
node scripts/import-book.js --file="book.epub" --target="zh" --sql-out=exports/book.sql --apply=local

# Parallel translation (tune conservatively if rate-limited)
node scripts/import-book.js --file="book.epub" --target="zh" --chapters-concurrency=3 --concurrency=10

# Remove book by UUID
node scripts/remove-book.js --uuid="book-uuid-here"

# Sync a local book to remote D1 (ensures schema first)
npm run sync-remote-book -- --uuid="book-uuid-here"

# Export a single local book to SQL and apply to remote in one shot
npm run sync-remote-book -- --uuid="book-uuid-here" --sql-out=exports/book_sync.sql --apply=remote
```

### Database Operations
```bash
# Execute local database commands
npm run db:local -- "SQL_COMMAND_HERE"

# Execute via file
npx wrangler d1 execute polyink-db --local --file=script.sql

# Initialize schema on current local DB
npm run db:init

# Seed demo data on current local DB
npm run db:seed

# Query old local DB (previous wrangler config hash)
npm run db:local:legacy -- "SELECT title, uuid FROM books;"
```

## Common Issues and Solutions

### 1. EPUB Import Problems
- **Symptom**: Only table of contents imported, no actual content
- **Cause**: Using spine instead of TOC for chapter detection
- **Solution**: Implement TOC-based chapter filtering as shown above

### 2. Chapter Order Issues  
- **Symptom**: Chapters appear in wrong order in reader
- **Solution**: Use `order_index` for proper sequencing, sync `chapter_number` with `order_index`

### 3. Translation API Failures
- **Symptom**: Import fails with API errors
- **Solution**: Implement fallback translations with mock text: `[ZH] original_text`

### 4. File ID Resolution Failures
- **Symptom**: "Could not read content" warnings during import
- **Solution**: Implement both exact href matching and filename fallback matching

## Environment Variables

```bash
# Required for translation
OPENAI_API_KEY=your-openai-key
OPENAI_API_BASE_URL=https://openrouter.ai/api/v1  # or https://api.openai.com/v1
OPENAI_MODEL=google/gemini-2.5-flash-lite        # or gpt-4o-mini

# Development
NODE_ENV=development

# Remote sync
CLOUDFLARE_ACCOUNT_ID=your-account-id
# (optional) CLOUDFLARE_D1_DATABASE_ID can be read from wrangler.toml.local
# (required for remote HTTP API path) CLOUDFLARE_API_TOKEN with D1:Edit scope
```

## Testing Strategy

1. **EPUB Parsing**: Use `scripts/debug-epub-structure.js` to analyze EPUB files
2. **Database Verification**: Query chapter counts and content after import
3. **Reader Testing**: Navigate through chapters and test language switching
4. **Order Verification**: Check chapter sequence in navigation menu

## Performance Considerations

- **Single Chapter Loading**: Only load one chapter at a time to reduce memory usage
- **Lazy Translation**: Translate on-demand during import, not during reading
- **Database Indexing**: Ensure proper indexes on frequently queried fields
- **Content Caching**: Cache chapter content in frontend state management
- **Parallel Translation**: Use `--chapters-concurrency` and `--items-concurrency` for faster imports; dial down if hitting API rate limits.

## Security Notes

- Never commit API keys to repository
- Use environment variables for sensitive configuration
- Sanitize all user inputs before database operations
- Use parameterized queries to prevent SQL injection

## Future Enhancements

1. **Multi-language Support**: Support more than 2 languages per book
2. **Reading Progress**: Track user reading position
3. **Offline Reading**: Cache content for offline access
4. **Social Features**: Share highlights and notes
5. **Advanced Navigation**: Search within books, bookmarks

## Conclusion for Agents

When working with this project:
1. **Always use TOC-based EPUB parsing** - spine contents are unreliable
2. **Handle chapter ordering explicitly** - async processing can scramble order
3. **Implement robust error handling** - translation APIs can fail; consider concurrency + retry with backoff if needed
4. **Test end-to-end** - import, view in reader, test language switching
5. **Use the debug tools** - they reveal EPUB structure issues quickly
### 5. SQLITE_BUSY during import/sync
- **Cause**: Many small writes contend for locks in D1/miniflare
- **Solution**: Generate a single SQL file and ingest it:
  - Import: `--sql-out=exports/book.sql --apply=local`
  - Sync: `--sql-out=exports/book_sync.sql --apply=remote`
- Avoid running multiple wrangler processes (preview/dev) during ingestion.

### 6. SQLITE_AUTH on local file ingestion
- **Cause**: PRAGMA statements are not allowed by wrangler d1 execute
- **Solution**: Generated SQL files exclude PRAGMA; if creating a manual SQL file, remove PRAGMAs before ingesting.

### 7. "no such table: books" when querying local
- **Cause**: Fresh local DB with no schema, or you're pointing at a different local DB hash
- **Solution**: Run `npm run db:init` to create schema, or use legacy script: `npm run db:local:legacy -- "..."`.
6. **Prefer SQL ingestion for bulk writes** - avoids D1 lock contention and speeds up sync/import

The project demonstrates a successful integration of modern web technologies (React, Cloudflare Workers, D1) with AI translation services to create an innovative bilingual reading experience.

Note: The database is still named "polyink-db" to preserve existing data during the project rename to Ovid.
