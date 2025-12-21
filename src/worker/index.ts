// Database query functions
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

async function getAllBooks(db: D1Database) {
  const books = await db
    .prepare(
      `
    SELECT id, uuid, title, original_title, author, language_pair, created_at, updated_at
    FROM books
    ORDER BY created_at DESC
  `
    )
    .all();

  return books.results;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
      try {
        // Handle books list endpoint
        if (url.pathname === '/api/books') {
          const books = await getAllBooks(env.DB);
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
}
