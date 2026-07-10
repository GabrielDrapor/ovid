/**
 * Database query functions (V2 - XPath-based)
 */

export async function getAllBooksV2(db: D1Database, userId?: number) {
  let query = `SELECT b.id, b.uuid, b.title, b.original_title, b.author, b.language_pair,
              b.book_cover_img_url, b.book_spine_img_url, b.user_id,
              b.status, b.display_order, b.created_at, b.updated_at,
              COALESCE(ss.shelf_id, bs.shelf_id) AS shelf_id,
              COALESCE(bss.position, bs.position) AS shelf_position,
              ss.id AS shelf_slot_id,
              ss.row AS shelf_row,
              ss.col AS shelf_col,
              ss.sort_order AS shelf_slot_order,
              ss.label AS shelf_slot_label
       FROM books_v2 b
       LEFT JOIN book_shelf_slots bss ON bss.book_id = b.id
       LEFT JOIN shelf_slots ss ON ss.id = bss.slot_id
       LEFT JOIN book_shelves bs ON bs.book_id = b.id`;
  
  if (userId) {
    query += ` WHERE b.user_id IS NULL OR b.user_id = ?`;
  } else {
    query += ` WHERE b.user_id IS NULL`;
  }
  
  query += ` ORDER BY
    CASE WHEN ss.id IS NOT NULL THEN 0 WHEN bs.shelf_id IS NOT NULL THEN 1 ELSE 2 END ASC,
    COALESCE(ss.shelf_id, bs.shelf_id, CASE WHEN b.user_id IS NULL THEN '00-public' ELSE '90-user' END) ASC,
    COALESCE(ss.sort_order, 9999) ASC,
    COALESCE(bss.position, bs.position, b.display_order, 0) ASC,
    b.display_order ASC,
    b.created_at ASC`;
  
  const stmt = db.prepare(query);
  const books = userId ? await stmt.bind(userId).all() : await stmt.all();

  return books.results;
}

export async function getShelfSlots(db: D1Database, shelfId = 'main') {
  const slots = await db.prepare(
    `SELECT id, shelf_id, row, col, sort_order, label, is_public
       FROM shelf_slots
       WHERE shelf_id = ?
       ORDER BY sort_order ASC, row ASC, col ASC`
  ).bind(shelfId).all();

  return slots.results;
}

/**
 * Look up an existing shelf slot by id or (row, col), creating one if a
 * (row, col) target doesn't have a slot yet. Retries a few times to ride out
 * races with other requests creating the same coordinate concurrently.
 */
export async function resolveOrCreateShelfSlot(
  db: D1Database,
  target: { slotId?: number | null; row?: number | null; col?: number | null } | null,
  shelfId = 'main'
): Promise<number | null> {
  if (!target) return null;

  const hasCoords =
    target.row !== null && target.row !== undefined &&
    target.col !== null && target.col !== undefined;

  if (target.slotId) {
    // Validate the caller-supplied id: it must exist on this shelf and, when
    // coordinates were also sent, match them — a stale client layout could
    // otherwise attach the book to an unrelated slot.
    const slot = await db.prepare(
      'SELECT id, row, col FROM shelf_slots WHERE id = ? AND shelf_id = ? LIMIT 1'
    )
      .bind(target.slotId, shelfId)
      .first<{ id: number; row: number; col: number }>();
    if (
      slot &&
      (!hasCoords || (slot.row === target.row && slot.col === target.col))
    ) {
      return slot.id;
    }
    // Stale or mismatched id — fall through to coordinate resolution.
  }

  if (!hasCoords) return null;

  const findShelfSlot = () =>
    db.prepare(
      'SELECT id FROM shelf_slots WHERE shelf_id = ? AND row = ? AND col = ? LIMIT 1'
    )
      .bind(shelfId, target.row, target.col)
      .first<{ id: number }>();

  const existing = await findShelfSlot();
  if (existing) return existing.id;

  for (let attempt = 0; attempt < 3; attempt++) {
    const orderRow = await db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM shelf_slots WHERE shelf_id = ?"
    ).bind(shelfId).first<{ next_order: number }>();
    try {
      await db.prepare(
        `INSERT INTO shelf_slots (shelf_id, row, col, sort_order, label)
         VALUES (?, ?, ?, ?, NULL)`
      )
        .bind(shelfId, target.row, target.col, orderRow?.next_order ?? 0)
        .run();
    } catch {
      // Another request may have created this coordinate or sort_order.
    }
    const slot = await findShelfSlot();
    if (slot) return slot.id;
  }

  throw new Error('Failed to create shelf slot');
}

