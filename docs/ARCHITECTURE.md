# Architecture

## System Overview

Ovid is a bilingual EPUB reader with three main components:

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Browser    │────▶│  Cloudflare Worker    │────▶│  Railway         │
│  (React SPA) │◀────│  (API + static files) │◀────│  (Translator)    │
└─────────────┘     └──────────┬───────────┘     └────────┬────────┘
                               │                          │
                    ┌──────────┴───────────┐              │
                    │                      │              │
               ┌────▼────┐          ┌─────▼─────┐        │
               │   D1    │◀─────────│    R2     │        │
               │ (SQLite)│  (both   │  (Assets) │        │
               └─────────┘  write)  └───────────┘        │
                    ▲                                     │
                    └─────────────────────────────────────┘
                      (D1 REST API — reads & writes)
```

## Components

### Cloudflare Worker
The main backend. Handles:
- **API routing** — Auth, books, credits, progress, Stripe webhooks
- **Static file serving** — React build assets, SPA fallback for `/book/*` routes
- **Upload staging** — Stores the uploaded EPUB temporarily in R2 and hands it to Railway (`/upload-and-parse`) for parsing and cost estimation
- **Translation orchestration** — Fires webhook to Railway, reports progress to frontend

### Cloudflare D1 (Database)
SQLite-based. Stores all persistent data:
- Books, chapters, and paragraph-level bilingual content
- Users (Google OAuth) and sessions
- Reading progress (per user per book)
- Credit transactions (Stripe purchases, translation usage)
- Physical shelf-slot placement (`shelf_slots`/`book_shelf_slots`) — where each book sits on the 3D closet wall

### Cloudflare R2 (Asset Storage)
Object storage served at `assets.ovid.jrd.pub`:
- Generated book covers and spine images (PNG)
- Images extracted from EPUBs
- Public read access via custom domain
- CORS enabled on the bucket (`GET`/`HEAD` from `*`) — required because the 3D
  shelf loads covers/spines as WebGL textures with `crossOrigin` requests

### Railway Translator Service
A standalone Hono server that handles CPU-intensive work that exceeds CF Worker limits:
- **EPUB parsing** — Extracts TOC, chapters, paragraphs, and the embedded cover image (`book-parser.ts`)
- **Book translation** — Fetches untranslated paragraphs from D1 via REST API, translates with configurable LLM (default: gpt-4o-mini via OpenAI-compatible API), writes back to D1. 5 concurrent chapter workers with checkpoint resume.
- **Cover composition** — `cover-composer.ts` composites each book's cover and spine onto pre-made blank cloth-hardcover templates with Sharp (original cover inset, title/author typesetting, spine width scaled to book length)
- **Cover preview** — Password-protected HTML previews of book covers

## Data Flow: Book Upload

1. **Upload**: Browser → Worker (`POST /api/books/upload`); Worker stages the file in R2 and inserts a placeholder book row (`status = 'processing'`)
2. **Hand-off**: Worker fires `waitUntil(fetch(TRANSLATOR_SERVICE_URL/upload-and-parse))` and returns immediately — Railway owns the rest (parsing, DB writes, credits, translation)
3. **Parse & assets**: Railway extracts EPUB structure into D1, extracts in-book images, and composes the cover/spine → R2
4. **Translate**: Railway translates chapter by chapter (5 concurrent), writing each paragraph back to D1
5. **Poll**: Browser polls `GET /api/book/:uuid/status` → Worker checks D1 for progress
6. **Complete**: Railway updates the book's status in D1; the shelf shows the finished book on the next poll

## Data Flow: Reading

1. Browser loads `/book/:uuid/chapter/:n` → Worker serves SPA
2. SPA fetches `GET /api/book/:uuid/chapter/:n` → D1 query → JSON response
3. User scrolls to end → SPA fetches next chapter automatically
4. User clicks paragraph → local state toggle (no server call)
5. Reading position saved: `PUT /api/book/:uuid/progress` → D1

## Security

- Google OAuth for authentication, session tokens in cookies
- `TRANSLATOR_SECRET` shared between Worker and Railway for webhook auth
- Stripe webhooks verified via signing secret
- R2 assets are public-read (no sensitive content)
- User books are private by default (`user_id` filter on queries)
