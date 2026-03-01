/**
 * Ovid Translation Service (Railway)
 * Receives webhook from CF Worker, translates entire books via D1 REST API
 */

import { Hono } from 'hono';
import { D1Client } from './d1-client.js';
import { translateBook, activeJobs } from './translate-worker.js';
import { processSpine, processCover } from './image-processor.js';
import { generatePreview, PREVIEW_HTML } from './cover-preview.js';

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

// --- Cover Preview (debug UI) ---

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

app.get('/preview', (c) => {
  return c.html(PREVIEW_HTML);
});

app.post('/preview', async (c) => {
  const { title, author } = await c.req.json<{ title: string; author: string }>();

  if (!title || !author) {
    return c.json({ error: 'Missing title or author' }, 400);
  }

  if (!GEMINI_API_KEY) {
    return c.json({ error: 'GEMINI_API_KEY not configured' }, 500);
  }

  try {
    const result = await generatePreview(GEMINI_API_KEY, title, author);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// --- Cover Processing ---

const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE || 'https://assets.ovid.jrd.pub';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'ovid';

async function r2Upload(key: string, data: Buffer, contentType: string): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': contentType,
    },
    body: data,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`R2 upload error ${resp.status}: ${text.slice(0, 300)}`);
  }
  return `${R2_PUBLIC_BASE}/${key}`;
}

async function downloadImage(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

interface CoverProcessRequest {
  secret: string;
  bookUuid: string;
  rawCoverUrl: string;
  rawSpineUrl: string;
  keyPrefix: string;
}

app.post('/process-cover', async (c) => {
  const body = await c.req.json<CoverProcessRequest>();

  if (body.secret !== env.TRANSLATOR_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!body.bookUuid || !body.rawCoverUrl || !body.rawSpineUrl || !body.keyPrefix) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  console.log(`[cover] Starting: ${body.bookUuid}`);

  // Process in background
  processCoverImages(body).catch((err) => {
    console.error(`[cover] Failed for ${body.bookUuid}:`, err);
  });

  return c.json({ ok: true, message: 'Processing started' });
});

async function processCoverImages(req: CoverProcessRequest) {
  const db = getDb();

  const [rawCover, rawSpine] = await Promise.all([
    downloadImage(req.rawCoverUrl),
    downloadImage(req.rawSpineUrl),
  ]);

  console.log(`[cover] Processing cover (${rawCover.length} bytes) + spine (${rawSpine.length} bytes)`);

  const [finalCover, finalSpine] = await Promise.all([
    processCover(rawCover),
    processSpine(rawSpine),
  ]);

  const coverKey = `${req.keyPrefix}_cover.png`;
  const spineKey = `${req.keyPrefix}_spine.png`;

  const [coverUrl, spineUrl] = await Promise.all([
    r2Upload(coverKey, finalCover, 'image/png'),
    r2Upload(spineKey, finalSpine, 'image/png'),
  ]);

  await db.execute(
    'UPDATE books_v2 SET book_cover_img_url = ?, book_spine_img_url = ?, updated_at = datetime(\'now\') WHERE uuid = ?',
    [coverUrl, spineUrl, req.bookUuid],
  );

  console.log(`[cover] Done: ${req.bookUuid} → ${coverUrl}, ${spineUrl}`);
}

const port = parseInt(process.env.PORT || '3000');

import { serve } from '@hono/node-server';

serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 Ovid Translator Service running on port ${port}`);
});
