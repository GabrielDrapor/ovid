# CLAUDE.md

Guidance for Claude Code working on this repo.

## Commands

### Dev & Deploy
- `npm run preview` — Full-stack local dev (Worker + React)
- `npm run deploy` — `yarn build && wrangler deploy`
- `npm test` — Vitest
- `npm run test:visual` — Playwright visual regression tests
- `npm run format` / `npm run format:check` — Prettier

### Book Management
- `yarn import-book -- --file="book.epub" --target="zh"` — Import EPUB with translation
- `yarn list-books:local` / `yarn list-books:remote` — List books
- `yarn remove-book:local -- --uuid="..."` / `yarn remove-book:remote -- --uuid="..."` — Remove book
- `yarn sync-remote-book -- --uuid="..."` — Sync local book to remote D1
- `yarn generate-cover -- --uuid="..."` — Generate cover image

### Database
- `npm run db:init` — Create schema locally
- `npm run db:seed` — Insert sample data
- `npm run db:local -- "SQL"` — Run SQL on local D1
- `npm run db:remote -- "SQL"` — Run SQL on remote D1
- `npm run db:local:file` / `npm run db:remote:file` — Execute SQL file

## Architecture

TypeScript everywhere. React frontend + Cloudflare Worker backend + D1 database + R2 asset storage.

### Key Directories
- `src/components/` — React: `BookShelf.tsx`, `BilingualReaderV2.tsx`, `ErrorBoundary.tsx`
- `src/worker/` — CF Worker modules:
  - `index.ts` — Router, static serving, SPA fallback
  - `auth.ts` — Google OAuth flow
  - `book-handlers.ts` — Book CRUD, upload, translation orchestration
  - `cover-generator.ts` — SVG-based cover/spine image generation
  - `credits.ts` — Credit balance, Stripe checkout/webhooks
  - `db.ts` — D1 query helpers
  - `types.ts` — Shared types/Env interface
- `services/translator/` — Railway translation service (Hono server):
  - `index.ts` — Routes: `/translate`, `/status/:uuid`, `/health`, cover preview
  - `translate-worker.ts` — Chapter-by-chapter translation (5 concurrent, resume support)
  - `d1-client.ts` — D1 REST API client (reads/writes directly to D1)
  - `image-processor.ts` — Cover/spine image processing (Sharp)
  - `cover-preview.ts` — HTML preview generation for covers
- `scripts/` — CLI: import-book, list-books, remove-book, sync-remote-book, generate-cover
- `database/` — `schema.sql`, `sample_data.sql`, migrations

### R2 Asset Storage
- Bucket served at `https://assets.ovid.jrd.pub`
- Stores: book cover images, spine images, in-book images extracted from EPUBs
- Cover/spine auto-generated during upload (SVG → PNG via Sharp on Railway)

### Translation Flow
1. User uploads EPUB → Worker parses, stores chapters in D1 (untranslated)
2. Worker fires webhook to Railway translator via `waitUntil`
3. Railway fetches untranslated chapters from D1, translates via OpenRouter (Claude Sonnet)
4. Railway writes translations back to D1, 5 chapters concurrently, with checkpoint resume
5. Worker's `/api/book/:uuid/status` polls D1 to report progress to frontend

## API Endpoints

### Auth
- `GET /api/auth/google` — Start OAuth
- `GET /api/auth/callback/google` — OAuth callback
- `GET /api/auth/me` — Current user
- `POST /api/auth/logout` — Logout

### Books
- `GET /api/books` — List books (public + user's private)
- `POST /api/books/upload` — Upload EPUB (auth required, costs credits)
- `POST /api/books/estimate` — Estimate translation cost
- `GET /api/book/:uuid/chapters` — Chapter list
- `GET /api/book/:uuid/chapter/:number` — Chapter content
- `GET /api/book/:uuid/content` — Full book content
- `GET /api/book/:uuid/status` — Translation status
- `POST /api/book/:uuid/translate-next` — Trigger next chapter translation
- `POST /api/book/:uuid/mark-complete` — Mark translation complete
- `DELETE /api/book/:uuid` — Delete book (owner only)

### Reading Progress
- `GET /api/book/:uuid/progress` — Get reading progress
- `PUT /api/book/:uuid/progress` — Update reading progress

### Credits & Payments
- `GET /api/credits` — Credit balance + packages
- `GET /api/credits/transactions` — Transaction history
- `POST /api/stripe/checkout` — Create checkout session
- `GET /api/stripe/verify-session` — Verify payment
- `POST /api/stripe/webhook` — Stripe webhook

## Database Schema (D1)

### Content
- **books** — `id, uuid, title, original_title, author, language_pair, styles, user_id, book_cover_img_url, book_spine_img_url, created_at, updated_at`
- **chapters** — `id, book_id, chapter_number, title, original_title, order_index, created_at`
- **content_items** — `id, book_id, chapter_id, item_id, original_text, translated_text, type, class_name, tag_name, styles, order_index, created_at`

### Users & Auth
- **users** — `id, google_id, email, name, picture, credits (default 1000), created_at, updated_at`
- **sessions** — `id, user_id, session_token, expires_at, created_at`

### Progress & Credits
- **reading_progress** — `id, user_id, book_uuid, chapter_number, updated_at` (unique on user_id+book_uuid)
- **credit_transactions** — `id, user_id, amount, type, description, stripe_payment_intent_id, book_uuid, balance_after, created_at`

## Environment Variables

### Worker (wrangler secrets)
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `APP_URL`, `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `TRANSLATOR_SECRET`, `TRANSLATOR_URL`

### Railway Translator
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_D1_DATABASE_ID`, `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`, `TRANSLATOR_SECRET`

### Local CLI (.env)
`OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_D1_DATABASE_ID`

## URLs
- Production: https://lib.jrd.pub
- Staging: https://ovid-staging.drapor.workers.dev
- Assets (R2): https://assets.ovid.jrd.pub

## Key Patterns
- EPUB parsing uses TOC (not spine) for chapter detection — spine is unreliable
- XPath-based paragraph mapping for bilingual alignment
- Single-chapter rendering for scroll performance
- Cover/spine images auto-generated as SVG, rendered to PNG via Railway's Sharp
- `ErrorBoundary` wraps the app for graceful crash recovery
- Database still named "polyink-db" in wrangler.toml (legacy, preserves data)
