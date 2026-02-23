/**
 * Ovid Translation Service (Railway)
 * Receives webhook from CF Worker, translates entire books via D1 REST API
 */

import { Hono } from 'hono';
import { D1Client } from './d1-client.js';
import { translateBook, activeJobs } from './translate-worker.js';

const app = new Hono();

// Environment
const env = {
  CF_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID!,
  CF_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN!,
  CF_D1_DATABASE_ID: process.env.CLOUDFLARE_D1_DATABASE_ID!,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  OPENAI_API_BASE_URL: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  TRANSLATOR_SECRET: process.env.TRANSLATOR_SECRET!,
};

function getDb() {
  return new D1Client({
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    databaseId: env.CF_D1_DATABASE_ID,
  });
}

function getLlmConfig() {
  return {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_API_BASE_URL,
    model: env.OPENAI_MODEL,
  };
}

// Health check
app.get('/health', (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));

// Trigger translation
app.post('/translate', async (c) => {
  const body = await c.req.json<{ bookUuid: string; secret: string }>();

  if (body.secret !== env.TRANSLATOR_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!body.bookUuid) {
    return c.json({ error: 'Missing bookUuid' }, 400);
  }

  // Check if already translating
  if (activeJobs.has(body.bookUuid)) {
    return c.json({ status: 'already_running', progress: activeJobs.get(body.bookUuid) });
  }

  // Fire and forget — translate in background
  const db = getDb();
  const llmConfig = getLlmConfig();

  translateBook(db, llmConfig, body.bookUuid).catch((err) => {
    console.error(`Background translation failed for ${body.bookUuid}:`, err);
  });

  return c.json({ status: 'started', bookUuid: body.bookUuid });
});

// Query translation progress
app.get('/status/:uuid', async (c) => {
  const uuid = c.req.param('uuid');

  // Check in-memory active jobs first
  const active = activeJobs.get(uuid);
  if (active) {
    return c.json({ status: 'translating', progress: active });
  }

  // Fall back to DB
  try {
    const db = getDb();
    const job = await db.first<{ status: string; completed_chapters: number; total_chapters: number; error_message: string | null }>(
      'SELECT status, completed_chapters, total_chapters, error_message FROM translation_jobs WHERE book_uuid = ? LIMIT 1',
      [uuid]
    );

    if (!job) {
      return c.json({ status: 'not_found' }, 404);
    }

    return c.json({
      status: job.status,
      progress: {
        chaptersCompleted: job.completed_chapters,
        chaptersTotal: job.total_chapters,
      },
      error: job.error_message,
    });
  } catch (err) {
    return c.json({ status: 'unknown', error: (err as Error).message }, 500);
  }
});

const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 Ovid Translator Service starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
