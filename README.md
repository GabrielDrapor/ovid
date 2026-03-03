# Ovid 📖

**A bilingual reader for the browser.** Import any EPUB, click a paragraph, and it flips between the original and its translation. That's it — no split screens, no popups, no friction.

🔗 **[Try it live → lib.jrd.pub](https://lib.jrd.pub)**

## Features

- **Click-to-toggle** — Tap any paragraph to switch between original and translated text
- **EPUB import** — Upload an EPUB, get it auto-translated in the background
- **Bookshelf UI** — Spines, covers, hover previews — feels like a real shelf
- **Reading progress** — Picks up where you left off, synced to the cloud
- **Infinite scroll** — Chapters load seamlessly as you scroll
- **Multiple languages** — EN↔ZH, ES, FR, DE, JA, KO, RU
- **CJK typography** — Noto Sans CJK SC with tuned line height and spacing
- **Google OAuth** — Login, get your own private library
- **Credits system** — Stripe-powered, pay per book translation

## Architecture

**Cloudflare Worker** serves the React SPA and handles all API routes (auth, books, credits). Book data lives in **Cloudflare D1** (SQLite). Uploaded EPUBs and generated cover/spine images are stored in **Cloudflare R2** (served via `assets.ovid.jrd.pub`).

Translation is offloaded to a **Railway-hosted service** — the Worker fires a webhook on upload, and Railway translates the book chapter-by-chapter (Claude Sonnet via OpenRouter, 5 concurrent workers, with resume support). This sidesteps the Worker's CPU time limits.

```
Browser → CF Worker (API + SPA) → D1 (data) / R2 (assets)
                                 ↘ Railway Translator (webhook) → D1 (writes translations back)
```

## Quick Start

```bash
git clone https://github.com/your-org/ovid && cd ovid
npm install
cp wrangler.toml.example wrangler.toml   # fill in your D1 database ID
npm run db:init                           # create tables
npm run preview                           # http://localhost:8787
```

### Key Commands

| Command | What it does |
|---|---|
| `npm run preview` | Local dev (full stack) |
| `npm run deploy` | Build + deploy to CF Workers |
| `npm test` | Vitest unit tests |
| `npm run test:visual` | Playwright visual tests |
| `yarn import-book -- --file="book.epub" --target="zh"` | Import + translate a book |
| `yarn list-books:local` | List local books |
| `yarn list-books:remote` | List production books |

## Project Structure

```
src/components/     React UI (BookShelf, BilingualReaderV2, ErrorBoundary)
src/worker/         CF Worker backend (auth, books, covers, credits, db)
services/translator/  Railway translation service (Hono + Sharp)
scripts/            CLI tools (import, list, remove, sync, generate-cover)
database/           Schema + migrations + sample data
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and PR guidelines.

## License

MIT