/**
 * Move a user's own book to a new shelf slot, inserting it at `insertIndex`
 * among the target slot's existing books (dragged book excluded). Runs as a
 * single db.batch() so the renumber + upsert commit atomically.
 */
export async function moveBookToSlot(
  db: D1Database,
  bookUuid: string,
  userId: number,
  target: { slotId?: number | null; row?: number | null; col?: number | null },
  insertIndex: number
): Promise<{ shelfSlotId: number; position: number }> {
  const book = await db.prepare('SELECT id, user_id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first<{ id: number; user_id: number | null }>();

  if (!book) {
    throw new Error('Book not found');
  }
  if (book.user_id === null || book.user_id !== userId) {
    throw new Error('Forbidden: you can only move your own books');
  }

  const bookId = book.id;

  // Public shelves (the seeded Gutenberg collection) are locked: reject
  // moving a book out of one...
  const sourceSlot = await db.prepare(
    `SELECT ss.is_public FROM book_shelf_slots bss
     JOIN shelf_slots ss ON ss.id = bss.slot_id
     WHERE bss.book_id = ?`
  )
    .bind(bookId)
    .first<{ is_public: number }>();
  if (sourceSlot?.is_public) {
    throw new Error('Forbidden: books cannot be moved off a public shelf');
  }

  const targetSlotId = await resolveOrCreateShelfSlot(db, target);
  if (targetSlotId === null) {
    throw new Error('Invalid target');
  }

  // ...and reject moving a book onto one.
  const targetSlot = await db.prepare(
    'SELECT is_public FROM shelf_slots WHERE id = ?'
  )
    .bind(targetSlotId)
    .first<{ is_public: number }>();
  if (targetSlot?.is_public) {
    throw new Error('Forbidden: books cannot be moved onto a public shelf');
  }

  const siblingsResult = await db.prepare(
    'SELECT book_id, position FROM book_shelf_slots WHERE slot_id = ? AND book_id != ? ORDER BY position ASC, book_id ASC'
  )
    .bind(targetSlotId, bookId)
    .all<{ book_id: number; position: number }>();
  const siblings = siblingsResult.results ?? [];

  const clamped = Math.max(0, Math.min(insertIndex, siblings.length));
  // Land at the position currently held by the sibling at insertIndex (or one
  // past the last sibling), shifting everything at/after it right by one in a
  // single UPDATE. Gaps left behind are fine — ordering is relative — and
  // keeping the batch to two statements means concurrent moves into the same
  // slot degrade to slightly-off ordering instead of stomping a full renumber.
  const newPosition =
    clamped < siblings.length
      ? siblings[clamped].position
      : siblings.length > 0
        ? siblings[siblings.length - 1].position + 1
        : 0;

  await db.batch([
    db.prepare(
      'UPDATE book_shelf_slots SET position = position + 1 WHERE slot_id = ? AND position >= ? AND book_id != ?'
    ).bind(targetSlotId, newPosition, bookId),
    db.prepare(
      `INSERT INTO book_shelf_slots (book_id, slot_id, position) VALUES (?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET slot_id = excluded.slot_id, position = excluded.position`
    ).bind(bookId, targetSlotId, newPosition),
  ]);

  return { shelfSlotId: targetSlotId, position: newPosition };
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
  // Auto-assign display_order to append after existing books
  const maxOrder = await db.prepare(
    'SELECT COALESCE(MAX(display_order), 0) as max_order FROM books_v2'
  ).first();
  const nextOrder = ((maxOrder?.max_order as number) || 0) + 1;

  await db.prepare(
    `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, user_id, status, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)`
  )
    .bind(
      bookUuid,
      bookData.title,
      bookData.originalTitle,
      bookData.author,
      bookData.languagePair,
      bookData.styles,
      userId ?? null,
      nextOrder
    )
    .run();

  const book = await db.prepare('SELECT id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) throw new Error('Failed to create book');
  const bookId = book.id as number;

  for (const chapter of bookData.chapters) {
    await db.prepare(
      `INSERT INTO chapters_v2 (book_id, chapter_number, title, original_title, raw_html, order_index)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(bookId, chapter.number, chapter.title, chapter.originalTitle, chapter.rawHtml, chapter.number).run();
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

/**
 * Check if a user can access a book.
 * Returns { accessible: true, book } if the book is public (user_id IS NULL) or owned by the user.
 * Returns { accessible: false } if the book doesn't exist or is private and not owned by the user.
 */
export async function checkBookAccess(
  db: D1Database,
  bookUuid: string,
  userId?: number
): Promise<{ accessible: boolean; book?: any }> {
  const book = await db
    .prepare('SELECT id, uuid, user_id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    return { accessible: false };
  }

  // Public book (user_id IS NULL) — anyone can access
  if (book.user_id === null) {
    return { accessible: true, book };
  }

  // Private book — only the owner can access
  if (userId && book.user_id === userId) {
    return { accessible: true, book };
  }

  return { accessible: false };
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
      let content = t.original_html || t.original_text;
      // Strip internal <a> links from EPUB content — keep only their inner text
      // Internal links (non-http) cause unwanted navigation when clicked
      content = content.replace(
        /<a\s+[^>]*href\s*=\s*["'](?!https?:\/\/)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
        '$1'
      );
      // Also remove self-closing anchor tags (e.g. <a id="..." class="..."/>)
      content = content.replace(/<a\s+[^>]*\/>/gi, '');
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
export async function deleteBookV2(db: D1Database, bookUuid: string, userId: number): Promise<void> {
  const book = await db.prepare('SELECT id, user_id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid)
    .first();

  if (!book) {
    throw new Error('Book not found');
  }

  // Only the owner can delete their book; public books (user_id IS NULL) cannot be deleted via API
  if (book.user_id === null || book.user_id !== userId) {
    throw new Error('Forbidden: you can only delete your own books');
  }

  const bookId = book.id as number;

  await db.prepare('DELETE FROM book_shelf_slots WHERE book_id = ?')
    .bind(bookId).run();
  await db.prepare('DELETE FROM book_shelves WHERE book_id = ?')
    .bind(bookId).run();

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

  // Auto-assign display_order to append after existing books
  const maxOrderRow = await db.prepare(
    'SELECT COALESCE(MAX(display_order), 0) as max_order FROM books_v2'
  ).first();
  const nextDisplayOrder = ((maxOrderRow?.max_order as number) || 0) + 1;

  // Insert book metadata into books_v2
  await db.prepare(
    `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, styles, user_id, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      bookUuid,
      translatedBookTitle,
      processedBook.metadata.originalTitle,
      processedBook.metadata.author,
      processedBook.metadata.languagePair,
      processedBook.metadata.styles,
      userId ?? null,
      nextDisplayOrder
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
    // Insert chapter into chapters_v2 (always store raw_html)
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

/**
 * User reading progress for a book (supports both public and user-uploaded books)
 */
export interface UserBookProgress {
  id: number;
  user_id: number;
  book_uuid: string;
  is_completed: number; // 0 or 1
  reading_progress: number | null; // 0-100, for future use
  chapter_number: number | null; // Current chapter
  paragraph_xpath: string | null; // XPath of current paragraph for cross-device sync
  show_original: number; // 1 = show original text, 0 = show translation
  completed_at: string | null;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Upsert user's reading progress for a book
 */
export async function upsertUserBookProgress(
  db: D1Database,
  userId: number,
  bookUuid: string,
  isCompleted: boolean,
  readingProgress?: number
): Promise<void> {
  const isCompletedInt = isCompleted ? 1 : 0;
  const progress = readingProgress ?? null;
  
  await db.prepare(
    `INSERT INTO user_book_progress (user_id, book_uuid, is_completed, reading_progress, last_read_at,
       completed_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP,
       CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
     ON CONFLICT(user_id, book_uuid) DO UPDATE SET
       is_completed = ?,
       reading_progress = CASE WHEN ? IS NOT NULL THEN ? ELSE reading_progress END,
       completed_at = CASE
         WHEN ? = 1 THEN COALESCE(user_book_progress.completed_at, CURRENT_TIMESTAMP)
         WHEN ? = 0 THEN NULL
         ELSE user_book_progress.completed_at
       END,
       last_read_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(userId, bookUuid, isCompletedInt, progress, isCompletedInt, isCompletedInt, progress, progress, isCompletedInt, isCompletedInt)
    .run();
}

/**
 * Update reading_progress (and optionally chapter/xpath) without touching is_completed or completed_at
 */
export async function updateReadingProgress(
  db: D1Database,
  userId: number,
  bookUuid: string,
  readingProgress: number,
  chapterNumber?: number,
  paragraphXpath?: string,
  showOriginal?: boolean
): Promise<void> {
  // Try to update existing row first
  // Always overwrite chapter_number and paragraph_xpath (no COALESCE) to avoid
  // stale xpath data when the user switches chapters before a paragraph is observed.
  // show_original is COALESCE'd so scroll-triggered saves don't clobber the user's toggle.
  const showOriginalParam = showOriginal === undefined ? null : (showOriginal ? 1 : 0);
  const result = await db.prepare(
    `UPDATE user_book_progress
     SET reading_progress = ?,
         chapter_number = ?,
         paragraph_xpath = ?,
         show_original = COALESCE(?, show_original),
         last_read_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND book_uuid = ?`
  ).bind(readingProgress, chapterNumber ?? null, paragraphXpath ?? null, showOriginalParam, userId, bookUuid).run();

  // If no row existed, insert one
  if (!result.meta.changes || result.meta.changes === 0) {
    await db.prepare(
      `INSERT INTO user_book_progress (user_id, book_uuid, is_completed, reading_progress, chapter_number, paragraph_xpath, show_original, last_read_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(userId, bookUuid, readingProgress, chapterNumber ?? null, paragraphXpath ?? null, showOriginalParam ?? 1).run();
  }
}

/**
 * Get all reading progress for a user (batch)
 */
export async function getAllUserBookProgress(
  db: D1Database,
  userId: number
): Promise<UserBookProgress[]> {
  const rows = await db.prepare(
    `SELECT * FROM user_book_progress WHERE user_id = ?`
  ).bind(userId).all();
  return rows.results as UserBookProgress[];
}

/**
 * Get user's reading progress for a specific book
 */
// ==================
// Share token functions
// ==================

/**
 * Generate and store a share token for a book (owner only)
 */
export async function createShareToken(
  db: D1Database,
  bookUuid: string,
  userId: number
): Promise<string> {
  const book = await db.prepare('SELECT id, user_id, share_token FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid).first();

  if (!book) throw new Error('Book not found');
  if (book.user_id !== userId) throw new Error('Forbidden');

  // Return existing token if already shared
  if (book.share_token) return book.share_token as string;

  const token = crypto.randomUUID();
  await db.prepare('UPDATE books_v2 SET share_token = ? WHERE uuid = ?')
    .bind(token, bookUuid).run();
  return token;
}

/**
 * Get share token for a book (owner only)
 */
export async function getShareToken(
  db: D1Database,
  bookUuid: string,
  userId: number
): Promise<string | null> {
  const book = await db.prepare('SELECT user_id, share_token FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid).first();

  if (!book) throw new Error('Book not found');
  if (book.user_id !== userId) throw new Error('Forbidden');

  return (book.share_token as string) || null;
}

/**
 * Revoke share token for a book (owner only)
 */
export async function revokeShareToken(
  db: D1Database,
  bookUuid: string,
  userId: number
): Promise<void> {
  const book = await db.prepare('SELECT id, user_id FROM books_v2 WHERE uuid = ?')
    .bind(bookUuid).first();

  if (!book) throw new Error('Book not found');
  if (book.user_id !== userId) throw new Error('Forbidden');

  await db.prepare('UPDATE books_v2 SET share_token = NULL WHERE uuid = ?')
    .bind(bookUuid).run();
}

/**
 * Get book by share token (for unauthenticated access)
 */
export async function getBookByShareToken(
  db: D1Database,
  token: string
): Promise<{ id: number; uuid: string } | null> {
  const book = await db.prepare('SELECT id, uuid FROM books_v2 WHERE share_token = ?')
    .bind(token).first();
  return book ? { id: book.id as number, uuid: book.uuid as string } : null;
}

export async function getUserBookProgress(
  db: D1Database,
  userId: number,
  bookUuid: string
): Promise<UserBookProgress | null> {
  const row = await db.prepare(
    `SELECT * FROM user_book_progress WHERE user_id = ? AND book_uuid = ?`
  )
    .bind(userId, bookUuid)
    .first();
  return row as UserBookProgress | null;
}
