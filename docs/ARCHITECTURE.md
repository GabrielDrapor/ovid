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
- **EPUB parsing** — Extracts TOC, chapters, paragraphs on upload
- **Cover generation** — Creates SVG-based cover/spine images
- **Translation orchestration** — Fires webhook to Railway, reports progress to frontend
- **R2 uploads** — Stores cover images and book assets

### Cloudflare D1 (Database)
SQLite-based. Stores all persistent data:
- Books, chapters, and paragraph-level bilingual content
- Users (Google OAuth) and sessions
- Reading progress (per user per book)
- Credit transactions (Stripe purchases, translation usage)

### Cloudflare R2 (Asset Storage)
Object storage served at `assets.ovid.jrd.pub`:
- Generated book covers and spine images (PNG)
- Images extracted from EPUBs
- Public read access via custom domain

### Railway Translator Service
A standalone Hono server that handles CPU-intensive work that exceeds CF Worker limits:
- **Book translation** — Fetches untranslated paragraphs from D1 via REST API, translates with Claude Sonnet (via OpenRouter), writes back to D1. 5 concurrent chapter workers with checkpoint resume.
- **Image processing** — Uses Sharp for SVG→PNG rendering of covers/spines
- **Cover preview** — Generates HTML previews of book covers

## Data Flow: Book Upload

1. **Upload**: Browser → Worker (`POST /api/books/upload`)
2. **Parse**: Worker extracts EPUB structure, stores in D1 (untranslated)
3. **Assets**: Worker generates cover SVG, extracts images → R2
4. **Webhook**: Worker fires `waitUntil(fetch(TRANSLATOR_URL/translate))` with book UUID
5. **Translate**: Railway reads from D1, translates chapter by chapter, writes back to D1
6. **Poll**: Browser polls `GET /api/book/:uuid/status` → Worker checks D1 for progress
7. **Complete**: Railway calls `POST /api/book/:uuid/mark-complete` when done

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
