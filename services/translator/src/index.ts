/**
 * Ovid Translation Service (Railway)
 * Receives webhook from CF Worker, translates entire books via D1 REST API
 */

import { Hono } from 'hono';
import { D1Client } from './d1-client.js';
import { translateBook, activeJobs } from './translate-worker.js';
import { processSpine, processCover } from './image-processor.js';
import { generatePreview, PREVIEW_HTML, LOGIN_HTML } from './cover-preview.js';
import { parseBook, type BookDataV2 } from './book-parser.js';
import { calculateBookCredits, TOKENS_PER_CREDIT } from './token-counter.js';

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

// ---- R2 helpers ----

const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE || 'https://assets.ovid.jrd.pub';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'ovid';

async function r2Download(key: string): Promise<Buffer> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`R2 download error ${resp.status}: ${text.slice(0, 300)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function r2UploadBuffer(key: string, data: Buffer | Uint8Array, contentType: string): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': contentType,
    },
    body: new Blob([data], { type: contentType }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`R2 upload error ${resp.status}: ${text.slice(0, 300)}`);
  }
  return `${R2_PUBLIC_BASE}/${key}`;
}

async function r2Delete(key: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects/${encodeURIComponent(key)}`;
  await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  }).catch(() => { /* best effort */ });
}

// ---- Image rewriting helper ----

function buildImgRewriteMap(bookUuid: string, images: BookDataV2['images']): Map<string, string> {
  const imgRewriteMap = new Map<string, string>();
  if (!images || images.length === 0) return imgRewriteMap;

  for (const img of images) {
    const publicUrl = `${R2_PUBLIC_BASE}/books/${bookUuid}/images/${img.filename}`;
    imgRewriteMap.set(img.filename, publicUrl);
    const parts = img.zipPath.split('/');
    for (let i = 0; i < parts.length; i++) {
      imgRewriteMap.set(parts.slice(i).join('/'), publicUrl);
      imgRewriteMap.set('../' + parts.slice(i).join('/'), publicUrl);
    }
  }
  return imgRewriteMap;
}

function rewriteImgSrc(html: string, imgRewriteMap: Map<string, string>): string {
  if (imgRewriteMap.size === 0) return html;
  return html.replace(/<img([^>]*)\ssrc="([^"]*)"([^>]*)\/?\s*>/gi, (match, before, src, after) => {
    let newSrc = imgRewriteMap.get(src);
    if (!newSrc) {
      const cleaned = src.replace(/^(\.\.\/)+/, '');
      newSrc = imgRewriteMap.get(cleaned);
    }
    if (!newSrc) {
      const fname = src.split('/').pop() || src;
      newSrc = imgRewriteMap.get(fname);
    }
    if (newSrc) return `<img${before} src="${newSrc}"${after}/>`;
    return match;
  });
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

// ---- Upload & Parse (moved from CF Worker to avoid CPU limits) ----

interface UploadAndParseRequest {
  bookUuid: string;
  fileKey: string;
  fileExtension: string;
  sourceLanguage: string;
  targetLanguage: string;
  userId: number;
  secret: string;
}

app.post('/upload-and-parse', async (c) => {
  const body = await c.req.json<UploadAndParseRequest>();

  if (body.secret !== env.TRANSLATOR_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!body.bookUuid || !body.fileKey) {
    return c.json({ error: 'Missing bookUuid or fileKey' }, 400);
  }

  // Return immediately, process in background
  processUpload(body).catch((err) => {
    console.error(`[upload] Failed for ${body.bookUuid}:`, err);
  });

  return c.json({ status: 'started', bookUuid: body.bookUuid });
});

