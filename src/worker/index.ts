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
  getBookChaptersV2,
  getChapterContentV2,
  deleteBookV2,
  getBookStatus,
  getTranslationJob,
  upsertUserBookProgress,
  getUserBookProgress,
} from './db';
import {
  handleBookUpload,
  handleBookEstimate,
  handleTranslateNext,
} from './book-handlers';
// admin-covers moved to Railway translator service

// Rate limiting state (per-worker instance, resets on cold start)
const apiRequestCounts = new Map<string, number[]>();
const uploadRequestCounts = new Map<string, number[]>();
const API_RATE_LIMIT = 60; // requests per minute
const UPLOAD_RATE_LIMIT = 5; // uploads per hour
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

function isRateLimited(countsMap: Map<string, number[]>, ip: string, windowMs: number, maxRequests: number): boolean {
  const now = Date.now();
  const timestamps = countsMap.get(ip) || [];
  const filtered = timestamps.filter(t => now - t < windowMs);
  if (filtered.length >= maxRequests) {
    countsMap.set(ip, filtered);
    return true;
  }
  filtered.push(now);
  countsMap.set(ip, filtered);
  return false;
}

let migrationsRan = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
      migrationsRan = true;
    }

    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
      const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

      // Rate limit: 60 API requests per minute per IP
      if (isRateLimited(apiRequestCounts, clientIp, 60_000, API_RATE_LIMIT)) {
        return new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        });
      }

      // Upload-specific checks
      if (url.pathname === '/api/books/upload' && request.method === 'POST') {
        // Size check: reject uploads > 50MB
        const contentLength = parseInt(request.headers.get('content-length') || '0');
        if (contentLength > MAX_UPLOAD_SIZE) {
          return new Response(JSON.stringify({ error: 'Upload too large. Maximum size is 50MB.' }), {
            status: 413, headers: { 'Content-Type': 'application/json' },
          });
        }
        // Rate limit: 5 uploads per hour per IP
        if (isRateLimited(uploadRequestCounts, clientIp, 3_600_000, UPLOAD_RATE_LIMIT)) {
          return new Response(JSON.stringify({ error: 'Upload rate limit exceeded. Max 5 uploads per hour.' }), {
            status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3600' },
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

        // Translate next chunk (frontend-driven chunked translation)
        const translateNextMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/translate-next$/);
        if (translateNextMatch && request.method === 'POST') {
          return handleTranslateNext(request, env, translateNextMatch[1]);
        }

        // Book status check (with translation progress)
        const statusMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/status$/);
        if (statusMatch) {
          const bookUuid = statusMatch[1];
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
        if (progressMatch && request.method === 'PUT') {
          const user = await getCurrentUser(env.DB, request);
          if (!user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            const body = await request.json() as { readingProgress: number };
            const bookUuid = progressMatch[1];
            
            if (typeof body.readingProgress !== 'number' || body.readingProgress < 0 || body.readingProgress > 100) {
              return new Response(JSON.stringify({ error: 'readingProgress must be a number 0-100' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
            
            // Update progress while preserving completion status
            const currentProgress = await getUserBookProgress(env.DB, user.id, bookUuid);
            const isCompleted = currentProgress?.is_completed ?? false;
            
            await upsertUserBookProgress(env.DB, user.id, bookUuid, isCompleted, body.readingProgress);
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
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    // Handle book URLs: /book/:uuid and /v2/book/:uuid (all use V2 database)
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
          } else {
            return new Response('Book not found', { status: 404 });
          }
        } catch {
          return new Response('Database error', { status: 500 });
        }
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
      return new Response('Not found', { status: 404 });
    } catch {
      return new Response('Asset not found', { status: 404 });
    }
  },
};

// Re-export types for convenience
export type { Env } from './types';
