# Translation System

## Overview

Ovid translates books paragraph-by-paragraph using LLMs. Translation is offloaded to a Railway-hosted service to avoid Cloudflare Worker CPU time limits.

## Why Railway?

CF Workers have a 30-second CPU time limit (even with `waitUntil`). Translating a full book takes minutes to hours. The Railway service runs as a long-lived Node.js process with no such limits.

## Flow

```
Worker receives EPUB upload
  → Parses chapters/paragraphs, stores in D1 (translated_text = '')
  → waitUntil: POST {bookUuid, secret} to TRANSLATOR_URL/translate
  → Returns 200 immediately to user

Railway receives webhook
  → Queries D1 for book metadata + untranslated chapters
  → For each chapter (5 concurrent):
      → Fetches paragraphs from D1
      → Skips already-translated (checkpoint resume)
      → Sends to LLM with context prompt
      → Writes translated text back to D1 per paragraph
  → Marks book complete when all chapters done
```

## LLM Configuration

- **Provider**: OpenRouter (`openrouter.ai/api/v1`)
- **Model**: `anthropic/claude-sonnet` (configurable via `OPENAI_MODEL`)
- **Temperature**: 0.3 (consistent, faithful translations)
- **API**: OpenAI-compatible chat completions

## Translation Prompt

The system prompt instructs the model to:
- Translate the given paragraph to the target language
- Preserve the original tone, style, and voice
- Keep proper nouns consistent
- Return only the translation, no commentary
- Handle XML/HTML artifacts in EPUB content

Context from surrounding paragraphs is included for coherence.

## Concurrency & Resume

- **5 concurrent chapter workers** — balances speed vs. API rate limits
- **Checkpoint resume** — if the service crashes or restarts, it checks `translated_text` in D1 and skips already-done paragraphs. No work is lost.
- **Progress tracking** — in-memory `activeJobs` map, queryable via `GET /status/:uuid`

## Supported Language Pairs

Source is typically English. Targets: `zh` (Chinese), `es` (Spanish), `fr` (French), `de` (German), `ja` (Japanese), `ko` (Korean), `ru` (Russian).

The `language_pair` field on books stores this as e.g. `en-zh`.

## Cost

Translation cost depends on book length and model. With gpt-4o-mini, a typical novel (~80k words) costs roughly $3–8. Users pay via the credits system (Stripe).

## Local CLI Translation

The `yarn import-book` CLI can also translate locally using `src/utils/translator.ts`. This uses the same OpenAI-compatible API but runs in-process (no Railway needed). Useful for development and batch imports.

```bash
yarn import-book -- --file="book.epub" --target="zh"
```

Environment: set `OPENAI_API_KEY`, `OPENAI_API_BASE_URL`, `OPENAI_MODEL` in `.env`.