async function processUpload(req: UploadAndParseRequest): Promise<void> {
  const db = getDb();
  const { bookUuid, fileKey, fileExtension, sourceLanguage, targetLanguage, userId } = req;

  console.log(`[upload] Starting parse for ${bookUuid} (${fileExtension})`);

  let creditsDeducted = 0; // Track for refund on failure

  try {
    // 1. Download raw file from R2
    const fileBuffer = await r2Download(fileKey);
    console.log(`[upload] Downloaded ${fileBuffer.length} bytes from R2`);

    // 2. Parse book (CPU-intensive — that's why we do it here, not in CF Worker)
    const bookData = await parseBook(fileBuffer, fileExtension);
    console.log(`[upload] Parsed: "${bookData.title}" by ${bookData.author}, ${bookData.chapters.length} chapters`);

    // 3. Calculate credits and check balance
    const allTexts: string[] = [];
    for (const chapter of bookData.chapters) {
      for (const node of chapter.textNodes) {
        allTexts.push(node.text);
      }
    }
    const requiredCredits = calculateBookCredits(allTexts, targetLanguage);

    // Check user credits
    const userRow = await db.first<{ credits: number }>(
      'SELECT credits FROM users WHERE id = ?',
      [userId]
    );
    const userCredits = userRow?.credits ?? 0;

    if (userCredits < requiredCredits) {
      console.error(`[upload] Insufficient credits for ${bookUuid}: need ${requiredCredits}, have ${userCredits}`);
      // Clean up R2 file
      await r2Delete(fileKey);
      return;
    }

    // Deduct credits
    await db.run(
      'UPDATE users SET credits = credits - ? WHERE id = ?',
      [requiredCredits, userId]
    );
    creditsDeducted = requiredCredits;
    await db.run(
      `INSERT INTO credit_transactions (user_id, amount, type, description, book_uuid, balance_after)
       VALUES (?, ?, 'deduction', ?, ?, (SELECT credits FROM users WHERE id = ?))`,
      [userId, -requiredCredits, `Translation: ${bookData.title || 'Book'}`, bookUuid, userId]
    );

    // 4. Upload images to R2
    const imgRewriteMap = buildImgRewriteMap(bookUuid, bookData.images);
    if (bookData.images && bookData.images.length > 0) {
      for (const img of bookData.images) {
        const r2Key = `books/${bookUuid}/images/${img.filename}`;
        try {
          await r2UploadBuffer(r2Key, img.data, img.mediaType);
        } catch (e) {
          console.warn(`[upload] Failed to upload image ${img.filename}:`, e);
        }
      }
      console.log(`[upload] Uploaded ${bookData.images.length} images to R2`);
    }

    // 5. Insert book shell into D1
    const maxOrderRow = await db.first<{ max_order: number }>(
      'SELECT COALESCE(MAX(display_order), 0) as max_order FROM books_v2'
    );
    const nextOrder = ((maxOrderRow?.max_order) || 0) + 1;

    await db.run(
      `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, user_id, status, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
      [bookUuid, bookData.title, bookData.title, bookData.author,
       `${sourceLanguage}-${targetLanguage}`, bookData.styles || '', userId, nextOrder]
    );

    const bookRow = await db.first<{ id: number }>('SELECT id FROM books_v2 WHERE uuid = ?', [bookUuid]);
    if (!bookRow) throw new Error('Failed to create book');
    const bookId = bookRow.id;

    // Insert chapters (batched by raw_html storage decision)
    const chapterRowsWithHtml: unknown[][] = [];
    const chapterRowsNoHtml: unknown[][] = [];
    for (const chapter of bookData.chapters) {
      const rawHtml = rewriteImgSrc(chapter.rawHtml, imgRewriteMap);
      const rawHtmlSize = new TextEncoder().encode(rawHtml).length;

      if (rawHtmlSize < 50000) {
        chapterRowsWithHtml.push([bookId, chapter.number, chapter.title, chapter.originalTitle, rawHtml, chapter.number]);
      } else {
        chapterRowsNoHtml.push([bookId, chapter.number, chapter.title, chapter.originalTitle, chapter.number]);
      }
    }
    if (chapterRowsWithHtml.length > 0) {
      await db.batchInsert(
        'chapters_v2',
        ['book_id', 'chapter_number', 'title', 'original_title', 'raw_html', 'order_index'],
        chapterRowsWithHtml,
        'ABORT',
        3 // small batches since raw_html can be up to ~50KB each
      );
    }
    if (chapterRowsNoHtml.length > 0) {
      await db.batchInsert(
        'chapters_v2',
        ['book_id', 'chapter_number', 'title', 'original_title', 'order_index'],
        chapterRowsNoHtml,
        'ABORT',
        10
      );
    }

    // Store text nodes per chapter (batched)
    for (const chapter of bookData.chapters) {
      await db.run(
        'UPDATE chapters_v2 SET text_nodes_json = ? WHERE book_id = ? AND chapter_number = ?',
        [JSON.stringify(chapter.textNodes), bookId, chapter.number]
      );
    }

    // 6. Create translation job
    await db.run(
      `INSERT INTO translation_jobs (book_id, book_uuid, source_language, target_language, total_chapters, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [bookId, bookUuid, sourceLanguage, targetLanguage, bookData.chapters.length]
    );

    console.log(`[upload] Book shell inserted, starting translation for ${bookUuid}`);

    // 7. Start translation immediately
    const llmConfig = getLlmConfig();
    translateBook(db, llmConfig, bookUuid).catch((err) => {
      console.error(`[upload] Translation failed for ${bookUuid}:`, err);
    });

    // 8. Generate cover images (if Gemini key available)
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
    if (GEMINI_API_KEY) {
      generateCoversForBook(GEMINI_API_KEY, bookData.title, bookData.author, bookUuid).catch((err) => {
        console.warn(`[upload] Cover generation failed for ${bookUuid}:`, err);
      });
    }

    // 9. Clean up raw upload from R2
    await r2Delete(fileKey);
    console.log(`[upload] Cleanup done for ${bookUuid}`);

  } catch (err) {
    console.error(`[upload] Error processing ${bookUuid}:`, err);
    // Try to mark book as error and refund credits
    try {
      const db2 = getDb();
      await db2.run("UPDATE books_v2 SET status = 'error' WHERE uuid = ?", [bookUuid]);

      // Refund credits if they were deducted before the failure
      if (creditsDeducted > 0) {
        await db2.run(
          'UPDATE users SET credits = credits + ? WHERE id = ?',
          [creditsDeducted, userId]
        );
        await db2.run(
          `INSERT INTO credit_transactions (user_id, amount, type, description, reference_id)
           VALUES (?, ?, 'refund', ?, ?)`,
          [userId, creditsDeducted, `Refund: upload failed for ${bookUuid}`, bookUuid]
        );
        console.log(`[upload] Refunded ${creditsDeducted} credits to user ${userId} for failed upload ${bookUuid}`);
      }
    } catch (refundErr) {
      console.error(`[upload] Failed to refund credits for ${bookUuid}:`, refundErr);
    }
  }
}

async function generateCoversForBook(
  geminiApiKey: string,
  title: string,
  author: string,
  bookUuid: string,
): Promise<void> {
  // Use the Gemini API to generate cover + spine, then process and upload
  // This mirrors cover-generator.ts logic but runs in Node.js
  const GEMINI_MODEL = 'gemini-2.5-flash-image';
  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;

  const coverPrompt = `Create a beautiful book cover for "${title}" by ${author}. The cover should be artistic and suitable for a literary work. Include the title and author name on the cover. Output only the image.`;

  try {
    const resp = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: coverPrompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          imageDimensions: { width: 600, height: 900 },
        },
      }),
    });

    if (!resp.ok) {
      console.warn(`[cover] Gemini API error: ${resp.status}`);
      return;
    }

    const json = await resp.json() as any;
    const parts = json.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
    if (!imgPart) {
      console.warn('[cover] No image in Gemini response');
      return;
    }

    const coverData = Buffer.from(imgPart.inlineData.data, 'base64');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const uid = crypto.randomUUID().slice(0, 8);
    const coverKey = `${slug}_${uid}_cover.png`;

    const coverUrl = await r2UploadBuffer(coverKey, coverData, 'image/png');

    const db = getDb();
    await db.run(
      "UPDATE books_v2 SET book_cover_img_url = ?, updated_at = datetime('now') WHERE uuid = ?",
      [coverUrl, bookUuid]
    );
    console.log(`[cover] Cover uploaded for ${bookUuid}: ${coverUrl}`);
  } catch (err) {
    console.warn(`[cover] Error:`, err);
  }
}

