/**
 * Database query functions (V2 - XPath-based)
 */

export async function getAllBooksV2(db: D1Database) {
  const books = await db
    .prepare(
      `SELECT id, uuid, title, original_title, author, language_pair,
              book_cover_img_url, book_spine_img_url, user_id,
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

/**
 * Delete a book and all its chapters/translations from V2 tables
 */
export async function deleteBookV2(db: D1Database, bookUuid: string): Promise<void> {
  const book = await db.prepare('SELECT id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Book not found');
  }

  const bookId = book.id as number;

  // Delete translations for all chapters of this book
  await db.prepare(
    `DELETE FROM translations_v2 WHERE chapter_id IN (SELECT id FROM chapters_v2 WHERE book_id = ?)`
  ).bind(bookId).run();

  // Delete chapters
  await db.prepare('DELETE FROM chapters_v2 WHERE book_id = ?')
    .bind(bookId).run();

  // Delete the book
  await db.prepare('DELETE FROM books_v2 WHERE id = ?')
    .bind(bookId).run();
}

/**
 * Insert a processed book into V2 database tables (XPath-based)
 */
export async function insertProcessedBookV2(
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
      title: string;
      originalTitle: string;
      translatedTitle: string;
      rawHtml: string;
      textNodes: Array<{
        xpath: string;
        text: string;
        html: string;
        orderIndex: number;
      }>;
      translations: Map<string, string>; // xpath -> translated text
    }>;
  },
  bookUuid: string,
  userId?: number
): Promise<number> {
  const translatedBookTitle = processedBook.metadata.title;

  // Insert book metadata into books_v2
  await db.prepare(
    `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      bookUuid,
      translatedBookTitle,
      processedBook.metadata.originalTitle,
      processedBook.metadata.author,
      processedBook.metadata.languagePair,
      processedBook.metadata.styles,
      userId ?? null
    )
    .run();

  // Get book ID
  const book = await db.prepare('SELECT id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Failed to create book');
  }

  const bookId = book.id as number;

  // Insert chapters and translations
  for (const chapter of processedBook.chapters) {
    // Insert chapter into chapters_v2
    // Skip rawHtml if too large (D1 has statement size limits)
    const rawHtmlSize = chapter.rawHtml ? new TextEncoder().encode(chapter.rawHtml).length : 0;
    const shouldStoreRawHtml = rawHtmlSize < 50000; // 50KB limit

    if (shouldStoreRawHtml) {
      await db.prepare(
        `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, raw_html, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          bookId,
          chapter.number,
          chapter.translatedTitle,
          chapter.originalTitle,
          chapter.rawHtml,
          chapter.number
        )
        .run();
    } else {
      await db.prepare(
        `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index)
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
    }

    // Get chapter ID
    const chapterRow = await db.prepare(
      'SELECT id FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?'
    )
      .bind(bookId, chapter.number)
      .first();

    if (!chapterRow) continue;

    const chapterId = chapterRow.id as number;

    // Insert translations
    for (const node of chapter.textNodes) {
      const translatedText = chapter.translations.get(node.xpath) || node.text;

      await db.prepare(
        `INSERT INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          chapterId,
          node.xpath,
          node.text,
          node.html,
          translatedText,
          node.orderIndex
        )
        .run();
    }
  }

  return bookId;
}
