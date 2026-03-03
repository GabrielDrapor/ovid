# CLAUDE.md

Guidance for Claude Code working on this repo.

## Commands

### Dev & Deploy
- `npm run preview` — Full-stack local dev (Worker + React on :8787)
- `npm run deploy` — `yarn build && wrangler deploy` to production
- `npm run deploy -- --env staging` — Deploy to staging
- `npm run build` — Build React app only
- `npm run format` — Prettier
- `npm run format:check` — Check formatting

### Testing
- `npm test` — Vitest unit tests
- `npm run test:watch` — Vitest watch mode
- `npm run test:visual` — Playwright visual regression
- `npm run test:visual:update` — Update Playwright snapshots

### Database
- `npm run db:init` — Init local DB schema
- `npm run db:seed` — Load sample data
- `npm run db:local -- "SQL"` — Run SQL on local D1
- `npm run db:remote -- "SQL"` — Run SQL on remote D1
- `npm run db:local:file -- path.sql` — Execute SQL file locally
- `npm run db:remote:file -- path.sql` — Execute SQL file remotely

### Book Management (TypeScript CLI)
- `yarn import-book -- --file="book.epub" --target="zh"` — Import + translate
- `yarn list-books:local` / `yarn list-books:remote` — List books
- `yarn remove-book:local -- --uuid="..."` / `yarn remove-book:remote -- --uuid="..."` — Remove book
- `yarn sync-remote-book -- --uuid="..."` — Sync local book to remote D1

## Architecture

TypeScript-first across frontend, backend, CLI, and translator service.

### Components
- **React SPA** (`src/components/`) — BookShelf, BilingualReaderV2, ErrorBoundary
- **CF Worker** (`src/worker/`) — API server: auth, book-handlers, cover-generator, credits, db, types
- **Railway Translator** (`services/translator/`) — Long-running translation service (Hono + Sharp)
  - Receives webhook from Worker on EPUB upload
  - Translates via OpenAI-compatible API (default: gpt-4o-mini), 5 concurrent chapters
  - Reads/writes D1 via REST API, supports checkpoint resume
  - Also handles cover/spine AI generation (Gemini 2.5 Flash Image) and image processing
- **CLI Scripts** (`scripts/`) — import-book, list-books, remove-book, sync-remote-book, generate-cover
- **D1 SQLite** — Users, sessions, books, chapters, content_items, credits, reading progress
- **R2 Storage** — Cover images, spine images, in-book images (`books/{uuid}/images/`)

### Key Files
- `src/worker/index.ts` — Main Worker entry, routing, middleware
- `src/worker/auth.ts` — Google OAuth flow
- `src/worker/book-handlers.ts` — Book CRUD, upload, chapter content
- `src/worker/cover-generator.ts` — AI cover/spine generation
- `src/worker/credits.ts` — Credit balance, Stripe checkout/webhooks
- `src/worker/db.ts` — Database helpers, migrations
- `src/components/BilingualReaderV2.tsx` — Main reader (scroll nav, paragraph toggle, progress)
- `src/components/BookShelf.tsx` — Library UI (spines, covers, previews)
- `src/components/ErrorBoundary.tsx` — Error boundary wrapper
- `src/utils/translator.ts` — Unified translation module (used by CLI scripts)
- `services/translator/src/index.ts` — Railway service entry (Hono routes)
- `services/translator/src/translate-worker.ts` — Translation logic
- `services/translator/src/d1-client.ts` — D1 REST API client
- `services/translator/src/image-processor.ts` — Cover/spine image processing (Sharp)
- `services/translator/src/cover-preview.ts` — Password-protected cover preview page

## API Endpoints

### Auth
- `GET /api/auth/google` — Start OAuth flow
- `GET /api/auth/callback/google` — OAuth callback
- `GET /api/auth/me` — Current user
- `POST /api/auth/logout` — Logout

### Books
- `GET /api/books` — List books (public + user's private)
- `POST /api/books/upload` — Upload EPUB (auth required, deducts credits)
- `GET /api/book/:uuid/chapters` — Chapter list
- `GET /api/book/:uuid/chapter/:number` — Chapter content (XPath-mapped paragraphs)
- `GET /api/book/:uuid/content` — Full book content
- `DELETE /api/book/:uuid` — Delete book (owner only)

### Reading Progress
- `POST /api/book/:uuid/mark-complete` — Mark book read/unread (`{isCompleted: bool}`)
- `GET /api/book/:uuid/progress` — Get reading progress

### Credits & Payments
- `GET /api/credits` — Balance + available packages
- `GET /api/credits/transactions` — Purchase/usage history
- `POST /api/stripe/checkout` — Create Stripe checkout session
- `GET /api/stripe/verify-session` — Verify checkout (webhook fallback)
- `POST /api/stripe/webhook` — Stripe webhook

### Cover Preview
- `GET /api/cover-preview/:uuid` — Password-protected cover/spine preview

## Database Schema

### Core Tables
- **users** — `id, google_id, email, name, picture, credits, created_at, updated_at`
- **sessions** — `id, user_id, session_token, expires_at`
- **books** — `id, uuid, title, original_title, author, language_pair, styles, user_id, is_public, book_cover_img_url, book_spine_img_url, created_at, updated_at`
- **chapters** — `id, book_id, chapter_number, title, original_title, order_index`
- **content_items** — `id, book_id, chapter_id, item_id, original_text, translated_text, type, tag_name, order_index`

### User Data
- **user_book_progress** — `id, user_id, book_uuid, is_completed, completed_at, last_read_at` (UNIQUE user_id + book_uuid)
- **credit_transactions** — `id, user_id, amount, type (purchase/usage), stripe_payment_intent_id, balance_after, created_at`

## Environment Variables

### Worker Secrets (`wrangler secret put`)
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
- `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`
- `TRANSLATOR_URL`, `TRANSLATOR_SECRET`

### wrangler.toml vars
- `APP_URL` — e.g. `https://ovid.ink`

### Local .env (CLI scripts)
- `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_D1_DATABASE_ID`

## Development Rules

- **Branch off main** — `feature/` or `fix/` branches, PR back to main
- **Never force push**
- **Tests required** — Run `npm test` before submitting. New features need new tests.
- **CI** — Push to main auto-deploys via GitHub Actions
- **Railway** — Translator service auto-deploys on git push separately
