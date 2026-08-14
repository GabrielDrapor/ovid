import { describe, it, expect, vi } from 'vitest';
import { getChapterContentV2 } from '../../../src/worker/db';

/**
 * Stale-chapter resilience: after a chapter-structure repair renumbers a
 * book, clients may request a chapter number that no longer exists (cached
 * reading position). The reader must get the nearest valid chapter back —
 * with its real chapter_number so the client re-syncs — instead of a 404
 * that bricks the whole book page.
 */
function makeDb(existingChapters: number[]) {
  const chapterRows = new Map(
    existingChapters.map((n) => [
      n,
      { id: 1000 + n, chapter_number: n, title: `第${n}章`, original_title: `Ch ${n}`, raw_html: '<p>x</p>', order_index: n },
    ])
  );
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM books_v2')) return { id: 7, uuid: 'u' };
          if (sql.includes('chapter_number = ?')) return chapterRows.get(params[1] as number) ?? null;
          if (sql.includes('chapter_number <= ?')) {
            const candidates = existingChapters.filter((n) => n <= (params[1] as number));
            return candidates.length ? chapterRows.get(Math.max(...candidates)) : null;
          }
          if (sql.includes('ORDER BY chapter_number ASC')) {
            return existingChapters.length ? chapterRows.get(Math.min(...existingChapters)) : null;
          }
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    })),
  } as unknown as D1Database;
}

describe('getChapterContentV2 stale-chapter clamp', () => {
  it('returns the exact chapter when it exists', async () => {
    const result = await getChapterContentV2(makeDb([1, 2, 3]), 2, 'u');
    expect(result.chapter.chapter_number).toBe(2);
  });

  it('clamps a too-large stale number down to the nearest valid chapter', async () => {
    // The Mixer scenario: book renumbered 66→42, client cached ch 43
    const result = await getChapterContentV2(makeDb([1, 2, 42]), 43, 'u');
    expect(result.chapter.chapter_number).toBe(42);
  });

  it('clamps a gap up to the first chapter when nothing is below', async () => {
    const result = await getChapterContentV2(makeDb([5, 6]), 2, 'u');
    expect(result.chapter.chapter_number).toBe(5);
  });

  it('still throws when the book has no chapters at all', async () => {
    await expect(getChapterContentV2(makeDb([]), 1, 'u')).rejects.toThrow('Chapter not found');
  });
});
