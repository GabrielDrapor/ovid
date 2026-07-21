import { describe, it, expect } from 'vitest';
import { pickMostRecentRead } from '../../src/components/shelf3d/layout';

const book = (uuid: string, status: string | null = 'ready') => ({
  uuid,
  status,
});
const progress = (entries: Array<[string, string | null]>) =>
  new Map(entries.map(([uuid, last_read_at]) => [uuid, { last_read_at }]));

describe('pickMostRecentRead', () => {
  it('picks the book with the latest last_read_at', () => {
    const books = [book('a'), book('b'), book('c')];
    const p = progress([
      ['a', '2026-07-01 10:00:00'],
      ['b', '2026-07-19 08:30:00'],
      ['c', '2026-03-11 22:15:00'],
    ]);
    expect(pickMostRecentRead(books, p)).toBe('b');
  });

  it('ignores books without progress or without last_read_at', () => {
    const books = [book('a'), book('b'), book('c')];
    const p = progress([
      ['a', null],
      ['c', '2026-01-01 00:00:00'],
    ]);
    expect(pickMostRecentRead(books, p)).toBe('c');
  });

  it('ignores progress rows for books not on the shelf', () => {
    const books = [book('a')];
    const p = progress([
      ['a', '2026-01-01 00:00:00'],
      ['ghost', '2026-07-19 09:00:00'],
    ]);
    expect(pickMostRecentRead(books, p)).toBe('a');
  });

  it('skips books that are still importing', () => {
    const books = [book('a', 'processing'), book('b')];
    const p = progress([
      ['a', '2026-07-19 09:00:00'],
      ['b', '2026-07-01 09:00:00'],
    ]);
    expect(pickMostRecentRead(books, p)).toBe('b');
  });

  it('returns null when nothing has been read', () => {
    expect(pickMostRecentRead([book('a')], progress([]))).toBeNull();
    expect(
      pickMostRecentRead([], progress([['a', '2026-01-01 00:00:00']]))
    ).toBeNull();
  });

  it('breaks exact-timestamp ties deterministically (smaller uuid wins)', () => {
    const books = [book('b'), book('a')];
    const p = progress([
      ['a', '2026-07-19 09:00:00'],
      ['b', '2026-07-19 09:00:00'],
    ]);
    expect(pickMostRecentRead(books, p)).toBe('a');
  });
});
