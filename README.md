<p align="center">
  <img src="logo.png" alt="Ovid" width="180"/>
</p>

<h1 align="center">Ovid</h1>

<p align="center"><strong>Two languages, one tap.</strong></p>

<div align="center">
  <img width="800" height="476" alt="image" src="https://github.com/user-attachments/assets/b4263157-c44b-4b7e-8692-69f19c457e57" />
</div>

<div align="center">
  <img width="800" alt="2026-03-1923 59 55-ezgif com-video-to-gif-converter" src="https://github.com/user-attachments/assets/2b6dc7ee-7082-4759-ae6a-fbd462d3bc85" />
</div>



🔗 **[Try it live → ovid.ink](https://ovid.ink)**

English | [简体中文](README.zh-CN.md)

## Features

- **Click-to-toggle** — Tap any paragraph to switch between original and translated text instantly
- **EPUB import** — Upload an EPUB, get it auto-translated in the background
- **Bookshelf UI** — Book spines, AI-generated covers, hover previews — feels like a real shelf
- **Reading progress** — Picks up where you left off, synced to the cloud
- **Infinite scroll** — Chapters load seamlessly as you scroll up/down
- **CJK typography** — LXGW Neo ZhiSong Screen with tuned line height and spacing
- **Google OAuth** — Login, get your own private library
- **Credits & payments** — Stripe-powered, pay per book translation

## How It Works

```
Browser (React SPA)
    ↕
Cloudflare Worker — API, auth, static files
    ↕                ↘
Cloudflare D1         Cloudflare R2
(books, chapters,     (covers, spines,
 paragraphs, users)    in-book images)
                     ↘
               Railway Translator
               (webhook-triggered, LLM translation,
                5 concurrent chapters, checkpoint resume)
```

**Upload flow:** You upload an EPUB → Worker parses it, stores chapters in D1 → fires a webhook to Railway → Railway translates chapter-by-chapter (default: gpt-4o-mini) and writes back to D1. Book appears on your shelf when done.

**Reading flow:** Click a paragraph → it toggles between original and translated text. XPath-based mapping keeps alignment precise at the paragraph level.

## Quick Start

```bash
git clone https://github.com/GabrielDrapor/ovid.git && cd ovid
yarn install
cp wrangler.toml.example wrangler.toml   # fill in your D1 database ID
yarn db:init                           # create tables
yarn preview                           # http://localhost:8787
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and PR process.

## Key Commands

| Command | Description |
|---|---|
| `yarn preview` | Full-stack local dev (Worker + React on :8787) |
| `yarn deploy` | Build + deploy to Cloudflare Workers |
| `yarn test` | Unit tests (Vitest) |
| `yarn test:visual` | Visual regression (Playwright) |
| `yarn import-book -- --file="book.epub" --target="zh"` | Import & translate a book via CLI |
| `yarn list-books:local` / `remote` | List books in local/production DB |
| `yarn remove-book:local` / `remote -- --uuid="..."` | Remove a book |

## Project Layout

```
src/
  components/        React UI — BookShelf, BilingualReaderV2, ErrorBoundary
  worker/            CF Worker — auth, book-handlers, cover-generator, credits, db
  utils/             Shared utilities (translator module)
services/
  translator/        Railway translation service (Hono + Sharp + D1 client)
scripts/             CLI tools — import, list, remove, sync, generate-cover
database/            Schema, migrations, sample data
docs/                Architecture & translation system docs
```

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — Developer guide (commands, architecture, API endpoints, DB schema)
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — System architecture overview
- **[docs/TRANSLATION.md](docs/TRANSLATION.md)** — How the translation pipeline works
- **[AGENTS.md](AGENTS.md)** — Deep technical reference (EPUB parsing lessons, implementation details)

## License

MIT — see [LICENSE](LICENSE)
