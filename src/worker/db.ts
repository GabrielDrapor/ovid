/**
 * Database query functions (V2 - XPath-based)
 */

export async function getAllBooksV2(db: D1Database) {
  const books = await db
    .prepare(
      `SELECT id, uuid, title, original_title, author, language_pair,
              book_cover_img_url, book_spine_img_url, user_id,
              status, created_at, updated_at
       FROM books_v2
       ORDER BY created_at DESC`
    )
    .all();

  return books.results;
}

export async function getBookStatus(db: D1Database, bookUuid: string): Promise<string | null> {
  const book = await db.prepare('SELECT status FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();
  return book ? (book.status as string) : null;
}

export async function updateBookStatus(db: D1Database, bookUuid: string, status: string): Promise<void> {
  await db.prepare('UPDATE books_v2 SET status = ? WHERE uuid = ?')
    .bind(status, bookUuid)
    .run();
}

/**
 * Insert book metadata and chapters (with raw HTML) but no translations.
 * Used for async upload: book appears on shelf immediately while translating in background.
 */
export async function insertBookShellV2(
  db: D1Database,
  bookData: {
    title: string;
    originalTitle: string;
    author: string;
    languagePair: string;
    styles: string;
    chapters: Array<{
      number: number;
      title: string;
      originalTitle: string;
      rawHtml: string;
    }>;
  },
  bookUuid: string,
  userId?: number
): Promise<number> {
  await db.prepare(
    `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, user_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`
  )
    .bind(
      bookUuid,
      bookData.title,
      bookData.originalTitle,
      bookData.author,
      bookData.languagePair,
      bookData.styles,
      userId ?? null
    )
    .run();

  const book = await db.prepare('SELECT id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) throw new Error('Failed to create book');
  const bookId = book.id as number;

  for (const chapter of bookData.chapters) {
    const rawHtmlSize = chapter.rawHtml ? new TextEncoder().encode(chapter.rawHtml).length : 0;
    const shouldStoreRawHtml = rawHtmlSize < 50000;

    if (shouldStoreRawHtml) {
      await db.prepare(
        `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, raw_html, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(bookId, chapter.number, chapter.title, chapter.originalTitle, chapter.rawHtml, chapter.number).run();
    } else {
      await db.prepare(
        `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, order_index)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(bookId, chapter.number, chapter.title, chapter.originalTitle, chapter.number).run();
    }
  }

  return bookId;
}

/**
 * Insert translations for a single chapter (used during background translation)
 */
export async function insertChapterTranslationsV2(
  db: D1Database,
  bookId: number,
  chapterNumber: number,
  translatedTitle: string,
  textNodes: Array<{ xpath: string; text: string; html: string; orderIndex: number }>,
  translations: Map<string, string>
): Promise<void> {
  // Update chapter title with translation
  await db.prepare(
    `UPDATE chapters_v2 SET title = ? WHERE book_id = ? AND chapter_number = ?`
  ).bind(translatedTitle, bookId, chapterNumber).run();

  const chapterRow = await db.prepare(
    'SELECT id FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?'
  ).bind(bookId, chapterNumber).first();

  if (!chapterRow) return;
  const chapterId = chapterRow.id as number;

  for (const node of textNodes) {
    const translatedText = translations.get(node.xpath) || node.text;
    await db.prepare(
      `INSERT INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(chapterId, node.xpath, node.text, node.html, translatedText, node.orderIndex).run();
  }
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

// ==================
// Translation Job functions
// ==================

export interface TranslationJob {
  id: number;
  book_id: number;
  book_uuid: string;
  source_language: string;
  target_language: string;
  total_chapters: number;
  completed_chapters: number;
  current_chapter: number;
  current_item_offset: number;
  glossary_json: string | null;
  glossary_extracted: number;
  title_translated: number;
  translated_title: string | null;
  status: string;
  error_message: string | null;
}

export async function createTranslationJob(
  db: D1Database,
  bookId: number,
  bookUuid: string,
  sourceLang: string,
  targetLang: string,
  totalChapters: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO translation_jobs (book_id, book_uuid, source_language, target_language, total_chapters, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  ).bind(bookId, bookUuid, sourceLang, targetLang, totalChapters).run();
}

export async function getTranslationJob(db: D1Database, bookUuid: string): Promise<TranslationJob | null> {
  const row = await db.prepare(
    'SELECT * FROM translation_jobs WHERE book_uuid = ? LIMIT 1'
  ).bind(bookUuid).first();
  return row as TranslationJob | null;
}

export async function updateTranslationJob(
  db: D1Database,
  bookUuid: string,
  updates: Partial<Pick<TranslationJob,
    'status' | 'current_chapter' | 'current_item_offset' | 'completed_chapters' |
    'glossary_json' | 'glossary_extracted' | 'title_translated' | 'translated_title' | 'error_message'
  >>
): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');

  values.push(bookUuid);
  await db.prepare(
    `UPDATE translation_jobs SET ${fields.join(', ')} WHERE book_uuid = ?`
  ).bind(...values).run();
}

export async function storeChapterTextNodes(
  db: D1Database,
  bookId: number,
  chapterNumber: number,
  textNodesJson: string
): Promise<void> {
  await db.prepare(
    'UPDATE chapters_v2 SET text_nodes_json = ? WHERE book_id = ? AND chapter_number = ?'
  ).bind(textNodesJson, bookId, chapterNumber).run();
}

export async function getChapterTextNodes(
  db: D1Database,
  bookId: number,
  chapterNumber: number
): Promise<Array<{ xpath: string; text: string; html: string; orderIndex: number }> | null> {
  const row = await db.prepare(
    'SELECT text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?'
  ).bind(bookId, chapterNumber).first();

  if (!row || !row.text_nodes_json) return null;
  return JSON.parse(row.text_nodes_json as string);
}

export async function getChapterIdByNumber(
  db: D1Database,
  bookId: number,
  chapterNumber: number
): Promise<number | null> {
  const row = await db.prepare(
    'SELECT id FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?'
  ).bind(bookId, chapterNumber).first();
  return row ? (row.id as number) : null;
}

export async function insertTranslationRow(
  db: D1Database,
  chapterId: number,
  xpath: string,
  originalText: string,
  originalHtml: string,
  translatedText: string,
  orderIndex: number
): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(chapterId, xpath, originalText, originalHtml, translatedText, orderIndex).run();
}

export async function updateChapterTitle(
  db: D1Database,
  bookId: number,
  chapterNumber: number,
  translatedTitle: string
): Promise<void> {
  await db.prepare(
    'UPDATE chapters_v2 SET title = ? WHERE book_id = ? AND chapter_number = ?'
  ).bind(translatedTitle, bookId, chapterNumber).run();
}

export async function clearTextNodesJson(db: D1Database, bookId: number): Promise<void> {
  await db.prepare(
    'UPDATE chapters_v2 SET text_nodes_json = NULL WHERE book_id = ?'
  ).bind(bookId).run();
}

export async function deleteTranslationJob(db: D1Database, bookUuid: string): Promise<void> {
  await db.prepare('DELETE FROM translation_jobs WHERE book_uuid = ?')
    .bind(bookUuid).run();
}
