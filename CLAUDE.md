# CLAUDE.md

Guidance for Claude Code working on this repo.

## Commands

### Dev & Deploy
- `yarn preview` — Full-stack local dev (Worker + React on :8787)
- `yarn deploy` — `yarn build && wrangler deploy` to production
- `yarn deploy -- --env staging` — Deploy to staging
- `yarn build` — Build React app only
- `yarn format` — Prettier
- `yarn format:check` — Check formatting

### Testing
- `yarn test` — Vitest unit tests
- `yarn test:watch` — Vitest watch mode
- `yarn test:visual` — Playwright visual regression
- `yarn test:visual:update` — Update Playwright snapshots

### Database
- `yarn db:init` — Init local DB schema
- `yarn db:seed` — Load sample data
- `yarn db:local -- "SQL"` — Run SQL on local D1
- `yarn db:remote -- "SQL"` — Run SQL on remote D1
- `yarn db:local:file -- path.sql` — Execute SQL file locally
- `yarn db:remote:file -- path.sql` — Execute SQL file remotely

### Book Management (TypeScript CLI)
- `yarn import-book -- --file="book.epub" --target="zh"` — Import + translate
- `yarn list-books:local` / `yarn list-books:remote` — List books
- `yarn remove-book:local -- --uuid="..."` / `yarn remove-book:remote -- --uuid="..."` — Remove book
- `yarn sync-remote-book -- --uuid="..."` — Sync local book to remote D1

## Architecture

TypeScript-first across frontend, backend, CLI, and translator service.

### Components
- **React SPA** (`src/components/`) — BookShelf (3D closet, with a legacy 2D wall fallback), BilingualReaderV2, ErrorBoundary
- **CF Worker** (`src/worker/`) — API server: auth, book-handlers, credits, db, types
- **Railway Translator** (`services/translator/`) — Long-running translation service (Hono + Sharp)
  - Receives webhook from Worker on EPUB upload
  - Translates via OpenAI-compatible API (default: gpt-4o-mini), 5 concurrent chapters
  - Reads/writes D1 via REST API, supports checkpoint resume
  - Generates each book's cover + spine by compositing onto a pre-made blank
    cloth-hardcover template (pure Sharp, no AI at request time) — see
    `cover-composer.ts`. Spine width scales with book length.
- **CLI Scripts** (`scripts/`) — import-book, list-books, remove-book, sync-remote-book, generate-blanks
- **D1 SQLite** — Users, sessions, books/chapters/translations (v2 tables), translation jobs, credits, reading progress
- **R2 Storage** — Cover images, spine images, in-book images (`books/{uuid}/images/`). CORS enabled (`GET`/`HEAD` from `*`) — the 3D shelf loads these as WebGL textures
- **PWA** — Installable (manifest + iOS metas); `src/sw-register.ts` registers the service worker and shows a refresh toast on new deploys. iOS standalone quirk: use `100dvh`/`safe-area-inset-bottom` for full-screen layouts, not bare `100vh`

### Key Files
- `src/worker/index.ts` — Main Worker entry, routing, middleware
- `src/worker/auth.ts` — Google OAuth flow
- `src/worker/book-handlers.ts` — Book CRUD, upload, chapter content
- `src/worker/credits.ts` — Credit balance, Stripe checkout/webhooks
- `src/worker/db.ts` — Database helpers, migrations
- `src/components/BilingualReaderV2.tsx` — Main reader (scroll nav, paragraph toggle, progress)
- `src/components/BookShelf.tsx` — Library UI: hosts the 3D closet (default). Falls back to a classic 2D wall when WebGL is unavailable, but that fallback is legacy/deprecated — it has no upload entry point (upload only happens by clicking an empty slot in the 3D closet) and is slated for removal
- `src/components/shelf3d/BookShelf3D.tsx` — 3D closet view (three + @react-three/fiber, lazy-loaded): gaze/zoom camera, click-to-fly-out book with info panel, click-empty-slot-to-upload. Requires CORS on the R2 assets domain (configured on bucket `ovid`)
- `src/components/shelf3d/layout.ts` — Pure shelf-packing math for the 3D view: books explicitly placed in a physical slot (`shelf_row`/`shelf_col`) render at that coordinate; everything else packs into a stable block of rows below the physical slots, grouped by shelf/ownership (adaptive case width, unit-tested)
- `src/components/ErrorBoundary.tsx` — Error boundary wrapper
- `src/utils/translator.ts` — Unified translation module (used by CLI scripts)
- `services/translator/src/index.ts` — Railway service entry (Hono routes)
- `services/translator/src/translate-worker.ts` — Translation logic
- `services/translator/src/d1-client.ts` — D1 REST API client
- `services/translator/src/cover-composer.ts` — Composes cover + spine onto blank cloth templates (Sharp): book-face detection, original-cover inset, title/author typesetting, length-based spine thickness
- `services/translator/src/book-parser.ts` — EPUB parsing; also extracts the embedded cover (used as the cover inset)
- `services/translator/src/image-processor.ts` — Legacy cover/spine image processing (Sharp), used by the cover-preview debug page
- `services/translator/src/cover-preview.ts` — Password-protected cover preview page

## API Endpoints

