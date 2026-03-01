/**
 * Ovid Cover Processor Service (Railway)
 *
 * Receives webhook from CF Worker after Gemini generates raw images.
 * Processes spine (green-screen crop + despill + resize) and cover (resize).
 * Uploads final images to R2 and updates D1.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { processSpine, processCover } from './image-processor.js';
import { D1Client } from './d1-client.js';
import { R2Client } from './r2-client.js';

const app = new Hono();

const env = {
  CF_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID!,
  CF_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN!,
  CF_D1_DATABASE_ID: process.env.CLOUDFLARE_D1_DATABASE_ID!,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME || 'ovid',
  R2_PUBLIC_BASE: process.env.R2_PUBLIC_BASE || 'https://assets.ovid.jrd.pub',
  PROCESSOR_SECRET: process.env.PROCESSOR_SECRET!,
};

function getDb() {
  return new D1Client({
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    databaseId: env.CF_D1_DATABASE_ID,
  });
}

function getR2() {
  return new R2Client({
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    bucketName: env.R2_BUCKET_NAME,
    publicBase: env.R2_PUBLIC_BASE,
  });
}

// Health check
app.get('/health', (c) => c.json({ ok: true, timestamp: new Date().toISOString() }));

interface ProcessRequest {
  secret: string;
  bookUuid: string;
  /** URL of the raw cover image on R2 */
  rawCoverUrl: string;
  /** URL of the raw green-screen spine image on R2 */
  rawSpineUrl: string;
  /** Key prefix for final images (e.g. "the_great_gatsby_a1b2c3d4") */
  keyPrefix: string;
}

// Process cover + spine images
app.post('/process', async (c) => {
  const body = await c.req.json<ProcessRequest>();

  if (body.secret !== env.PROCESSOR_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!body.bookUuid || !body.rawCoverUrl || !body.rawSpineUrl || !body.keyPrefix) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  console.log(`[cover-processor] Starting: ${body.bookUuid} (${body.keyPrefix})`);

  // Process in background, return immediately
  processImages(body).catch((err) => {
    console.error(`[cover-processor] Failed for ${body.bookUuid}:`, err);
  });

  return c.json({ ok: true, message: 'Processing started' });
});

async function processImages(req: ProcessRequest) {
  const r2 = getR2();
  const db = getDb();

  // Download raw images
  console.log(`[cover-processor] Downloading raw images...`);
  const [rawCover, rawSpine] = await Promise.all([
    r2.get(req.rawCoverUrl),
    r2.get(req.rawSpineUrl),
  ]);

  // Process
  console.log(`[cover-processor] Processing cover (${rawCover.length} bytes)...`);
  const finalCover = await processCover(rawCover);

  console.log(`[cover-processor] Processing spine (${rawSpine.length} bytes)...`);
  const finalSpine = await processSpine(rawSpine);

  // Upload final images
  const coverKey = `${req.keyPrefix}_cover.png`;
  const spineKey = `${req.keyPrefix}_spine.png`;

  console.log(`[cover-processor] Uploading final images...`);
  const [coverUrl, spineUrl] = await Promise.all([
    r2.put(coverKey, finalCover, 'image/png'),
    r2.put(spineKey, finalSpine, 'image/png'),
  ]);

  // Update D1
  console.log(`[cover-processor] Updating DB for ${req.bookUuid}...`);
  await db.execute(
    `UPDATE books_v2 SET book_cover_img_url = ?, book_spine_img_url = ?, updated_at = datetime('now') WHERE uuid = ?`,
    [coverUrl, spineUrl, req.bookUuid],
  );

  console.log(`[cover-processor] Done: cover=${coverUrl}, spine=${spineUrl}`);
}

const port = parseInt(process.env.PORT || '3000', 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Cover processor running on port ${port}`);
});
