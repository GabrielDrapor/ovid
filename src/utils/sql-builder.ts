/**
 * SQL Builder for book import
 * Generates SQL statements for importing translated books into D1
 */

import type { TranslatedChapter } from './book-processor';

export interface BookMetadata {
  title: string;
  originalTitle?: string;
  author: string;
  languagePair: string;
  styles?: string;
}

export interface SqlBuilderOptions {
  bookUuid: string;
  metadata: BookMetadata;
  chapters: TranslatedChapter[];
  userId?: number | null;
}

/**
 * Escape SQL string values
 */
export function escapeSql(text: string): string {
  if (!text) return '';
  return text.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/**
 * Build complete SQL for importing a translated book
 */
export function buildBookImportSql(options: SqlBuilderOptions): string {
  const { bookUuid, metadata, chapters, userId } = options;
  const lines: string[] = [];

  lines.push('-- Ovid book import SQL');
  lines.push(`-- Book: ${metadata.title}`);
  lines.push(`-- UUID: ${bookUuid}`);
  lines.push('');

  // Insert book
  const userIdValue = userId !== null && userId !== undefined ? userId.toString() : 'NULL';
  lines.push(
    `INSERT INTO books (title, original_title, author, language_pair, styles, uuid, user_id) VALUES (` +
    `'${escapeSql(metadata.title)}', ` +
    `'${escapeSql(metadata.originalTitle || metadata.title)}', ` +
    `'${escapeSql(metadata.author)}', ` +
    `'${escapeSql(metadata.languagePair)}', ` +
    `'${escapeSql(metadata.styles || '')}', ` +
    `'${bookUuid}', ` +
    `${userIdValue});`
  );

  const bookIdExpr = `(SELECT id FROM books WHERE uuid='${bookUuid}')`;

  // Insert chapters
  lines.push('');
  lines.push('-- Chapters');
  for (const chapter of chapters) {
    lines.push(
      `INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) VALUES (` +
      `${bookIdExpr}, ` +
      `${chapter.number}, ` +
      `'${escapeSql(chapter.translatedTitle)}', ` +
      `'${escapeSql(chapter.originalTitle)}', ` +
      `${chapter.number});`
    );
  }

  // Insert content items
  lines.push('');
  lines.push('-- Content items');
  let globalContentOrder = 1;

  for (const chapter of chapters) {
    const chapterIdExpr = `(SELECT id FROM chapters WHERE book_id=${bookIdExpr} AND chapter_number=${chapter.number})`;

    for (const item of chapter.content) {
      const itemType = item.type ? escapeSql(item.type) : 'paragraph';
      const tagName = item.tagName
        ? escapeSql(item.tagName)
        : item.type === 'chapter' ? 'h3' : 'p';
      const className = item.className ? escapeSql(item.className) : '';
      const itemStyles = item.styles ? escapeSql(item.styles) : '';

      lines.push(
        `INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, tag_name, class_name, styles, order_index) VALUES (` +
        `${bookIdExpr}, ` +
        `${chapterIdExpr}, ` +
        `'${escapeSql(item.id)}', ` +
        `'${escapeSql(item.originalText)}', ` +
        `'${escapeSql(item.translatedText)}', ` +
        `'${itemType}', ` +
        `'${tagName}', ` +
        `'${className}', ` +
        `'${itemStyles}', ` +
        `${globalContentOrder});`
      );
      globalContentOrder++;
    }
  }

  return lines.join('\n');
}

/**
 * Build SQL for a single chapter (useful for incremental imports)
 */
export function buildChapterSql(
  bookIdExpr: string,
  chapter: TranslatedChapter,
  startOrderIndex: number = 1
): string {
  const lines: string[] = [];

  // Insert chapter
  lines.push(
    `INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index) VALUES (` +
    `${bookIdExpr}, ` +
    `${chapter.number}, ` +
    `'${escapeSql(chapter.translatedTitle)}', ` +
    `'${escapeSql(chapter.originalTitle)}', ` +
    `${chapter.number});`
  );

  const chapterIdExpr = `(SELECT id FROM chapters WHERE book_id=${bookIdExpr} AND chapter_number=${chapter.number})`;
  let orderIndex = startOrderIndex;

  for (const item of chapter.content) {
    const itemType = item.type ? escapeSql(item.type) : 'paragraph';
    const tagName = item.tagName
      ? escapeSql(item.tagName)
      : item.type === 'chapter' ? 'h3' : 'p';

    lines.push(
      `INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, tag_name, class_name, styles, order_index) VALUES (` +
      `${bookIdExpr}, ` +
      `${chapterIdExpr}, ` +
      `'${escapeSql(item.id)}', ` +
      `'${escapeSql(item.originalText)}', ` +
      `'${escapeSql(item.translatedText)}', ` +
      `'${itemType}', ` +
      `'${tagName}', ` +
      `'${escapeSql(item.className || '')}', ` +
      `'${escapeSql(item.styles || '')}', ` +
      `${orderIndex});`
    );
    orderIndex++;
  }

  return lines.join('\n');
}
