# AGENTS.md — Ovid Deep Technical Reference

For quick reference, see [CLAUDE.md](CLAUDE.md). This document covers architecture details, EPUB parsing lessons, and implementation notes that are useful for deeper work.

## Architecture Overview

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system diagram.

**Stack**: React + Cloudflare Worker + D1 (SQLite) + R2 (assets) + Railway (translation service)

### How Upload → Translation Works
1. User uploads EPUB via `/api/books/upload`; Worker stages the file in R2 and inserts a placeholder book row
2. `waitUntil` fires POST to Railway (`TRANSLATOR_SERVICE_URL/upload-and-parse`) — Railway owns everything from here (parsing, DB writes, credits, translation, covers)
3. Railway parses the EPUB (TOC, chapters, paragraphs, embedded cover) → stores in D1
4. Railway translates 5 chapters concurrently, writing each paragraph back to D1 immediately (checkpoint resume)
5. Frontend polls `/api/book/:uuid/status` for progress

### Cover/Spine Generation
- Railway's `cover-composer.ts` composites each book onto a pre-made blank
  cloth-hardcover template with Sharp (no AI at request time): original-cover
  inset with book-face detection, title/author typesetting, spine width scaled
  to book length
- Blank templates are generated offline by `scripts/generate-blanks.ts`
- `image-processor.ts` is the legacy SVG→PNG path, still used by the
  cover-preview debug page (`/cover-preview/:uuid` on Railway, password-gated)
- Images stored in R2 at `assets.ovid.jrd.pub`
- **R2 CORS matters**: the 3D shelf loads covers/spines as WebGL textures, so
  the bucket has a CORS rule (`GET`/`HEAD` from `*`). Every `<img>`/preload of
  these assets must set `crossOrigin="anonymous"` — a non-CORS response cached
  by the browser will poison later `crossOrigin` texture fetches and covers
  silently fall back to procedural canvases.

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

Production runs on the **v2 schema** (`database/schema_v2.sql`); `database/schema.sql` is the legacy v1 layout. Key tables:
- `books_v2`, `chapters_v2` (raw EPUB HTML), `translations_v2` (XPath-mapped translations) — content
- `users`, `sessions` — auth
- `user_book_progress` — completion + cloud-synced reading position
- `credit_transactions` — credit ledger (signup_bonus, purchase, usage, refund)

### D1 Gotchas
- **SQLITE_BUSY**: Avoid many small writes. Use single SQL file ingestion: `--sql-out=exports/book.sql --apply=local`
- **SQLITE_AUTH**: D1 rejects PRAGMA statements. Remove from manual SQL files.

## Frontend Notes

### Routing
- `/` — Bookshelf
- `/book/:uuid/chapter/:number` — Reader (deep-linkable, SPA served by Worker)

### BilingualReaderV2
- Click paragraph → toggle `original` ↔ `translated` (state per paragraph via `item_id`)
- Single-chapter in memory, scroll triggers next/prev chapter load
- Reading progress auto-saved and restored
- CJK typography: LXGW Neo ZhiSong Screen, tuned spacing

### BookShelf
- Default view: 3D closet (`shelf3d/BookShelf3D.tsx`, three + @react-three/fiber,
  lazy-loaded) — gaze/zoom camera, click a book to fly it out with an info panel;
  shelf-packing math lives in `shelf3d/layout.ts` (pure, unit-tested)
- Classic 2D wall remains as the no-WebGL fallback inside `BookShelf.tsx`
- Cover/spine images from R2, loaded with `crossOrigin` (see R2 CORS note above)

### iOS PWA Gotchas
- The app is installable (manifest + service worker in `src/sw-register.ts`,
  update toast on new deploys)
- In standalone mode `100vh` spans the full screen but the webview starts below
  the status bar — size full-screen containers with `100dvh` (keep a `100vh`
  fallback) and pad bottom-anchored UI with `env(safe-area-inset-bottom)`

### ErrorBoundary
Wraps the app. Catches render errors, shows recovery UI.

## Translation Service (Railway)

Located in `services/translator/`. Hono server deployed on Railway.

### Endpoints
- `POST /upload-and-parse` — Full pipeline for a staged upload: parse, credits, covers, translation (requires `secret`)
- `POST /estimate` — Parse a staged file and return a cost estimate
- `POST /translate` — Start/resume translation only (requires `secret`)
- `GET /status/:uuid` — Translation progress
- `GET /health` — Health check
- `GET /preview` — Password-gated cover preview/regeneration pages
- `POST /admin/regenerate-cover` — Recompose a book's cover/spine

### Translation Engine
- Model: `OPENAI_MODEL` on any OpenAI-compatible endpoint (default `gpt-4o-mini`)
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