### Auth
- `GET /api/auth/google` — Start OAuth flow
- `GET /api/auth/callback/google` — OAuth callback
- `GET /api/auth/me` — Current user
- `POST /api/auth/logout` — Logout

### Books
- `GET /api/books` (alias `/api/v2/books`) — List books (public + user's private)
- `POST /api/books/estimate` — Parse an EPUB via Railway and return a translation cost estimate
- `POST /api/books/upload` — Upload EPUB (auth required, deducts credits; Railway handles the rest via `/upload-and-parse`). Accepts an optional shelf target (`shelfSlotId`, or `shelfRow`/`shelfCol` to create one on the fly) from clicking an empty slot in the 3D closet
- `GET /api/book/:uuid/status` — Parsing/translation progress (polled by the shelf)
- `GET /api/book/:uuid/chapters` — Chapter list
- `GET /api/book/:uuid/chapter/:number` — Chapter content (XPath-mapped paragraphs)
- `GET /api/book/:uuid/content` — Full book content
- `DELETE /api/book/:uuid` — Delete book (owner only)
- `POST /api/book/:uuid/share` / `GET /api/shared/:token/...` — Share links
- `GET /api/shelf-slots` — Physical shelf-slot grid (row/col/label) for the 3D closet's slot-based upload targets

### Reading Progress
- `POST /api/book/:uuid/mark-complete` — Mark book read/unread (`{isCompleted: bool}`)
- `GET /api/book/:uuid/progress` — Get reading progress
- `PUT|POST /api/book/:uuid/progress` — Save reading position (POST used by `sendBeacon` on unload)
- `GET /api/progress` — All of the user's per-book progress in one map

### Credits & Payments
- `GET /api/credits` — Balance + available packages
- `GET /api/credits/transactions` — Purchase/usage history
- `POST /api/stripe/checkout` — Create Stripe checkout session
- `GET /api/stripe/verify-session` — Verify checkout (webhook fallback)
- `POST /api/stripe/webhook` — Stripe webhook

### Cover Preview
- `GET /api/cover-preview/:uuid` — Password-protected cover/spine preview

## Database Schema

Production runs the **v2 schema** (`database/schema_v2.sql` + `database/migrations/`); `database/schema.sql` is the legacy v1 layout.

### Core Tables
- **users** — `id, google_id, email, name, picture, credits, created_at, updated_at`
- **sessions** — `id, user_id, session_token, expires_at`
- **books_v2** — `id, uuid, title, original_title, author, language_pair, styles, book_cover_img_url, book_spine_img_url, user_id, status, display_order, created_at, updated_at`
- **chapters_v2** — `id, book_id, chapter_number, title, original_title, raw_html (original EPUB HTML), text_nodes_json, order_index`
- **translations_v2** — `id, chapter_id, xpath, original_text, original_html, translated_text, order_index` (XPath-mapped onto the chapter's raw HTML)
- **translation_jobs** — `book_uuid, source/target_language, total/completed_chapters, current_chapter, current_item_offset, glossary_json, glossary_extracted, translated_title, status, error_message` (checkpoint + progress state per book)

### User Data
- **user_book_progress** — `id, user_id, book_uuid, is_completed, completed_at, last_read_at, chapter_number, paragraph_xpath, show_original` (UNIQUE user_id + book_uuid)
- **credit_transactions** — `id, user_id, amount, type (purchase/usage), stripe_payment_intent_id, balance_after, created_at`

### Shelf Layout
- **shelf_slots** — `id, shelf_id, row, col, sort_order, label` (UNIQUE shelf_id+row+col, UNIQUE shelf_id+sort_order). Physical coordinates on the 3D closet wall; created on the fly when a user clicks an empty slot to upload, or pre-labeled (e.g. "Gutenberg books") for curated bays
- **book_shelf_slots** — `book_id (PK), slot_id, position` — links a book to the physical slot it was uploaded into
- **book_shelves** — `shelf_id, book_id, position` — dormant/legacy named-shelf grouping (no current app writer; `shelf3d/layout.ts` still reads `shelf_id` off books for stable grouping of anything not yet in a physical slot)

## Environment Variables

### Worker Secrets (`wrangler secret put`)
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
- `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`
- `TRANSLATOR_SERVICE_URL`, `TRANSLATOR_SECRET`

### wrangler.toml vars
- `APP_URL` — e.g. `https://ovid.ink`

### Local .env (CLI scripts)
- `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL`
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_D1_DATABASE_ID`

## Development Rules

- **Branch off latest main** — Always `git fetch origin && git checkout main && git pull` before creating a new branch. Branching off a stale local main produces PRs that conflict with or revert recently merged work.
- **Rebase before opening a PR** — After committing on the feature branch, run `git fetch origin && git rebase origin/main` and resolve conflicts before `git push`. Do this for every PR, even small fixes — main moves fast and yesterday's base is already stale.
- **Branch naming** — `feature/` or `fix/` branches, PR back to main.
- **Never force push** to main. Force-push to your own feature branch (after rebase) is fine and expected.
- **Tests required** — Run `yarn test` before submitting. New features need new tests.
- **CI** — Push to main auto-deploys via GitHub Actions
- **Railway** — Translator service auto-deploys on git push separately
