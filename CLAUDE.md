# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- **Start development server**: `npm start`
- **Start local worker preview**: `npm run preview`
- **Build for production**: `npm run build`
- **Run tests**: `npm test`
- **Deploy to Cloudflare Workers**: `npm run deploy`
- **Eject from create-react-app**: `npm run eject` (irreversible)

### Book Management
- **Import book**: `yarn import-book -- --file="book.epub" --target="zh"`
- **List local books**: `yarn list-books:local`
- **List remote books**: `yarn list-books:remote`
- **Remove local book**: `yarn remove-book:local -- --uuid="book-uuid"`
- **Remove remote book**: `yarn remove-book:remote -- --uuid="book-uuid"`
- **Sync to remote**: `yarn sync-remote-book -- --uuid="book-uuid"`

### Database
- **Execute local SQL**: `npm run db:local -- "SELECT * FROM books;"`
- **Execute remote SQL**: `npm run db:remote -- "SELECT * FROM books;"`
- **Initialize schema**: `npm run db:init`
- **Seed sample data**: `npm run db:seed`

## Architecture

This is a React TypeScript application built with Create React App, deployed as a Cloudflare Worker with D1 database integration. **All scripts are TypeScript** for type safety and consistency. The codebase is structured as:

- **Entry point**: `src/index.tsx` - React app initialization
- **Main component**: `src/App.tsx` - Loads chapters from API and manages reading state
- **Core feature**: `src/components/BilingualReader.tsx` - Interactive bilingual text reader with scroll navigation
- **Worker backend**: `src/worker/index.ts` - Cloudflare Worker with API endpoints and asset serving
- **Translation**: `src/utils/translator.ts` - Unified translation module supporting OpenAI-compatible APIs
- **Scripts**: `scripts/*.ts` - TypeScript scripts for book import, listing, removal, and sync
- **Database**: D1 SQLite database with books, chapters, and content_items tables
- **Styling**: CSS modules in `src/App.css` and `src/components/BilingualReader.css`

## Reading Experience

The bilingual reader features:
- **Single-chapter mode**: Only one chapter loads at a time for performance
- **Scroll navigation**: 
  - Scroll to bottom → automatically loads next chapter
  - Scroll to top → automatically loads previous chapter
- **Manual navigation**: Chapter menu for direct chapter selection
- **Language toggle**: Click any paragraph to switch between original/translated text
- **Reading controls**: Adjustable line height, letter spacing, and paragraph spacing

## API Endpoints

### Authentication
- `GET /api/auth/google` - Start Google OAuth flow
- `GET /api/auth/callback/google` - OAuth callback handler
- `GET /api/auth/me` - Get current user info
- `POST /api/auth/logout` - Logout user

### Books
- `GET /api/books` - List all books (public + user's private books)
- `POST /api/books/upload` - Upload EPUB file (requires auth, checks credits)
- `GET /api/book/:uuid/content` - Get full book content
- `GET /api/book/:uuid/chapters` - Get list of all chapters
- `GET /api/book/:uuid/chapter/:number` - Load specific chapter content

### Credits & Payments
- `GET /api/credits` - Get user's credit balance and available packages
- `GET /api/credits/transactions` - Get user's credit transaction history
- `POST /api/stripe/checkout` - Create Stripe checkout session for credit purchase
- `GET /api/stripe/verify-session` - Verify checkout session and add credits (fallback for webhook)
- `POST /api/stripe/webhook` - Stripe webhook handler (payment confirmation)

## Database Schema

- **users**: User accounts via Google OAuth (google_id, email, name, picture, credits)
- **sessions**: Auth sessions (user_id, session_token, expires_at)
- **books**: Book metadata (title, author, styles, uuid, user_id, created_at, updated_at)
- **chapters**: Chapter information (chapter_number, titles, order_index)
- **content_items**: Individual paragraphs with bilingual text (original_text, translated_text)
- **credit_transactions**: Credit purchase/usage history (amount, type, stripe_payment_intent_id, balance_after)

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