/**
 * Database query functions
 */

// ==================
// V1 Database Functions (DEPRECATED)
// These functions use the old books/chapters/content_items tables.
// Use V2 functions below instead, which use XPath-based translations.
// ==================

/**
 * @deprecated Use V2 API instead
 */
export async function getBookWithContent(db: D1Database, bookUuid: string) {
  const book = await db
    .prepare('SELECT * FROM books WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Book not found');
  }

  const contentItems = await db
    .prepare(
      `SELECT ci.*, c.chapter_number, c.title as chapter_title, c.original_title as chapter_original_title
       FROM content_items ci
       LEFT JOIN chapters c ON ci.chapter_id = c.id
       WHERE ci.book_id = ?
       ORDER BY ci.order_index ASC`
    )
    .bind(book.id)
    .all();

  return { book, content: contentItems.results };
}

/**
 * @deprecated Use getBookChaptersV2 instead
 */
export async function getBookChapters(db: D1Database, bookUuid: string) {
  const book = await db
    .prepare('SELECT id FROM books WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Book not found');
  }

  const chapters = await db
    .prepare(
      `SELECT id, chapter_number, title, original_title, order_index
       FROM chapters
       WHERE book_id = ?
       ORDER BY order_index ASC`
    )
    .bind(book.id)
    .all();

  return chapters.results;
}

/**
 * @deprecated Use getChapterContentV2 instead
 */
export async function getChapterContent(
  db: D1Database,
  chapterNumber: number,
  bookUuid: string
) {
  const book = await db
    .prepare('SELECT * FROM books WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Book not found');
  }

  // Handle chapter 0 (title page)
  if (chapterNumber === 0) {
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

  const chapter = await db
    .prepare(
      `SELECT * FROM chapters
       WHERE book_id = ? AND chapter_number = ?`
    )
    .bind(book.id, chapterNumber)
    .first();

  if (!chapter) {
    throw new Error('Chapter not found');
  }

  const contentItems = await db
    .prepare(
      `SELECT ci.*
       FROM content_items ci
       WHERE ci.book_id = ? AND ci.chapter_id = ?
       ORDER BY ci.order_index ASC`
    )
    .bind(book.id, chapter.id)
    .all();

  const items: any[] = Array.isArray((contentItems as any).results)
    ? (contentItems as any).results.slice()
    : [];

  // Ensure chapter title item exists
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

  return { book, chapter, content: items };
}

/**
 * @deprecated Use getAllBooksV2 instead
 */
export async function getAllBooks(db: D1Database, userId?: number) {
  let query: string;
  let params: any[] = [];

  if (userId) {
    query = `
      SELECT id, uuid, title, original_title, author, language_pair, book_cover_img_url, book_spine_img_url, created_at, updated_at
      FROM books
      WHERE user_id IS NULL OR user_id = ?
      ORDER BY created_at DESC
    `;
    params = [userId];
  } else {
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

/**
 * Insert a processed book into the database
 */
// ==================
// V2 Database Functions (XPath-based)
// ==================

export async function getAllBooksV2(db: D1Database) {
  const books = await db
    .prepare(
      `SELECT id, uuid, title, original_title, author, language_pair,
              book_cover_img_url, book_spine_img_url,
              created_at, updated_at
       FROM books_v2
       ORDER BY created_at DESC`
    )
    .all();

  return books.results;
}

export async function getBookChaptersV2(db: D1Database, bookUuid: string) {
  const book = await db
    .prepare('SELECT id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Book not found');
  }

  const chapters = await db
    .prepare(
      `SELECT id, chapter_number, title, original_title, order_index
       FROM chapters_v2
       WHERE book_id = ?
       ORDER BY order_index ASC`
    )
    .bind(book.id)
    .all();

  return chapters.results;
}

export async function getChapterContentV2(
  db: D1Database,
  chapterNumber: number,
  bookUuid: string
) {
  const book = await db
    .prepare('SELECT * FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Book not found');
  }

  const chapter = await db
    .prepare(
      `SELECT id, chapter_number, title, original_title, raw_html, order_index
       FROM chapters_v2
       WHERE book_id = ? AND chapter_number = ?`
    )
    .bind(book.id, chapterNumber)
    .first();

  if (!chapter) {
    throw new Error('Chapter not found');
  }

  const translations = await db
    .prepare(
      `SELECT xpath, original_text, original_html, translated_text, order_index
       FROM translations_v2
       WHERE chapter_id = ?
       ORDER BY order_index ASC`
    )
    .bind(chapter.id)
    .all();

  // Get raw_html from database or construct from translations
  let rawHtml = (chapter as any).raw_html;

  // If raw_html is not available (too large during import), construct from translations
  if (!rawHtml || rawHtml.length === 0) {
    // XPath format: /body[1]/p[1] (element-level, no text() suffix)
    // Use original_html if available to preserve formatting
    rawHtml = translations.results.map((t: any) => {
      const match = t.xpath.match(/\/([a-z0-9]+)\[\d+\]$/i);
      const tagName = match ? match[1] : 'p';
      const content = t.original_html || t.original_text;
      return `<${tagName} data-xpath="${t.xpath}">${content}</${tagName}>`;
    }).join('\n');
  }

  return {
    book,
    chapter,
    rawHtml,
    translations: translations.results,
  };
}

export async function insertProcessedBook(
  db: D1Database,
  processedBook: {
    metadata: {
      title: string;
      originalTitle: string;
      author: string;
      languagePair: string;
      styles: string;
    };
    chapters: Array<{
      number: number;
      translatedTitle: string;
      originalTitle: string;
      content: Array<{
        id: string;
        originalText: string;
        translatedText: string;
        type: string;
        tagName?: string;
        className?: string;
        styles?: string;
      }>;
    }>;
  },
  bookUuid: string,
  userId: number
): Promise<number> {
  // Insert book metadata
  await db.prepare(
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
      userId
    )
    .run();

  // Get book ID
  const book = await db.prepare('SELECT id FROM books WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Failed to create book');
  }

  const bookId = book.id as number;

  // Insert chapters and content items
  for (const chapter of processedBook.chapters) {
    await db.prepare(
      `INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(bookId, chapter.number, chapter.translatedTitle, chapter.originalTitle, chapter.number)
      .run();

    const chapterRow = await db.prepare(
      'SELECT id FROM chapters WHERE book_id = ? AND chapter_number = ?'
    )
      .bind(bookId, chapter.number)
      .first();

    if (!chapterRow) continue;

    const chapterId = chapterRow.id as number;

    for (let i = 0; i < chapter.content.length; i++) {
      const item = chapter.content[i];
      await db.prepare(
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

  return bookId;
}
