# AGENTS.md — Ovid Deep Technical Reference

For quick command reference, see [CLAUDE.md](CLAUDE.md). This document covers implementation details, lessons learned, and non-obvious behaviors.

## EPUB Parsing — Lessons Learned

### Use TOC, Not Spine
The initial implementation failed because it relied on EPUB spine contents, which often lack proper titles. **Always use TOC entries** for chapter detection:

```javascript
// WRONG: spine contents are unreliable
epub.spine.contents.forEach(item => { /* many have no title */ });

// CORRECT: TOC has actual chapter structure
const chapters = epub.toc.filter(entry => {
  const title = entry.title.toLowerCase();
  return title.includes('chapter') || title.includes('introduction') || ...;
});
```

### File ID Resolution
TOC entries reference files by href, but `epub.getChapter()` needs manifest IDs. You need a two-pass lookup:

1. **Exact match**: Compare TOC href (sans anchor) against manifest hrefs
2. **Filename fallback**: Match by filename if direct href fails

```javascript
const href = entry.href.split('#')[0];
let fileId = null;
// Pass 1: exact href
for (const id in epub.manifest) {
  if (epub.manifest[id].href === href) { fileId = id; break; }
}
// Pass 2: filename fallback
if (!fileId) {
  const filename = href.split('/').pop();
  for (const id in epub.manifest) {
    if (epub.manifest[id].href.endsWith(filename)) { fileId = id; break; }
  }
}
```

### Chapter Ordering
EPUB import may process chapters out of order (async). The DB uses a dual system:
- `chapter_number` — display order (1, 2, 3...)
- `order_index` — logical reading order from book structure

After import, sync them: `UPDATE chapters SET chapter_number = order_index WHERE book_id = ?`

### Content Cleanup
HTML → text extraction needs aggressive cleanup:
- Strip `<script>` and `<style>` blocks
- Convert block elements (`<p>`, `<div>`, `<h1-6>`, `<br>`) to newlines
- Remove remaining tags
- Normalize whitespace
- Split on double-newlines into paragraphs
- Paragraphs < 30 chars are dropped

### Image Handling
- In-book images are extracted from EPUB and uploaded to R2: `books/{uuid}/images/{filename}`
- `rawHtml` `src` attributes are rewritten to point to R2 URLs
- Internal links (non-http `<a>` tags) are expanded to plain text

## Translation System

### Architecture
Worker CPU limit (30s) can't handle full-book translation. Solution: Railway-hosted service.

**Flow:**
1. Worker receives EPUB upload → parses → stores in D1 (translated_text = '')
2. `waitUntil`: POST webhook to Railway with `{bookUuid, secret}`
3. Railway picks up → reads untranslated chapters from D1 REST API
4. Translates 5 chapters concurrently via OpenAI-compatible API (default: gpt-4o-mini)
5. Writes translations back to D1 per-paragraph (checkpoint resume)
6. Marks book complete

**Checkpoint resume**: Tracks `current_chapter` + `current_item_offset`. If interrupted, picks up where it left off.

### Cover & Spine Generation
- AI-generated via Gemini 2.5 Flash Image
- Cover images stored in R2, URLs saved in `books.book_cover_img_url` / `book_spine_img_url`
- Sharp used for image processing (crop, resize, format conversion)
- Password-protected preview page at `/api/cover-preview/:uuid`

## Worker Internals

### Error Handling
- `ErrorBoundary` component wraps the React app
- `fetchWithRetry` for resilient API calls
- Rate limiter on upload endpoint
- Credits use atomic DB operations (SELECT + UPDATE in same query)

### Auth Flow
Google OAuth → callback creates session → session token in cookie → `GET /api/auth/me` checks session on each page load.

### SPA Routing
Worker serves React build. Routes matching `/book/*` return `index.html` for client-side routing. React reads URL params for book UUID and chapter number.

## Database Notes

### D1 Quirks
- **SQLITE_BUSY**: Bulk writes cause lock contention. Solution: generate a single SQL file and ingest it (`--sql-out=exports/book.sql --apply=local`)
- **SQLITE_AUTH on PRAGMA**: `wrangler d1 execute` doesn't allow PRAGMA statements. Strip them from SQL files.
- **Multiple local DBs**: Different wrangler configs create different local DB hashes. Use `npm run db:local:legacy` to access old ones.
- DB is named `ovid-db` in wrangler.toml (was `polyink-db` historically)

### Migration Strategy
Auto-migrations in `src/worker/db.ts` — Worker checks and applies on startup. Schema additions use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` (wrapped in try/catch since D1 doesn't support `IF NOT EXISTS` on ALTER).

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| Only TOC imported, no content | Using spine instead of TOC | Use TOC-based chapter detection |
| Chapters in wrong order | Async processing | Sync `chapter_number` with `order_index` |
| "Could not read content" on import | File ID resolution failure | Check both href and filename matching |
| Import/sync hangs | SQLITE_BUSY from many small writes | Use `--sql-out` for bulk SQL ingestion |
| `no such table: books` locally | Fresh DB or wrong config hash | Run `npm run db:init` or use legacy script |
| Cover preview 404 | Missing R2 image | Check R2 bucket, regenerate cover |
