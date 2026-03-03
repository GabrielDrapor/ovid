# AGENTS.md — Ovid Deep Technical Reference

For quick reference, see [CLAUDE.md](CLAUDE.md). This document covers architecture details, EPUB parsing lessons, and implementation notes that are useful for deeper work.

## Architecture Overview

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system diagram.

**Stack**: React + Cloudflare Worker + D1 (SQLite) + R2 (assets) + Railway (translation service)

### How Upload → Translation Works
1. User uploads EPUB via `/api/books/upload`
2. Worker parses EPUB: extracts TOC, chapters, paragraphs → stores in D1 with `translated_text = ''`
3. Worker extracts/generates cover and spine images → uploads to R2
4. `waitUntil` fires POST to Railway translator (`TRANSLATOR_URL/translate`)
5. Railway reads untranslated items from D1 (via REST API), translates 5 chapters concurrently
6. Each translated paragraph is written back to D1 immediately (checkpoint resume)
7. Frontend polls `/api/book/:uuid/status` for progress

### Cover/Spine Generation
- Worker generates SVG covers with title/author text
- Railway's `image-processor.ts` uses Sharp to render SVG → PNG
- Spine images: vertical text, auto-sized
- Cover preview: `/cover-preview/:uuid` endpoint on Railway
- Images stored in R2 at `assets.ovid.jrd.pub`

## EPUB Parsing — Hard-Won Lessons

### Use TOC, Not Spine
The spine lists reading order but items often lack titles and include non-content files (cover pages, copyright). **Always use the TOC** for chapter detection:

```javascript
// TOC entries have titles and href to content files
const chapters = epub.toc.filter(entry => /* title-based filtering */);
```

### File ID Resolution
TOC references files by `href`, but `epub.getChapter()` needs manifest IDs. You must map:
1. Strip anchors from TOC href
2. Match against manifest by href
3. Fallback: match by filename only

### Content Cleanup
HTML from EPUBs is messy. Strip scripts, styles, convert block elements to newlines, remove tags, normalize whitespace. Filter paragraphs < 30 chars.

### Chapter Ordering
EPUB processing can be async → chapters may arrive out of order. Always use `order_index` for correct sequence, and sync `chapter_number = order_index` after import.

## Database Notes

Full schema in `database/schema.sql`. Key tables:
- `books`, `chapters`, `content_items` — content
- `users`, `sessions` — auth
- `reading_progress` — cloud-synced reading position
- `credit_transactions` — credit ledger (signup_bonus, purchase, usage, refund)

### D1 Gotchas
- **SQLITE_BUSY**: Avoid many small writes. Use single SQL file ingestion: `--sql-out=exports/book.sql --apply=local`
- **SQLITE_AUTH**: D1 rejects PRAGMA statements. Remove from manual SQL files.
- **Legacy DB name**: Still "polyink-db" in wrangler.toml to preserve existing data.

## Frontend Notes

### Routing
- `/` — Bookshelf
- `/book/:uuid/chapter/:number` — Reader (deep-linkable, SPA served by Worker)

### BilingualReaderV2
- Click paragraph → toggle `original` ↔ `translated` (state per paragraph via `item_id`)
- Single-chapter in memory, scroll triggers next/prev chapter load
- Reading progress auto-saved and restored
- CJK typography: Noto Sans CJK SC, tuned spacing

### BookShelf
- Two rows: public books, user's books
- Hover preview, click spine to read
- Cover/spine images from R2

### ErrorBoundary
Wraps the app. Catches render errors, shows recovery UI.

## Translation Service (Railway)

Located in `services/translator/`. Hono server deployed on Railway.

### Endpoints
- `POST /translate` — Start translation (requires `secret` in body)
- `GET /status/:uuid` — Translation progress
- `GET /health` — Health check
- `GET /cover-preview/:uuid` — Cover preview page

### Translation Engine
- Model: OpenRouter → `anthropic/claude-sonnet`
- 5 concurrent chapter workers
- Checkpoint resume: skips already-translated paragraphs on restart
- Writes directly to D1 via REST API (`d1-client.ts`)

### Image Processing
- `image-processor.ts`: Sharp-based cover/spine generation
- `cover-preview.ts`: HTML preview with login gate

## Testing

- `npm test` — Vitest unit tests
- `npm run test:visual` — Playwright visual regression
- `scripts/debug-epub-structure.js` — Analyze EPUB structure for debugging

## Common Issues

| Problem | Cause | Fix |
|---|---|---|
| Only TOC imported, no content | Using spine instead of TOC | Use TOC-based chapter detection |
| Chapters in wrong order | Async processing | Sync `chapter_number = order_index` |
| SQLITE_BUSY during import | Many small writes | Use SQL file ingestion |
| "no such table" locally | No schema | Run `npm run db:init` |
