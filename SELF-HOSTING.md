# Self-hosting Ovid

Ovid runs on Cloudflare (that's what powers [ovid.ink](https://ovid.ink)), but
it doesn't have to. This guide gets you a private instance on your own machine
or server with Docker — SQLite on disk instead of D1, a local folder instead
of R2, everything else identical.

## Quick start

```bash
git clone https://github.com/GabrielDrapor/ovid
cd ovid
cp .env.example .env      # set OPENAI_API_KEY — the only required value
docker compose up -d
```

Open <http://localhost:8080>. Sign in with an email code: enter your address,
then read the 6-digit code from the log —

```bash
docker compose logs ovid | grep "login code"
```

— or set `RESEND_API_KEY` in `.env` to have codes emailed for real.

## What you need

| | |
|---|---|
| **Required** | Docker, and an API key for any OpenAI-compatible endpoint (OpenAI, DeepSeek, a local Ollama, …) — this is what translates books |
| **Optional** | `RESEND_API_KEY` to email sign-in codes instead of logging them; Google OAuth credentials if you want the Google button to work |
| **Not needed** | A Cloudflare account, a domain, or any paid service beyond your LLM provider |

## Where your data lives

Everything is in one Docker volume (`ovid-data`), mounted at `/data`:

```
/data/ovid.db      SQLite database — books, chapters, translations, users
/data/assets/      uploaded EPUBs, generated covers and spines, book images
```

Back up by archiving that volume; migrate by copying it to another host.

```bash
docker run --rm -v ovid-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/ovid-backup.tar.gz -C /data .
```

## Configuration

All settings are environment variables in `.env` (see `.env.example`):

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** Any OpenAI-compatible key |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` | Point at DeepSeek, Ollama, etc. |
| `OPENAI_MODEL` | `gpt-4o-mini` | |
| `OVID_PORT` | `8080` | Host port |
| `APP_URL` | `http://localhost:8080` | Public URL, used in OAuth redirects and share links |
| `RESEND_API_KEY` | — | Unset: sign-in codes go to the container log |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET` | — | Optional; email codes work without it |
| `TRANSLATOR_SECRET` | `selfhost-dev-secret` | Shared secret between the two containers — change it if the ports are exposed |

## How it differs from ovid.ink

| | Hosted | Self-hosted |
|---|---|---|
| Database | Cloudflare D1 | SQLite file (`node:sqlite`, no native modules) |
| Object storage | R2 | Local filesystem |
| Static assets | Workers Assets | Served by the same Node process |
| Translation backend | Railway service or Cloudflare Workflows | Translator container |
| Credits/Stripe | Enabled | Inactive — credit checks still run, so give yourself a balance if a book won't import (see below) |

Handler code is identical on both: they talk to the platform interfaces in
`src/platform/`, and Cloudflare's bindings satisfy those directly while
`server/` implements them over SQLite and the filesystem.

### Granting yourself credits

Books cost credits to translate, and self-hosted instances have no payment
flow. New accounts get a starting balance; to top up:

```bash
docker compose exec ovid node -e "
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('/data/ovid.db');
db.prepare('UPDATE users SET credits = 1000000').run();
console.log('done');
"
```

Importing without translation ("original only") costs nothing.

## Updating

```bash
git pull
docker compose build
docker compose up -d
```

Schema migrations run automatically at startup; your data volume is untouched.

## Troubleshooting

**A book stays "processing" forever** — check the translator: `docker compose
logs translator`. Usually a bad `OPENAI_API_KEY` or an endpoint that rejects
the model name.

**"Estimation failed" on upload** — the app can't reach the translator
container. `docker compose ps` should show both services healthy.

**Sign-in code never arrives** — without `RESEND_API_KEY` codes are only
printed: `docker compose logs ovid | grep "login code"`.

**Port already in use** — set `OVID_PORT` in `.env`.

## Running without Docker

```bash
yarn install
yarn build          # React SPA -> build/
yarn build:server   # server bundle -> dist-server/
OPENAI_API_KEY=sk-... yarn start:selfhost
```

Requires Node 22+ (for the built-in `node:sqlite`). The translator service is
a separate Node app under `services/translator/`.
