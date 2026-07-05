# Translation System

## Overview

Ovid translates books paragraph-by-paragraph using LLMs. Translation is offloaded to a Railway-hosted service to avoid Cloudflare Worker CPU time limits.

## Why Railway?

CF Workers have a 30-second CPU time limit (even with `waitUntil`). Translating a full book takes minutes to hours. The Railway service runs as a long-lived Node.js process with no such limits.

## Flow

```
Worker receives EPUB upload
  → Stages the file in R2, inserts a placeholder book row
  → waitUntil: POST {bookUuid, fileKey, secret} to TRANSLATOR_SERVICE_URL/upload-and-parse
  → Returns 200 immediately to user

Railway receives webhook
  → Fetches the staged file from R2, parses chapters/paragraphs into D1
  → Extracts glossary, composes cover/spine
  → For each chapter (5 concurrent):
      → Fetches paragraphs from D1
      → Skips already-translated (checkpoint resume)
      → Sends to LLM with context prompt
      → Writes translated text back to D1 per paragraph
  → Marks book complete when all chapters done
```

## LLM Configuration

- **API**: Any OpenAI-compatible chat-completions endpoint (`OPENAI_API_BASE_URL`)
- **Model**: `OPENAI_MODEL`, default `gpt-4o-mini`
- **Temperature**: 0.3 (consistent, faithful translations)

`scripts/eval-translation.mjs` benchmarks candidate models on the exact
production pipeline (LLM-judge scoring across sample chapters) — use it before
switching `OPENAI_MODEL`.

## Translation Prompt

The system prompt instructs the model to:
- Translate the given paragraph to the target language
- Preserve the original tone, style, and voice
- Keep proper nouns consistent
- Return only the translation, no commentary
- Handle XML/HTML artifacts in EPUB content

Context from surrounding paragraphs is included for coherence.

## Glossary

Before translating, the service samples the book text and extracts a
proper-noun glossary (names, places) with the LLM; the glossary is stored on
the translation job (`translation_jobs.glossary_json`) and injected into every
chapter's prompt so names stay consistent across concurrently translated
chapters. Extraction failures are surfaced in the job status rather than
silently skipped.

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
