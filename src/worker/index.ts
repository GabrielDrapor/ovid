// ===================
// Auth Helper Functions
// ===================

function generateSessionToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function getSessionCookie(request: Request): string | null {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(/ovid_session=([^;]+)/);
  return match ? match[1] : null;
}

function createSessionCookie(
  token: string,
  maxAge: number = 30 * 24 * 60 * 60
): string {
  return `ovid_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function createExpiredSessionCookie(): string {
  return 'ovid_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

async function getCurrentUser(
  db: D1Database,
  request: Request
): Promise<{ id: number; email: string; name: string; picture: string } | null> {
  const sessionToken = getSessionCookie(request);
  if (!sessionToken) return null;

  const session = await db
    .prepare(
      `SELECT s.*, u.id as user_id, u.email, u.name, u.picture
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.session_token = ? AND s.expires_at > datetime('now')`
    )
    .bind(sessionToken)
    .first();

  if (!session) return null;

  return {
    id: session.user_id as number,
    email: session.email as string,
    name: session.name as string,
    picture: session.picture as string,
  };
}

async function handleGoogleAuthStart(env: Env): Promise<Response> {
  const redirectUri = `${env.APP_URL}/api/auth/callback/google`;
  const scope = 'openid email profile';
  const state = generateSessionToken(); // CSRF protection

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function handleGoogleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code) {
    return new Response('Missing authorization code', { status: 400 });
  }

  // Exchange code for tokens
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${env.APP_URL}/api/auth/callback/google`,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('Token exchange failed:', errorText);
    return new Response('Failed to exchange authorization code', {
      status: 500,
    });
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    id_token: string;
  };

  // Get user info from Google
  const userInfoResponse = await fetch(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }
  );

  if (!userInfoResponse.ok) {
    return new Response('Failed to get user info', { status: 500 });
  }

  const googleUser = (await userInfoResponse.json()) as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };

  // Create or update user in database
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?')
    .bind(googleUser.id)
    .first();

  if (user) {
    // Update existing user
    await env.DB.prepare(
      `UPDATE users SET email = ?, name = ?, picture = ?, updated_at = datetime('now') WHERE google_id = ?`
    )
      .bind(googleUser.email, googleUser.name, googleUser.picture, googleUser.id)
      .run();
  } else {
    // Create new user
    await env.DB.prepare(
      'INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?)'
    )
      .bind(googleUser.id, googleUser.email, googleUser.name, googleUser.picture)
      .run();
    user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?')
      .bind(googleUser.id)
      .first();
  }

  // Create session
  const sessionToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await env.DB.prepare(
    'INSERT INTO sessions (user_id, session_token, expires_at) VALUES (?, ?, ?)'
  )
    .bind(user!.id, sessionToken, expiresAt.toISOString())
    .run();

  // Redirect to home with session cookie
  return new Response(null, {
    status: 302,
    headers: {
      Location: env.APP_URL,
      'Set-Cookie': createSessionCookie(sessionToken),
    },
  });
}

