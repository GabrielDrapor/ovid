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
  getBookWithContent,
  getBookChapters,
  getChapterContent,
  getAllBooks,
} from './db';
import {
  handleBookUpload,
  handleBookEstimate,
} from './book-handlers';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Check config on startup
    checkOAuthConfig(env);
    checkStripeConfig(env);

    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
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
          return handleGoogleAuthStart(env);
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

        if (url.pathname === '/api/books/upload' && request.method === 'POST') {
          return handleBookUpload(request, env);
        }

        // ==================
        // Cover image endpoints
        // ==================
        const coverMatch = url.pathname.match(/^\/api\/covers\/([^\/]+)\/(cover|spine)\.(png|jpg|jpeg|webp)$/);
        if (coverMatch && env.BOOK_COVERS) {
          const bookUuid = coverMatch[1];
          const imageType = coverMatch[2];
          const extension = coverMatch[3];
          const key = `${bookUuid}/${imageType}.${extension}`;

          const object = await env.BOOK_COVERS.get(key);
          if (!object) {
            return new Response('Cover not found', { status: 404 });
          }

          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year

          return new Response(object.body, { headers });
        }

        if (url.pathname === '/api/books') {
          const user = await getCurrentUser(env.DB, request);
          const books = await getAllBooks(env.DB, user?.id);
          return new Response(JSON.stringify(books), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Book API: /api/book/:uuid/...
        const apiMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/(.+)$/);
        if (apiMatch) {
          const bookUuid = apiMatch[1];
          const endpoint = apiMatch[2];

          if (endpoint === 'content') {
            const bookData = await getBookWithContent(env.DB, bookUuid);
            return new Response(JSON.stringify({
              uuid: bookData.book.uuid,
              title: bookData.book.title,
              originalTitle: bookData.book.original_title,
              author: bookData.book.author,
              styles: bookData.book.styles,
              content: bookData.content.map((item: any) => ({
                id: item.item_id,
                original: item.original_text,
                translated: item.translated_text,
                type: item.type,
                className: item.class_name,
                tagName: item.tag_name,
                styles: item.styles,
              })),
            }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (endpoint === 'chapters') {
            const chapters = await getBookChapters(env.DB, bookUuid);
            return new Response(JSON.stringify(chapters), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (endpoint.startsWith('chapter/')) {
            const chapterNumber = parseInt(endpoint.split('/')[1] || '1');
            const chapterData = await getChapterContent(env.DB, chapterNumber, bookUuid);

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
              content: chapterData.content.map((item: any) => ({
                id: item.item_id,
                original: item.original_text,
                translated: item.translated_text,
                type: item.type,
                className: item.class_name,
                tagName: item.tag_name,
                styles: item.styles,
              })),
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

    // Handle book URLs: /book/:uuid
    if (url.pathname.startsWith('/book/')) {
      const bookUuid = url.pathname.split('/')[2];
      if (bookUuid) {
        try {
          const book = await env.DB.prepare('SELECT uuid FROM books WHERE uuid = ?')
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