// ---- Estimate (parse file from R2, return credit estimate) ----

interface EstimateRequest {
  fileKey: string;
  fileExtension: string;
  targetLanguage: string;
  userId: number;
  secret: string;
}

app.post('/estimate', async (c) => {
  const body = await c.req.json<EstimateRequest>();

  if (body.secret !== env.TRANSLATOR_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!body.fileKey || !body.fileExtension) {
    return c.json({ error: 'Missing fileKey or fileExtension' }, 400);
  }

  try {
    // Download and parse
    const fileBuffer = await r2Download(body.fileKey);
    const bookData = await parseBook(fileBuffer, body.fileExtension);

    const allTexts: string[] = [];
    let chapterCount = 0;
    for (const chapter of bookData.chapters) {
      chapterCount++;
      for (const node of chapter.textNodes) {
        allTexts.push(node.text);
      }
    }

    const requiredCredits = calculateBookCredits(allTexts, body.targetLanguage);
    const totalCharacters = allTexts.reduce((sum, text) => sum + text.length, 0);

    // Get user credits
    const db = getDb();
    const userRow = await db.first<{ credits: number }>(
      'SELECT credits FROM users WHERE id = ?',
      [body.userId]
    );
    const userCredits = userRow?.credits ?? 0;

    // Clean up temp file
    await r2Delete(body.fileKey);

    return c.json({
      title: bookData.title || 'Unknown',
      author: bookData.author || 'Unknown',
      chapters: chapterCount,
      characters: totalCharacters,
      estimatedTokens: requiredCredits * TOKENS_PER_CREDIT,
      requiredCredits,
      availableCredits: userCredits,
      canAfford: userCredits >= requiredCredits,
    });
  } catch (err) {
    // Clean up on error
    await r2Delete(body.fileKey).catch(() => {});
    console.error('[estimate] Error:', err);
    return c.json({ error: (err as Error).message }, 500);
  }
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

// Simple auth for preview pages — uses TRANSLATOR_SECRET as password
function checkPreviewAuth(c: any): Response | null {
  const cookie = c.req.header('cookie') || '';
  if (cookie.includes('preview_auth=1')) return null; // authenticated
  return null; // check happens in GET handler
}

app.get('/preview', (c) => {
  // Check auth cookie
  const cookie = c.req.header('cookie') || '';
  if (!cookie.includes(`preview_auth=${env.TRANSLATOR_SECRET}`)) {
    return c.html(LOGIN_HTML);
  }
  return c.html(PREVIEW_HTML);
});

app.post('/preview/login', async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  if (password === env.TRANSLATOR_SECRET) {
    return c.json({ ok: true }, {
      headers: {
        'Set-Cookie': `preview_auth=${env.TRANSLATOR_SECRET}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      },
    });
  }
  return c.json({ error: 'Wrong password' }, 401);
});
app.post('/preview', async (c) => {
  // Verify auth
  const cookie = c.req.header('cookie') || '';
  if (!cookie.includes(`preview_auth=${env.TRANSLATOR_SECRET}`)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

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

// --- Preview: List books ---
app.get('/preview/books', async (c) => {
  const cookie = c.req.header('cookie') || '';
  if (!cookie.includes(`preview_auth=${env.TRANSLATOR_SECRET}`)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const db = getDb();
  const books = await db.all<{
    uuid: string;
    title: string;
    author: string;
    book_cover_img_url: string | null;
    book_spine_img_url: string | null;
  }>('SELECT uuid, title, author, book_cover_img_url, book_spine_img_url FROM books_v2 ORDER BY display_order ASC, title ASC');

  return c.json({ books });
});

// --- Preview: Save cover/spine to R2 + update D1 ---
app.post('/preview/save', async (c) => {
  const cookie = c.req.header('cookie') || '';
  if (!cookie.includes(`preview_auth=${env.TRANSLATOR_SECRET}`)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { bookUuid, cover, spine } = await c.req.json<{
    bookUuid: string;
    cover: string;   // base64 data URI
    spine: string;   // base64 data URI
  }>();

  if (!bookUuid || !cover || !spine) {
    return c.json({ error: 'Missing bookUuid, cover, or spine' }, 400);
  }

  const db = getDb();
  const book = await db.first<{ uuid: string; title: string }>(
    'SELECT uuid, title FROM books_v2 WHERE uuid = ?', [bookUuid],
  );
  if (!book) {
    return c.json({ error: 'Book not found' }, 404);
  }

  // Decode base64 data URIs
  const coverB64 = cover.includes(',') ? cover.split(',')[1] : cover;
  const spineB64 = spine.includes(',') ? spine.split(',')[1] : spine;
  const coverBuf = Buffer.from(coverB64, 'base64');
  const spineBuf = Buffer.from(spineB64, 'base64');

  // Generate unique keys
  const slug = (book.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  const uid = crypto.randomUUID().slice(0, 8);
  const coverKey = `${slug}_${uid}_cover.png`;
  const spineKey = `${slug}_${uid}_spine.png`;

  const [coverUrl, spineUrl] = await Promise.all([
    r2Upload(coverKey, coverBuf, 'image/png'),
    r2Upload(spineKey, spineBuf, 'image/png'),
  ]);

  await db.run(
    "UPDATE books_v2 SET book_cover_img_url = ?, book_spine_img_url = ?, updated_at = datetime('now') WHERE uuid = ?",
    [coverUrl, spineUrl, bookUuid],
  );

  return c.json({ ok: true, coverUrl, spineUrl });
});

// --- Cover Processing ---

// r2Upload is an alias for the existing r2UploadBuffer (defined at top of file)
async function r2Upload(key: string, data: Buffer, contentType: string): Promise<string> {
  return r2UploadBuffer(key, data, contentType);
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

  await db.run(
    'UPDATE books_v2 SET book_cover_img_url = ?, book_spine_img_url = ?, updated_at = datetime(\'now\') WHERE uuid = ?',
    [coverUrl, spineUrl, req.bookUuid],
  );

  console.log(`[cover] Done: ${req.bookUuid} → ${coverUrl}, ${spineUrl}`);
}

// ---- Job Recovery & Scanning ----

const JOB_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Query for stalled jobs and resume them. Shared by startup recovery and periodic scanner. */
async function resumeJobs(label: string, extraWhere = '', extraParams: unknown[] = []): Promise<void> {
  const db = getDb();
  const llmConfig = getLlmConfig();

  const jobs = await db.all<{ book_uuid: string; status: string }>(
    `SELECT book_uuid, status FROM translation_jobs
     WHERE status IN ('pending', 'translating', 'extracting_glossary')
     ${extraWhere}
     ORDER BY updated_at ASC`,
    extraParams
  );

  if (jobs.length === 0) return;

  console.log(`[${label}] Found ${jobs.length} job(s) to resume`);
  for (const job of jobs) {
    if (activeJobs.has(job.book_uuid)) continue;
    console.log(`[${label}] Resuming ${job.book_uuid} (status: ${job.status})`);
    translateBook(db, llmConfig, job.book_uuid).catch((err) => {
      console.error(`[${label}] Failed to resume ${job.book_uuid}:`, err);
    });
  }
}

/** Scan for stalled translation jobs on startup */
async function recoverStalledJobs(): Promise<void> {
  try {
    await resumeJobs('recovery');
  } catch (err) {
    console.error('[recovery] Error scanning for stalled jobs:', err);
  }
}

/** Periodically check for stalled jobs (covers webhook failures and restarts) */
let scannerRunning = false;

function startJobScanner(): void {
  setInterval(async () => {
    if (scannerRunning) return;
    scannerRunning = true;
    try {
      const activeKeys = [...activeJobs.keys()];
      const notInClause = activeKeys.length > 0
        ? `AND book_uuid NOT IN (${activeKeys.map(() => '?').join(',')})`
        : '';
      await resumeJobs('scanner', `AND updated_at < datetime('now', '-5 minutes') ${notInClause}`, activeKeys);
    } catch (err) {
      console.error('[scanner] Error:', err);
    } finally {
      scannerRunning = false;
    }
  }, JOB_SCAN_INTERVAL_MS);
}

const port = parseInt(process.env.PORT || '3000');

import { serve } from '@hono/node-server';

serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 Ovid Translator Service running on port ${port}`);
  // Recover stalled jobs on startup (delay slightly to let server stabilize)
  setTimeout(() => {
    recoverStalledJobs();
    startJobScanner();
  }, 3000);
});