async function handleGetCurrentUser(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);

  if (!user) {
    return new Response(JSON.stringify({ user: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const sessionToken = getSessionCookie(request);

  if (sessionToken) {
    // Delete session from database
    await env.DB.prepare('DELETE FROM sessions WHERE session_token = ?')
      .bind(sessionToken)
      .run();
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': createExpiredSessionCookie(),
    },
  });
}

// ===================
// Database query functions
// ===================

async function getBookWithContent(db: D1Database, bookUuid: string) {
  // Get book metadata by UUID
  const book = await db
    .prepare('SELECT * FROM books WHERE uuid = ?')
    .bind(bookUuid)
    .first();
  if (!book) {
    throw new Error('Book not found');
  }

  // Get all content items ordered by order_index
  const contentItems = await db
    .prepare(
      `
    SELECT ci.*, c.chapter_number, c.title as chapter_title, c.original_title as chapter_original_title
    FROM content_items ci
    LEFT JOIN chapters c ON ci.chapter_id = c.id
    WHERE ci.book_id = ?
    ORDER BY ci.order_index ASC
  `
    )
    .bind(book.id)
    .all();

  return {
    book,
    content: contentItems.results,
  };
}

async function getBookChapters(db: D1Database, bookUuid: string) {
  // Get book by UUID first
  const book = await db
    .prepare('SELECT id FROM books WHERE uuid = ?')
    .bind(bookUuid)
    .first();
  if (!book) {
    throw new Error('Book not found');
  }

  const chapters = await db
    .prepare(
      `
    SELECT id, chapter_number, title, original_title, order_index
    FROM chapters
    WHERE book_id = ?
    ORDER BY order_index ASC
  `
    )
    .bind(book.id)
    .all();

  return chapters.results;
}

async function getChapterContent(
  db: D1Database,
  chapterNumber: number,
  bookUuid: string
) {
  // Get book metadata by UUID
  const book = await db
    .prepare('SELECT * FROM books WHERE uuid = ?')
    .bind(bookUuid)
    .first();
  if (!book) {
    throw new Error('Book not found');
  }

  // Handle chapter 0 (title page)
  if (chapterNumber === 0) {
    // Create title page content if no title content exists in DB
    return {
      book,
      chapter: {
        id: 0,
        chapter_number: 0,
        title: book.title,
        original_title: book.original_title || book.title,
        order_index: 0,
      },
      content: [
        {
          id: 'title-0',
          original: book.original_title || book.title || 'Title',
          translated: book.title || 'Title',
          type: 'title',
          className: null,
          tagName: 'h1',
          styles: null,
          order_index: 0,
        },
        {
          id: 'author-0',
          original: book.author || 'Unknown Author',
          translated: book.author || 'Unknown Author',
          type: 'paragraph',
          className: null,
          tagName: 'p',
          styles: null,
          order_index: 1,
        },
      ],
    };
  }

  // Get chapter info for regular chapters
  const chapter = await db
    .prepare(
      `
    SELECT * FROM chapters 
    WHERE book_id = ? AND chapter_number = ?
  `
    )
    .bind(book.id, chapterNumber)
    .first();

  if (!chapter) {
    throw new Error('Chapter not found');
  }

  // Get content items for this chapter
  const contentItems = await db
    .prepare(
      `
    SELECT ci.* 
    FROM content_items ci
    WHERE ci.book_id = ? AND ci.chapter_id = ?
    ORDER BY ci.order_index ASC
  `
    )
    .bind(book.id, chapter.id)
    .all();

  // Ensure a visible chapter title item exists at the top. Inject if missing.
  const items: any[] = Array.isArray((contentItems as any).results)
    ? (contentItems as any).results.slice()
    : [];
  const hasTitleItem = items.some(
    (it: any) => it?.type === 'chapter' || it?.type === 'title'
  );
  if (!hasTitleItem) {
    items.unshift({
      item_id: `chapter-title-${chapter.chapter_number}`,
      original_text: chapter.original_title || chapter.title,
      translated_text: chapter.title || chapter.original_title,
      type: 'chapter',
      class_name: null,
      tag_name: 'h3',
      styles: null,
      order_index: 0,
    });
  }

  return {
    book,
    chapter,
    content: items,
  };
}

async function getAllBooks(db: D1Database, userId?: number) {
  let query: string;
  let params: any[] = [];

  if (userId) {
    // If user is logged in, show public books (user_id IS NULL) AND their own books
    query = `
      SELECT id, uuid, title, original_title, author, language_pair, book_cover_img_url, book_spine_img_url, created_at, updated_at
      FROM books
      WHERE user_id IS NULL OR user_id = ?
      ORDER BY created_at DESC
    `;
    params = [userId];
  } else {
    // If user is not logged in, show only public books
    query = `
      SELECT id, uuid, title, original_title, author, language_pair, book_cover_img_url, book_spine_img_url, created_at, updated_at
      FROM books
      WHERE user_id IS NULL
      ORDER BY created_at DESC
    `;
  }

  const stmt = db.prepare(query);
  const books = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

  return books.results;
}

// ===================
// Book Upload Handler
// ===================

async function handleBookUpload(
  request: Request,
  env: Env
): Promise<Response> {
  // Check authentication
  const user = await getCurrentUser(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const targetLanguage = formData.get('targetLanguage') as string || 'zh';
    const sourceLanguage = formData.get('sourceLanguage') as string || 'en';

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate file type
    if (!file.name.endsWith('.epub')) {
      return new Response(
        JSON.stringify({ error: 'Only EPUB files are supported' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Read file as ArrayBuffer
    const buffer = await file.arrayBuffer();

    // Debug: Log environment variable configuration
    console.log('📝 Environment configuration:');
    console.log('  API Key present:', !!env.OPENAI_API_KEY);
    console.log('  API Key length:', env.OPENAI_API_KEY?.length);
    console.log('  API Base URL:', env.OPENAI_API_BASE_URL);
    console.log('  API Model:', env.OPENAI_MODEL);

    // Import BookProcessor
    const { BookProcessor } = await import('../utils/book-processor');
    const processor = new BookProcessor(8, {
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_API_BASE_URL,
      model: env.OPENAI_MODEL,
    });

    // Process the EPUB
    const processedBook = await processor.processEPUB(
      buffer,
      targetLanguage,
      sourceLanguage,
      {
        chapterConcurrency: 2,
      }
    );

    // Generate UUID for the book
    const bookUuid = crypto.randomUUID();

    // Insert book metadata
    await env.DB.prepare(
      `INSERT INTO books (title, original_title, author, language_pair, styles, uuid, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        processedBook.metadata.title,
        processedBook.metadata.originalTitle,
        processedBook.metadata.author,
        processedBook.metadata.languagePair,
        processedBook.metadata.styles,
        bookUuid,
        user.id
      )
      .run();

    // Get book ID
    const book = await env.DB.prepare('SELECT id FROM books WHERE uuid = ?')
      .bind(bookUuid)
      .first();

    if (!book) {
      throw new Error('Failed to create book');
    }

    const bookId = book.id as number;

    // Insert chapters and content items
    for (const chapter of processedBook.chapters) {
      // Insert chapter
      await env.DB.prepare(
        `INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          bookId,
          chapter.number,
          chapter.translatedTitle,
          chapter.originalTitle,
          chapter.number
        )
        .run();

      // Get chapter ID
      const chapterRow = await env.DB.prepare(
        'SELECT id FROM chapters WHERE book_id = ? AND chapter_number = ?'
      )
        .bind(bookId, chapter.number)
        .first();

      if (!chapterRow) continue;

      const chapterId = chapterRow.id as number;

      // Insert content items
      for (let i = 0; i < chapter.content.length; i++) {
        const item = chapter.content[i];
        await env.DB.prepare(
          `INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, tag_name, class_name, styles, order_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            bookId,
            chapterId,
            item.id,
            item.originalText,
            item.translatedText,
            item.type,
            item.tagName || 'p',
            item.className || '',
            item.styles || '',
            i + 1
          )
          .run();
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        bookUuid,
        message: 'Book uploaded and processed successfully',
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Book upload error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('Error stack:', errorStack);

    return new Response(
      JSON.stringify({
        error: 'Failed to process book',
        details: errorMessage,
        stack: errorStack,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
      try {
        // ==================
        // Auth endpoints
        // ==================

        // Start Google OAuth flow
        if (url.pathname === '/api/auth/google') {
          return handleGoogleAuthStart(env);
        }

        // Handle Google OAuth callback
        if (url.pathname === '/api/auth/callback/google') {
          return handleGoogleCallback(request, env);
        }

        // Get current user
        if (url.pathname === '/api/auth/me') {
          return handleGetCurrentUser(request, env);
        }

        // Logout
        if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
          return handleLogout(request, env);
        }

        // ==================
        // Book endpoints
        // ==================

        // Handle book upload
        if (url.pathname === '/api/books/upload' && request.method === 'POST') {
          return handleBookUpload(request, env);
        }

        // Handle books list endpoint
        if (url.pathname === '/api/books') {
          const user = await getCurrentUser(env.DB, request);
          const books = await getAllBooks(env.DB, user?.id);
          return new Response(JSON.stringify(books), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Extract book UUID from API path: /api/book/:uuid/...
        const apiMatch = url.pathname.match(/^\/api\/book\/([^\/]+)\/(.+)$/);
        if (apiMatch) {
          const bookUuid = apiMatch[1];
          const endpoint = apiMatch[2];

          if (endpoint === 'content') {
            const bookData = await getBookWithContent(env.DB, bookUuid);

            // Transform database result to match the original JSON structure
            const response = {
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
            };

            return new Response(JSON.stringify(response), {
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
            const chapterData = await getChapterContent(
              env.DB,
              chapterNumber,
              bookUuid
            );

            // Transform database result to match the original JSON structure
            const response = {
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
            };

            return new Response(JSON.stringify(response), {
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
          // Verify book exists
          const book = await env.DB.prepare(
            'SELECT uuid FROM books WHERE uuid = ?'
          )
            .bind(bookUuid)
            .first();
          if (book) {
            // Serve React app for valid book UUIDs
            try {
              return env.ASSETS.fetch(
                new Request(new URL('/index.html', request.url))
              );
            } catch (error) {
              return new Response(
                `
                <!DOCTYPE html>
                <html>
                  <head>
                    <title>Ovid - Reading ${bookUuid}</title>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                  </head>
                  <body>
                    <div id="root">Loading book ${bookUuid}...</div>
                  </body>
                </html>
              `,
                {
                  headers: { 'Content-Type': 'text/html' },
                }
              );
            }
          } else {
            return new Response('Book not found', { status: 404 });
          }
        } catch (error) {
          return new Response('Database error', { status: 500 });
        }
      }
    }

    // Handle root URL - serve React app
    if (url.pathname === '/') {
      try {
        return env.ASSETS.fetch(
          new Request(new URL('/index.html', request.url))
        );
      } catch (error) {
        return new Response(
          `
          <!DOCTYPE html>
          <html>
            <head>
              <title>Ovid - Library</title>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body>
              <div id="root">Loading Ovid library...</div>
            </body>
          </html>
        `,
          {
            headers: { 'Content-Type': 'text/html' },
          }
        );
      }
    }

    // Serve static assets
    try {
      // Try to fetch the asset first
      const asset = await env.ASSETS.fetch(request);

      // If asset found, return it
      if (asset.status !== 404) {
        return asset;
      }

      // Return 404 for actual missing files
      return new Response('Not found', { status: 404 });
    } catch (error) {
      // Fallback if ASSETS is not available (local dev)
      return new Response('Asset not found', { status: 404 });
    }
  },
};

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_URL: string; // e.g., https://lib.jrd.pub
  OPENAI_API_KEY: string;
  OPENAI_API_BASE_URL?: string;
  OPENAI_MODEL?: string;
}
