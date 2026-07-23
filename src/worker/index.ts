/**
 * Cloudflare Worker Entry Point
 * Main router for the Ovid bilingual reader API
 */

import { Env } from './types';
import {
  getCurrentUser,
  handleGoogleAuthStart,
  handleGoogleCallback,
  handleGetCurrentUser,
  handleLogout,
  checkOAuthConfig,
} from './auth';
import {
  handleGetCredits,
  handleGetCreditTransactions,
  handleCreateCheckoutSession,
  handleStripeWebhook,
  handleVerifyCheckoutSession,
  checkStripeConfig,
} from './credits';
import {
  getAllBooksV2,
  getShelfSlots,
  updateShelfSlotLabel,
  getBookChaptersV2,
  getChapterContentV2,
  searchBookV2,
  deleteBookV2,
  moveBookToSlot,
  getBookStatus,
  getTranslationJob,
  upsertUserBookProgress,
  updateReadingProgress,
  getUserBookProgress,
  getAllUserBookProgress,
  checkBookAccess,
  createShareToken,
  getShareToken,
  revokeShareToken,
  getBookByShareToken,
} from './db';
import { buildSnippet, escapeLikePattern } from '../utils/search-snippet';
import {
  handleBookUpload,
  handleBookEstimate,
  handleTranslateNext,
} from './book-handlers';
// admin-covers moved to Railway translator service

import { checkRateLimit } from '../utils/rateLimiter';

// Rate limiting state (per-worker instance, resets on cold start)
const apiRequestCounts = new Map<string, number[]>();
const uploadRequestCounts = new Map<string, number[]>();
const API_RATE_LIMIT = 600; // requests per minute
const UPLOAD_RATE_LIMIT = 5; // uploads per hour
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

let migrationsRan = false;

const createRequestId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
};

const jsonResponse = (
  body: Record<string, unknown>,
  init: ResponseInit = {},
  requestId?: string,
  extraHeaders?: Record<string, string>
) => {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (requestId) headers.set('x-request-id', requestId);
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  return new Response(JSON.stringify(requestId ? { ...body, requestId } : body), {
    ...init,
    headers,
  });
};

