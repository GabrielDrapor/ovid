# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands & Workflows

### Development & Deployment
- **Start dev server (React only)**: `npm start`
- **Start worker preview (full stack)**: `npm run preview` ← use this for complete local testing
- **Build for production**: `npm run build`
- **Deploy to Cloudflare**: `npm run deploy`
- **Run tests**: `npm test`
- **Eject from CRA**: `npm run eject` (⚠️ irreversible)

### Book Management (TypeScript scripts)
- **Import**: `yarn import-book -- --file="book.epub" --target="zh" --provider="openai"`
- **List local**: `yarn list-books:local`
- **List remote**: `yarn list-books:remote`
- **Remove local**: `yarn remove-book:local -- --uuid="book-uuid"`
- **Remove remote**: `yarn remove-book:remote -- --uuid="book-uuid"`
- **Sync to D1**: `yarn sync-remote-book -- --uuid="book-uuid"`

### Database Management
- **Run SQL on local DB**: `npm run db:local -- "SELECT * FROM books;"`
- **Run SQL on remote D1**: `npm run db:remote -- "SELECT * FROM books;"`
- **Execute SQL file locally**: `npm run db:local -- --file database/schema.sql`
- **Execute SQL file remotely**: `npm run db:remote -- --file database/schema.sql`

## Architecture

This is a **TypeScript-first** React application built with Create React App and Cloudflare Workers, using D1 SQLite for persistence. **100% TypeScript** across frontend, backend, and CLI scripts for type safety and consistency.

### Core Modules

- **Entry point**: `src/index.tsx` - React initialization with error boundary
- **Main app**: `src/App.tsx` - Book shelf, authentication state, theme management
- **Book shelf**: `src/components/BookShelf.tsx` - Two-row layout with public/user books, hover preview, direct entry
- **Reader**: `src/components/BilingualReader.tsx` - XPath-based bilingual text with paragraph-level toggle, scroll navigation (auto-load chapters), reading progress tracking
- **Worker backend**: `src/worker/index.ts` - Full API server with auth, books, chapters, uploads, payments
- **Translation engine**: `src/utils/translator.ts` - Unified interface for OpenAI-compatible APIs with sequential processing and context preservation
- **CLI scripts**: `scripts/*.ts` - TypeScript book import, listing, removal, sync with full schema management
- **Database**: `D1 SQLite` - users, sessions, books, chapters, content_items, credit_transactions tables
- **Styling**: `src/App.css` + component CSS with CJK typography (Noto Sans CJK SC)

## Reading Experience

The bilingual reader provides an optimized reading workflow:

### Navigation & Performance
- **Single-chapter mode**: Only active chapter in memory for smooth scrolling
- **Automatic scroll-based loading**:
  - Scroll to bottom → loads next chapter seamlessly
  - Scroll to top → loads previous chapter
  - No manual navigation needed for continuous reading
- **Manual chapter menu**: Jump to any chapter via dropdown selector
- **Reading progress**: Automatic tracking and restoration of last reading position

### Text Interaction
- **Paragraph-level toggle**: Click any paragraph to switch original ↔ translated
- **XPath-based mapping**: Precise alignment between original and translated text
- **Language optimization**: 
  - CJK typography with Noto Sans CJK SC for Chinese text
  - Optimized line height, letter spacing, paragraph spacing for comfort

### Translation Quality
- **Sequential translation with context**: Preserves character voice and narrative consistency
- **Proper noun handling**: Maintains names, places, and technical terms accurately
- **XML stripping**: Clean output without translation artifacts

## API Endpoints

### Authentication (OAuth 2.0)
- `GET /api/auth/google` - Initiate Google OAuth flow
- `GET /api/auth/callback/google` - OAuth callback handler with session creation
- `GET /api/auth/me` - Get current authenticated user profile
- `POST /api/auth/logout` - Terminate user session

### Books & Reading
- `GET /api/books` - List all books (public + user's private books)
- `POST /api/books/upload` - Upload EPUB/TXT file with async translation
  - Requires auth + sufficient credits
  - Returns immediately, translation happens in background
  - Emits server-sent events for progress tracking
- `GET /api/book/:uuid/content` - Get full book content (all chapters)
- `GET /api/book/:uuid/chapters` - Get list of all chapters with metadata
- `GET /api/book/:uuid/chapter/:number` - Load specific chapter content (XPath-mapped paragraphs)
- `DELETE /api/book/:uuid` - Delete book (owner only)

### Credits & Payments (Stripe Integration)
- `GET /api/credits` - Get user's credit balance and available purchase packages
- `GET /api/credits/transactions` - Get user's credit usage and purchase history
- `POST /api/stripe/checkout` - Create Stripe checkout session for credit purchase
- `GET /api/stripe/verify-session` - Verify checkout and apply credits (webhook fallback)
- `POST /api/stripe/webhook` - Stripe webhook endpoint (payment events)

## Database Schema

### User Management
- **users** - Google OAuth accounts with credit balance
  - Fields: google_id, email, name, picture, credits, created_at, updated_at
- **sessions** - Authentication sessions with expiration
  - Fields: user_id, session_token, expires_at

### Content Storage
- **books** - Book metadata with ownership and styling
  - Fields: title, author, language_pair, uuid, user_id, is_public, styles, created_at, updated_at
- **chapters** - Chapter structure with ordering
  - Fields: book_id, chapter_number, chinese_title, english_title, order_index
- **content_items** - Paragraph-level bilingual content with XPath mapping
  - Fields: chapter_id, paragraph_number, original_text, translated_text, xpath, order_index

### Payments & Credits
- **credit_transactions** - Credit purchase and usage history
  - Fields: user_id, amount, type (purchase/usage), stripe_payment_intent_id, balance_after, created_at

## Environment Variables

### Cloudflare Worker (wrangler secrets)
- `GOOGLE_OAUTH_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_OAUTH_CLIENT_SECRET` - Google OAuth client secret
- `APP_URL` - Application URL (e.g., `https://lib.jrd.pub`)
- `OPENAI_API_KEY` - API key for web upload translation
- `OPENAI_API_BASE_URL` - API endpoint (default: `https://api.openai.com/v1`)
- `OPENAI_MODEL` - Translation model (default: `gpt-4o-mini`)
- `STRIPE_SECRET_KEY` - Stripe secret key for payments
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret
- `STRIPE_PUBLISHABLE_KEY` - Stripe publishable key (can be in wrangler.toml vars)

### Local CLI scripts (.env)
- `OPENAI_API_KEY` - API key for translation (OpenAI or compatible provider)
- `OPENAI_API_BASE_URL` - API endpoint (default: `https://api.openai.com/v1`)
- `OPENAI_MODEL` - Translation model (default: `gpt-4o-mini`)
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID (for remote operations)
- `CLOUDFLARE_API_TOKEN` - Cloudflare API token (for remote database access)
- `CLOUDFLARE_D1_DATABASE_ID` - D1 database ID (can be read from `wrangler.toml`)