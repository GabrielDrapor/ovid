import { describe, it, expect } from 'vitest';
import {
  BOOK_GAP,
  DEFAULT_SPINE_RATIO,
  MAX_SPINE_RATIO,
  MIN_SPINE_RATIO,
  clampSpineRatio,
  layoutBooks,
  rowYCenters,
  spineWidth,
} from '../../../src/components/shelf3d/layout';

const book = (uuid: string, user_id: number | null = null) => ({
  uuid,
  user_id,
});

describe('clampSpineRatio', () => {
  it('clamps into [MIN, MAX]', () => {
    expect(clampSpineRatio(0.001)).toBe(MIN_SPINE_RATIO);
    expect(clampSpineRatio(2)).toBe(MAX_SPINE_RATIO);
    expect(clampSpineRatio(0.2)).toBe(0.2);
  });

  it('falls back to the default for invalid input', () => {
    expect(clampSpineRatio(NaN)).toBe(DEFAULT_SPINE_RATIO);
    expect(clampSpineRatio(-1)).toBe(DEFAULT_SPINE_RATIO);
    expect(clampSpineRatio(0)).toBe(DEFAULT_SPINE_RATIO);
  });
});

describe('spineWidth', () => {
  it('uses the default ratio when undefined', () => {
    expect(spineWidth(undefined)).toBeCloseTo(DEFAULT_SPINE_RATIO);
  });

  it('scales with height', () => {
    expect(spineWidth(0.2, 2)).toBeCloseTo(0.4);
  });
});

describe('layoutBooks', () => {
  it('returns an empty layout for no books', () => {
    const { placements, rowCount } = layoutBooks([], new Map());
    expect(placements).toHaveLength(0);
    expect(rowCount).toBe(0);
  });

  it('puts public and user books on separate rows', () => {
    const { placements, rowCount } = layoutBooks(
      [book('pub-1'), book('pub-2'), book('mine-1', 7)],
      new Map()
    );
    expect(rowCount).toBe(2);
    const byUuid = new Map(placements.map((p) => [p.uuid, p]));
    expect(byUuid.get('pub-1')!.row).toBe(0);
    expect(byUuid.get('pub-2')!.row).toBe(0);
    expect(byUuid.get('mine-1')!.row).toBe(1);
  });

  it('skips the public row entirely when there are no public books', () => {
    const { placements, rowCount } = layoutBooks(
      [book('mine-1', 7), book('mine-2', 7)],
      new Map()
    );
    expect(rowCount).toBe(1);
    expect(placements.every((p) => p.row === 0)).toBe(true);
  });

  it('centers each row around x = 0', () => {
    const { placements } = layoutBooks(
      [book('a'), book('b'), book('c')],
      new Map()
    );
    const xs = placements.map((p) => p.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(mid).toBeCloseTo(0, 5);
  });

  it('places books side by side with the configured gap', () => {
    const { placements } = layoutBooks([book('a'), book('b')], new Map());
    const [a, b] = placements;
    const edgeToEdge = b.x - b.width / 2 - (a.x + a.width / 2);
    expect(edgeToEdge).toBeCloseTo(BOOK_GAP, 5);
  });

  it('wraps to a new row when a shelf overflows', () => {
    const wide = new Map<string, number>();
    const books = Array.from({ length: 10 }, (_, i) => {
      wide.set(`b${i}`, MAX_SPINE_RATIO);
      return book(`b${i}`);
    });
    // 10 books * 0.35 width each = 3.5 world units; force a tiny shelf
    const { placements, rowCount } = layoutBooks(books, wide, 1.0);
    expect(rowCount).toBeGreaterThan(1);
    // Every placement still fits inside the shelf width
    for (const p of placements) {
      expect(Math.abs(p.x) + p.width / 2).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  it('uses measured spine ratios for width', () => {
    const ratios = new Map([['a', 0.3]]);
    const { placements } = layoutBooks([book('a')], ratios);
    expect(placements[0].width).toBeCloseTo(0.3);
  });
});

describe('rowYCenters', () => {
  it('is symmetric around zero', () => {
    expect(rowYCenters(1)).toEqual([0]);
    const two = rowYCenters(2, 1.5);
    expect(two[0]).toBeCloseTo(0.75);
    expect(two[1]).toBeCloseTo(-0.75);
  });

  it('orders rows top to bottom', () => {
    const three = rowYCenters(3);
    expect(three[0]).toBeGreaterThan(three[1]);
    expect(three[1]).toBeGreaterThan(three[2]);
  });
});