const logEvent = (payload: Record<string, unknown>) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...payload }));
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = createRequestId();

    // Check config on startup
    checkOAuthConfig(env);
    checkStripeConfig(env);

    // Run migrations only once per worker instance lifetime
    if (!migrationsRan) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`
      ).run();
      const runMigration = async (name: string, sql: string) => {
        const done = await env.DB.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).bind(name).first();
        if (!done) {
          await env.DB.prepare(sql).run().catch(() => {});
          await env.DB.prepare(`INSERT INTO _migrations (name) VALUES (?)`).bind(name).run();
        }
      };
      await runMigration('books_v2_user_id', 'ALTER TABLE books_v2 ADD COLUMN user_id INTEGER');
      await runMigration('books_v2_status', "ALTER TABLE books_v2 ADD COLUMN status TEXT DEFAULT 'ready'");
      await runMigration('create_translation_jobs', `CREATE TABLE IF NOT EXISTS translation_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        book_uuid TEXT NOT NULL,
        source_language TEXT NOT NULL DEFAULT 'en',
        target_language TEXT NOT NULL DEFAULT 'zh',
        total_chapters INTEGER NOT NULL,
        completed_chapters INTEGER NOT NULL DEFAULT 0,
        current_chapter INTEGER NOT NULL DEFAULT 0,
        current_item_offset INTEGER NOT NULL DEFAULT 0,
        glossary_json TEXT,
        glossary_extracted INTEGER NOT NULL DEFAULT 0,
        title_translated INTEGER NOT NULL DEFAULT 0,
        translated_title TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await runMigration('chapters_v2_text_nodes', 'ALTER TABLE chapters_v2 ADD COLUMN text_nodes_json TEXT');
      await runMigration('books_v2_display_order', 'ALTER TABLE books_v2 ADD COLUMN display_order INTEGER DEFAULT 0');
      await runMigration('create_user_book_progress', `CREATE TABLE IF NOT EXISTS user_book_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        book_uuid TEXT NOT NULL,
        is_completed INTEGER NOT NULL DEFAULT 0,
        reading_progress INTEGER,
        completed_at DATETIME,
        last_read_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, book_uuid)
      )`);
      await runMigration('books_v2_share_token', 'ALTER TABLE books_v2 ADD COLUMN share_token TEXT');
      await runMigration('progress_chapter_xpath', `
        ALTER TABLE user_book_progress ADD COLUMN chapter_number INTEGER;
      `);
      await runMigration('progress_paragraph_xpath', `
        ALTER TABLE user_book_progress ADD COLUMN paragraph_xpath TEXT;
      `);
      await runMigration('progress_show_original', `
        ALTER TABLE user_book_progress ADD COLUMN show_original INTEGER NOT NULL DEFAULT 1;
      `);
      await runMigration('create_book_shelves', `CREATE TABLE IF NOT EXISTS book_shelves (
        shelf_id TEXT NOT NULL,
        book_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (shelf_id, book_id),
        FOREIGN KEY (book_id) REFERENCES books_v2(id) ON DELETE CASCADE
      )`);
      await runMigration('book_shelves_position_index', 'CREATE INDEX IF NOT EXISTS idx_book_shelves_shelf_position ON book_shelves(shelf_id, position, book_id)');
      await runMigration('book_shelves_book_index', 'CREATE INDEX IF NOT EXISTS idx_book_shelves_book ON book_shelves(book_id)');
      await runMigration('create_shelf_slots', `CREATE TABLE IF NOT EXISTS shelf_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shelf_id TEXT NOT NULL,
        row INTEGER NOT NULL,
        col INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        label TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(shelf_id, row, col),
        UNIQUE(shelf_id, sort_order)
      )`);
      await runMigration('create_book_shelf_slots', `CREATE TABLE IF NOT EXISTS book_shelf_slots (
        book_id INTEGER PRIMARY KEY,
        slot_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books_v2(id) ON DELETE CASCADE,
        FOREIGN KEY (slot_id) REFERENCES shelf_slots(id) ON DELETE CASCADE
      )`);
      await runMigration('book_shelf_slots_slot_position_index', 'CREATE INDEX IF NOT EXISTS idx_book_shelf_slots_slot_position ON book_shelf_slots(slot_id, position, book_id)');
      await runMigration('shelf_slots_is_public', 'ALTER TABLE shelf_slots ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
      // Slots holding the seeded public collection (Gutenberg) are locked:
      // books can be neither dragged into nor out of a public shelf.
      await runMigration('shelf_slots_mark_public_collection', `UPDATE shelf_slots SET is_public = 1 WHERE id IN (
        SELECT DISTINCT bss.slot_id FROM book_shelf_slots bss
        JOIN books_v2 b ON b.id = bss.book_id
        WHERE b.user_id IS NULL
      )`);
      // Shelf labels on private (non-public) slots become per-user: each
      // owner sees and edits only their own label, so a signed-out visitor
      // or another user no longer sees someone else's private shelf labels.
      await runMigration('create_user_shelf_slot_labels', `CREATE TABLE IF NOT EXISTS user_shelf_slot_labels (
        user_id INTEGER NOT NULL,
        slot_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, slot_id),
        FOREIGN KEY (slot_id) REFERENCES shelf_slots(id) ON DELETE CASCADE
      )`);
      await runMigration('migrate_private_labels_to_users', `INSERT OR IGNORE INTO user_shelf_slot_labels (user_id, slot_id, label)
        SELECT DISTINCT b.user_id, ss.id, ss.label
        FROM shelf_slots ss
        JOIN book_shelf_slots bss ON bss.slot_id = ss.id
        JOIN books_v2 b ON b.id = bss.book_id
        WHERE ss.is_public = 0 AND ss.label IS NOT NULL AND ss.label != '' AND b.user_id IS NOT NULL`);
      // Only clear labels that provably made it into the per-user table: if
      // the backfill above silently failed (runMigration swallows errors) or
      // a labeled slot had no owning books to migrate to, the global label
      // survives untouched instead of being destroyed.
      await runMigration('clear_private_global_labels', `UPDATE shelf_slots SET label = NULL
        WHERE is_public = 0 AND id IN (SELECT slot_id FROM user_shelf_slot_labels)`);
      migrationsRan = true;
    }

    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
      const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
      const cfRay = request.headers.get('cf-ray');
      const userAgent = request.headers.get('user-agent') || 'unknown';

      // Rate limit: 60 API requests per minute per IP
      const apiRate = checkRateLimit(apiRequestCounts, clientIp, 60_000, API_RATE_LIMIT);
      if (apiRate.limited) {
        logEvent({
          level: 'warn',
          type: 'rate_limit',
          scope: 'api',
          requestId,
          method: request.method,
          path: url.pathname,
          clientIp,
          userAgent,
          cfRay,
          limit: apiRate.limit,
          current: apiRate.current,
          remaining: apiRate.remaining,
          resetAfterSeconds: apiRate.resetAfterSeconds,
        });
        return jsonResponse({
          error: '请求过于频繁，请稍后再试。',
          code: 'RATE_LIMITED',
          details: `${request.method} ${url.pathname}`,
          retryAfter: apiRate.resetAfterSeconds,
        }, {
          status: 429,
        }, requestId, {
          'Retry-After': String(apiRate.resetAfterSeconds),
          'X-RateLimit-Limit': String(apiRate.limit),
          'X-RateLimit-Remaining': String(apiRate.remaining),
          'X-RateLimit-Reset': String(apiRate.resetAfterSeconds),
        });
      }

      // Upload-specific checks
      if (url.pathname === '/api/books/upload' && request.method === 'POST') {
        // Size check: reject uploads > 50MB
        const contentLength = parseInt(request.headers.get('content-length') || '0');
        if (contentLength > MAX_UPLOAD_SIZE) {
          logEvent({
            level: 'warn',
            type: 'upload_rejected',
            reason: 'file_too_large',
            requestId,
            method: request.method,
            path: url.pathname,
            clientIp,
            userAgent,
            contentLength,
            maxUploadSize: MAX_UPLOAD_SIZE,
          });
          return jsonResponse({ error: 'Upload too large. Maximum size is 50MB.', code: 'UPLOAD_TOO_LARGE' }, {
            status: 413,
          }, requestId);
        }
        const uploadRate = checkRateLimit(uploadRequestCounts, clientIp, 3_600_000, UPLOAD_RATE_LIMIT);
        if (uploadRate.limited) {
          logEvent({
            level: 'warn',
            type: 'rate_limit',
            scope: 'upload',
            requestId,
            method: request.method,
            path: url.pathname,
            clientIp,
            userAgent,
            cfRay,
            limit: uploadRate.limit,
            current: uploadRate.current,
            remaining: uploadRate.remaining,
            resetAfterSeconds: uploadRate.resetAfterSeconds,
          });
          return jsonResponse({
            error: '上传次数过多，请稍后再试。',
            code: 'UPLOAD_RATE_LIMITED',
            details: 'Max 5 uploads per hour.',
            retryAfter: uploadRate.resetAfterSeconds,
          }, {
            status: 429,
          }, requestId, {
            'Retry-After': String(uploadRate.resetAfterSeconds),
            'X-RateLimit-Limit': String(uploadRate.limit),
            'X-RateLimit-Remaining': String(uploadRate.remaining),
            'X-RateLimit-Reset': String(uploadRate.resetAfterSeconds),
          });
        }
      }

      try {
        // ==================
        // Auth endpoints
        // ==================
        if (url.pathname === '/api/auth/google') {
          const oauthCheck = checkOAuthConfig(env);
          if (!oauthCheck.configured) {
            return new Response(
              JSON.stringify({ error: 'Google OAuth is not configured.', missing: oauthCheck.errors }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return handleGoogleAuthStart(request, env);
        }

        if (url.pathname === '/api/auth/callback/google') {
          const oauthCheck = checkOAuthConfig(env);
          if (!oauthCheck.configured) {
            return new Response(
              JSON.stringify({ error: 'Google OAuth is not configured.', missing: oauthCheck.errors }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return handleGoogleCallback(request, env);
        }

        if (url.pathname === '/api/auth/me') {
          return handleGetCurrentUser(request, env);
        }

        if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
          return handleLogout(request, env);
        }

        // ==================
        // Credits & Stripe endpoints
        // ==================
        if (url.pathname === '/api/credits') {
          return handleGetCredits(request, env);
        }

        if (url.pathname === '/api/credits/transactions') {
          return handleGetCreditTransactions(request, env);
        }

        if (url.pathname === '/api/stripe/checkout' && request.method === 'POST') {
          const stripeCheck = checkStripeConfig(env);
          if (!stripeCheck.configured) {
            return new Response(
              JSON.stringify({ error: 'Stripe payments are not configured.', missing: stripeCheck.errors }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return handleCreateCheckoutSession(request, env);
        }

        if (url.pathname === '/api/stripe/webhook' && request.method === 'POST') {
          const stripeCheck = checkStripeConfig(env, true);
          if (!stripeCheck.configured) {
            return new Response(
              JSON.stringify({ error: 'Stripe webhook is not configured.', missing: stripeCheck.errors }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return handleStripeWebhook(request, env);
        }

        if (url.pathname === '/api/stripe/verify-session') {
          const stripeCheck = checkStripeConfig(env);
          if (!stripeCheck.configured) {
            return new Response(
              JSON.stringify({ error: 'Stripe is not configured.', missing: stripeCheck.errors }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return handleVerifyCheckoutSession(request, env);
        }

        // ==================
        // Book endpoints
        // ==================
        if (url.pathname === '/api/books/estimate' && request.method === 'POST') {
          return handleBookEstimate(request, env);
        }

        // Cover preview moved to Railway translator service

        if (url.pathname === '/api/books/upload' && request.method === 'POST') {
          return handleBookUpload(request, env, ctx);
        }

        if (url.pathname === '/api/shelf-slots' && request.method === 'GET') {
          const shelfSlotsUser = await getCurrentUser(env.DB, request);
          const slots = await getShelfSlots(env.DB, 'main', shelfSlotsUser?.id ?? null);
          return new Response(JSON.stringify(slots), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Edit a shelf slot's label (any signed-in user; public shelves locked)
        const slotLabelMatch = url.pathname.match(/^\/api\/shelf-slot\/(\d+)\/label$/);
        if (slotLabelMatch && request.method === 'PUT') {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            const body = await request.json() as { label?: unknown };
            if (typeof body.label !== 'string') {
              return new Response(JSON.stringify({ error: 'Invalid label' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            const trimmed = body.label.trim();
            if (trimmed.length > 60) {
              return new Response(JSON.stringify({ error: 'Invalid label' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            await updateShelfSlotLabel(
              env.DB,
              Number(slotLabelMatch[1]),
              user.id,
              trimmed === '' ? null : trimmed
            );
            return new Response(
              JSON.stringify({ success: true, label: trimmed || null }),
              { headers: { 'Content-Type': 'application/json' } }
            );
          } catch (e: any) {
            if (e.message?.includes('Forbidden')) {
              return new Response(JSON.stringify({ error: 'Forbidden' }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
              });
            }
            if (e.message === 'Slot not found') {
              return new Response(JSON.stringify({ error: 'Slot not found' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
              });
            }
            throw e;
          }
        }

        // Translate next chunk (frontend-driven chunked translation)
        const translateNextMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/translate-next$/);
        if (translateNextMatch && request.method === 'POST') {
          return handleTranslateNext(request, env, translateNextMatch[1]);
        }

        // Book status check (with translation progress)
        const statusMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/status$/);
        if (statusMatch) {
          const bookUuid = statusMatch[1];

          // Access check
          const statusUser = await getCurrentUser(env.DB, request);
          const statusAccess = await checkBookAccess(env.DB, bookUuid, statusUser?.id);
          if (!statusAccess.accessible) {
            return new Response(JSON.stringify({ error: 'Not found' }), {
              status: 404, headers: { 'Content-Type': 'application/json' },
            });
          }

          const status = await getBookStatus(env.DB, bookUuid);
          if (!status) {
            return new Response(JSON.stringify({ error: 'Book not found' }), {
              status: 404, headers: { 'Content-Type': 'application/json' },
            });
          }

          let progress = null;
          if (status === 'processing') {
            const job = await getTranslationJob(env.DB, bookUuid);
            if (job) {
              progress = {
                phase: job.status,
                chaptersCompleted: job.completed_chapters,
                chaptersTotal: job.total_chapters,
                currentChapter: job.current_chapter,
              };
            }
          }

          return new Response(JSON.stringify({ status, progress }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Delete book
        const deleteMatch = url.pathname.match(/^\/api\/book\/([^\/]+)$/);
        if (deleteMatch && request.method === 'DELETE') {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            await deleteBookV2(env.DB, deleteMatch[1], user.id);
          } catch (e: any) {
            if (e.message?.includes('Forbidden')) {
              return new Response(JSON.stringify({ error: 'Forbidden' }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
              });
            }
            throw e;
          }
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Move a book to a new shelf slot / position within a slot (drag-and-drop)
        const positionMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/position$/);
        if (positionMatch && request.method === 'PUT') {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            const body = await request.json() as {
              targetSlotId?: number;
              targetRow?: number;
              targetCol?: number;
              insertIndex?: number;
            };
            if (!Number.isInteger(body.insertIndex) || (body.insertIndex as number) < 0) {
              return new Response(JSON.stringify({ error: 'Invalid insertIndex' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            // Same bounds the upload flow enforces (parseShelfCoord): an
            // unbounded coordinate would mint a shelf_slots row light-years
            // from the wall and blow up the layout grid for every visitor.
            const validCoord = (v: unknown) =>
              v === undefined || v === null ||
              (Number.isInteger(v) && Math.abs(v as number) <= 50);
            const validSlotId = (v: unknown) =>
              v === undefined || v === null ||
              (Number.isInteger(v) && (v as number) > 0);
            if (
              !validCoord(body.targetRow) ||
              !validCoord(body.targetCol) ||
              !validSlotId(body.targetSlotId)
            ) {
              return new Response(JSON.stringify({ error: 'Invalid target' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            const result = await moveBookToSlot(
              env.DB,
              positionMatch[1],
              user.id,
              {
                slotId: body.targetSlotId ?? null,
                row: body.targetRow ?? null,
                col: body.targetCol ?? null,
              },
              body.insertIndex
            );
            return new Response(JSON.stringify({ success: true, ...result }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (e: any) {
            if (e.message?.includes('Forbidden')) {
              return new Response(JSON.stringify({ error: 'Forbidden' }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
              });
            }
            if (e.message === 'Book not found') {
              return new Response(JSON.stringify({ error: 'Book not found' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
              });
            }
            if (e.message === 'Invalid target') {
              return new Response(JSON.stringify({ error: 'Invalid target' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            throw e;
          }
        }

        // Mark book as completed/read (supports both public and user-owned books)
        const markCompleteMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/mark-complete$/);
        if (markCompleteMatch && request.method === 'POST') {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            const body = await request.json() as { isCompleted: boolean; readingProgress?: number };
            const bookUuid = markCompleteMatch[1];
            
            if (typeof body.isCompleted !== 'boolean') {
              return new Response(JSON.stringify({ error: 'isCompleted must be boolean' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            
            // Validate reading progress if provided
            const readingProgress = body.readingProgress;
            if (readingProgress !== undefined && (typeof readingProgress !== 'number' || readingProgress < 0 || readingProgress > 100)) {
              return new Response(JSON.stringify({ error: 'readingProgress must be 0-100' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            
            await upsertUserBookProgress(env.DB, user.id, bookUuid, body.isCompleted, readingProgress);
            const progress = await getUserBookProgress(env.DB, user.id, bookUuid);
            return new Response(JSON.stringify({ success: true, progress }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            console.error('Mark complete error:', err);
            return new Response(JSON.stringify({ 
              error: 'Invalid request',
              details: err instanceof Error ? err.message : String(err)
            }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        // Get all reading progress for the current user (batch)
        if (url.pathname === '/api/progress' && request.method === 'GET') {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ progress: {} }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const allProgress = await getAllUserBookProgress(env.DB, user.id);
          const progressMap: Record<string, any> = {};
          for (const p of allProgress) {
            progressMap[p.book_uuid] = p;
          }
          return new Response(JSON.stringify({ progress: progressMap }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Get user's reading progress for a book
        const progressMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/progress$/);
        if (progressMatch && request.method === 'GET') {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ progress: null }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const bookUuid = progressMatch[1];
          const progress = await getUserBookProgress(env.DB, user.id, bookUuid);
          return new Response(JSON.stringify({ progress }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Update reading progress for a book (PUT)
        // Accept both PUT and POST (POST used by sendBeacon on page unload)
        const isProgressUpdate = progressMatch && (
          request.method === 'PUT' || request.method === 'POST'
        );
        if (isProgressUpdate) {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            const body = await request.json() as {
              readingProgress: number;
              chapterNumber?: number;
              paragraphXpath?: string;
              showOriginal?: boolean;
            };
            const bookUuid = progressMatch[1];

            if (typeof body.readingProgress !== 'number' || body.readingProgress < 0 || body.readingProgress > 100) {
              return new Response(JSON.stringify({ error: 'readingProgress must be a number 0-100' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            if (body.chapterNumber !== undefined && (!Number.isInteger(body.chapterNumber) || body.chapterNumber < 1)) {
              return new Response(JSON.stringify({ error: 'chapterNumber must be a positive integer' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            if (body.paragraphXpath !== undefined && (typeof body.paragraphXpath !== 'string' || body.paragraphXpath.length > 500)) {
              return new Response(JSON.stringify({ error: 'paragraphXpath must be a string under 500 chars' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            if (body.showOriginal !== undefined && typeof body.showOriginal !== 'boolean') {
              return new Response(JSON.stringify({ error: 'showOriginal must be a boolean' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }

            // Update reading_progress + optional chapter/xpath/showOriginal — never touch is_completed or completed_at
            await updateReadingProgress(
              env.DB, user.id, bookUuid, body.readingProgress,
              body.chapterNumber, body.paragraphXpath, body.showOriginal
            );
            const updatedProgress = await getUserBookProgress(env.DB, user.id, bookUuid);
            
            return new Response(JSON.stringify({ success: true, progress: updatedProgress }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err) {
            console.error('Update progress error:', err);
            return new Response(JSON.stringify({ 
              error: 'Invalid request',
              details: err instanceof Error ? err.message : String(err)
            }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        // ==================
        // Share endpoints
        // ==================

        // POST /api/book/:uuid/share - create share token (owner only)
        // GET /api/book/:uuid/share - get share token (owner only)
        // DELETE /api/book/:uuid/share - revoke share token (owner only)
        const shareMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/share$/);
        if (shareMatch) {
          const bookUuid = shareMatch[1];
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }

          try {
            if (request.method === 'POST') {
              const token = await createShareToken(env.DB, bookUuid, user.id);
              return new Response(JSON.stringify({ token, url: `${url.origin}/shared/${token}` }), {
                headers: { 'Content-Type': 'application/json' },
              });
            }

            if (request.method === 'GET') {
              const token = await getShareToken(env.DB, bookUuid, user.id);
              return new Response(JSON.stringify({ token, url: token ? `${url.origin}/shared/${token}` : null }), {
                headers: { 'Content-Type': 'application/json' },
              });
            }

            if (request.method === 'DELETE') {
              await revokeShareToken(env.DB, bookUuid, user.id);
              return new Response(JSON.stringify({ success: true }), {
                headers: { 'Content-Type': 'application/json' },
              });
            }
          } catch (e: any) {
            if (e.message === 'Forbidden') {
              return new Response(JSON.stringify({ error: 'Forbidden' }), {
                status: 403, headers: { 'Content-Type': 'application/json' },
              });
            }
            if (e.message === 'Book not found') {
              return new Response(JSON.stringify({ error: 'Not found' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
              });
            }
            throw e;
          }
        }

        // GET /api/shared/:token/chapters - unauthenticated chapter list
        // GET /api/shared/:token/chapter/:num - unauthenticated chapter content
        const sharedMatch = url.pathname.match(/^\/api\/shared\/([^\/]+)\/(.+)$/);
        if (sharedMatch) {
          const token = sharedMatch[1];
          const endpoint = sharedMatch[2];

          const sharedBook = await getBookByShareToken(env.DB, token);
          if (!sharedBook) {
            return new Response(JSON.stringify({ error: 'Not found' }), {
              status: 404, headers: { 'Content-Type': 'application/json' },
            });
          }

          if (endpoint === 'chapters') {
            const chapters = await getBookChaptersV2(env.DB, sharedBook.uuid);
            return new Response(JSON.stringify(chapters), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (endpoint.startsWith('chapter/')) {
            const chapterNumber = parseInt(endpoint.split('/')[1] || '1');
            const chapterData = await getChapterContentV2(env.DB, chapterNumber, sharedBook.uuid);

            return new Response(JSON.stringify({
              uuid: chapterData.book.uuid,
              title: chapterData.book.title,
              originalTitle: chapterData.book.original_title,
              author: chapterData.book.author,
              styles: chapterData.book.styles,
              currentChapter: chapterNumber,
              chapterInfo: {
                number: chapterData.chapter.chapter_number,
                title: chapterData.chapter.title,
                originalTitle: chapterData.chapter.original_title,
              },
              rawHtml: chapterData.rawHtml,
              translations: chapterData.translations,
            }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
          });
        }

        // All book listing now uses V2
        if (url.pathname === '/api/books' || url.pathname === '/api/v2/books') {
          const user = await getCurrentUser(env.DB, request);
          const books = await getAllBooksV2(env.DB, user?.id);
          return new Response(JSON.stringify(books), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Book API: /api/book/:uuid/... and /api/v2/book/:uuid/... (all use V2)
        const apiMatch = url.pathname.match(/^\/api(?:\/v2)?\/book\/([^\/]+)\/(.+)$/);
        if (apiMatch) {
          const bookUuid = apiMatch[1];
          const endpoint = apiMatch[2];

          // Access check for book data endpoints
          if (endpoint === 'chapters' || endpoint.startsWith('chapter/') || endpoint === 'search') {
            const user = await getCurrentUser(env.DB, request);
            const access = await checkBookAccess(env.DB, bookUuid, user?.id);
            if (!access.accessible) {
              return new Response(JSON.stringify({ error: 'Not found' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
              });
            }
          }

          if (endpoint === 'search') {
            const query = (url.searchParams.get('q') || '').trim();
            if (!query) {
              return new Response(JSON.stringify({ query, results: [], hasMore: false }), {
                headers: { 'Content-Type': 'application/json' },
              });
            }
            const LIMIT = 50;
            const offset = Math.max(
              0,
              parseInt(url.searchParams.get('offset') || '0', 10) || 0
            );
            const pattern = `%${escapeLikePattern(query)}%`;
            const rows = (await searchBookV2(env.DB, bookUuid, pattern, LIMIT, offset)) as Array<{
              chapter_number: number;
              chapter_title: string;
              xpath: string;
              original_text: string | null;
              translated_text: string | null;
            }>;
            const hasMore = rows.length > LIMIT;
            const results = rows.slice(0, LIMIT).map((r) => {
              // Prefer the field that actually contains the match; when both
              // do, show the original (what bilingual readers usually quote).
              const fromOriginal = buildSnippet(r.original_text || '', query);
              const snippet = fromOriginal ?? buildSnippet(r.translated_text || '', query);
              return {
                chapter: r.chapter_number,
                chapterTitle: r.chapter_title,
                xpath: r.xpath,
                field: fromOriginal !== null ? 'original' : 'translated',
                snippet: snippet ?? '',
              };
            });
            return new Response(JSON.stringify({ query, results, hasMore }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (endpoint === 'chapters') {
            const chapters = await getBookChaptersV2(env.DB, bookUuid);
            return new Response(JSON.stringify(chapters), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (endpoint.startsWith('chapter/')) {
            const chapterNumber = parseInt(endpoint.split('/')[1] || '1');
            const chapterData = await getChapterContentV2(env.DB, chapterNumber, bookUuid);

            return new Response(JSON.stringify({
              uuid: chapterData.book.uuid,
              title: chapterData.book.title,
              originalTitle: chapterData.book.original_title,
              author: chapterData.book.author,
              styles: chapterData.book.styles,
              currentChapter: chapterNumber,
              chapterInfo: {
                number: chapterData.chapter.chapter_number,
                title: chapterData.chapter.title,
                originalTitle: chapterData.chapter.original_title,
              },
              rawHtml: chapterData.rawHtml,
              translations: chapterData.translations,
            }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        return new Response('API endpoint not found', { status: 404 });
      } catch (error) {
        console.error('API Error:', error);
        logEvent({
          level: 'error',
          type: 'api_error',
          requestId,
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }, { status: 500 }, requestId);
      }
    }

    // Handle shared book URLs: /shared/:token
    const sharedUrlMatch = url.pathname.match(/^\/shared\/([^\/]+)/);
    if (sharedUrlMatch) {
      try {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
      } catch {
        return new Response(
          `<!DOCTYPE html><html><head><title>Ovid - Shared Book</title></head><body><div id="root">Loading...</div></body></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
    }

    // Handle book URLs: /book/:uuid and /v2/book/:uuid (all use V2 database)
    // For private books, we serve the SPA and let the frontend handle the auth check
    // via API calls (which have access control). This avoids needing cookie parsing here.
    const bookUrlMatch = url.pathname.match(/^\/(?:v2\/)?book\/([^\/]+)/);
    if (bookUrlMatch) {
      const bookUuid = bookUrlMatch[1];
      if (bookUuid) {
        try {
          const book = await env.DB.prepare('SELECT uuid FROM books_v2 WHERE uuid = ?')
            .bind(bookUuid)
            .first();

          if (book) {
            try {
              return env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
            } catch {
              return new Response(
                `<!DOCTYPE html><html><head><title>Ovid - Reading ${bookUuid}</title></head><body><div id="root">Loading...</div></body></html>`,
                { headers: { 'Content-Type': 'text/html' } }
              );
            }
          }
        } catch {
          // Fall through to redirect
        }
        // Book not found — redirect to home
        return Response.redirect(new URL('/', request.url).toString(), 302);
      }
    }

    // Handle root URL
    if (url.pathname === '/') {
      try {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
      } catch {
        return new Response(
          `<!DOCTYPE html><html><head><title>Ovid - Library</title></head><body><div id="root">Loading...</div></body></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
    }

    // Serve static assets
    try {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    } catch {
      // Fall through to redirect
    }

    // Unknown route — redirect to home
    return Response.redirect(new URL('/', request.url).toString(), 302);
  },
};

// Re-export types for convenience
export type { Env } from './types';
