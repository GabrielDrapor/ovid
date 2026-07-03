import { describe, it, expect } from 'vitest';
import {
  BAY_INNER,
  BAY_PITCH,
  BOOK_GAP,
  DEFAULT_SPINE_RATIO,
  DIVIDER_T,
  MAX_CONTENT_COLS,
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

describe('layoutBooks (bay grid)', () => {
  it('returns an empty layout for no books', () => {
    const layout = layoutBooks([], new Map());
    expect(layout.placements).toHaveLength(0);
    expect(layout.contentRows).toBe(0);
    expect(layout.contentCols).toBe(0);
    expect(layout.totalRows).toBe(0);
    expect(layout.totalCols).toBe(0);
  });

  it('adds one ring of empty bays around the content', () => {
    const layout = layoutBooks([book('a'), book('b')], new Map());
    expect(layout.contentRows).toBe(1);
    expect(layout.contentCols).toBe(1);
    expect(layout.totalRows).toBe(3);
    expect(layout.totalCols).toBe(3);
    expect(layout.wallWidth).toBeCloseTo(3 * BAY_PITCH + DIVIDER_T);
  });

  it('keeps a small run inside one bay, centered around the wall middle', () => {
    const layout = layoutBooks([book('a'), book('b'), book('c')], new Map());
    const xs = layout.placements.map((p) => p.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(mid).toBeCloseTo(0, 5);
    // Everything fits well inside the single center bay
    for (const p of layout.placements) {
      expect(Math.abs(p.x) + p.width / 2).toBeLessThanOrEqual(BAY_INNER / 2);
    }
  });

  it('places books side by side with the configured gap', () => {
    const layout = layoutBooks([book('a'), book('b')], new Map());
    const [a, b] = layout.placements;
    const edgeToEdge = b.x - b.width / 2 - (a.x + a.width / 2);
    expect(edgeToEdge).toBeCloseTo(BOOK_GAP, 5);
  });

  it('overflows into the next bay when one fills up', () => {
    const wide = new Map<string, number>();
    const books = Array.from({ length: 10 }, (_, i) => {
      wide.set(`b${i}`, MAX_SPINE_RATIO);
      return book(`b${i}`);
    });
    // 10 * 0.35 = 3.5 > BAY_INNER, so at least two bays are needed
    const layout = layoutBooks(books, wide);
    expect(layout.contentCols).toBeGreaterThan(1);
    expect(layout.contentRows).toBe(1);
    // No book crosses a divider: each stays within its bay's inner width
    const pitch = BAY_PITCH;
    for (const p of layout.placements) {
      const bayIndex = Math.round(
        p.x / pitch + (layout.totalCols % 2 === 0 ? 0.5 : 0)
      );
      const bayCenter =
        (bayIndex - (layout.totalCols % 2 === 0 ? 0.5 : 0)) * pitch;
      expect(Math.abs(p.x - bayCenter) + p.width / 2).toBeLessThanOrEqual(
        BAY_INNER / 2 + 1e-6
      );
    }
  });

  it('wraps to a new row past MAX_CONTENT_COLS', () => {
    const wide = new Map<string, number>();
    // Enough wide books to fill more than MAX_CONTENT_COLS bays
    const perBay = Math.floor(BAY_INNER / MAX_SPINE_RATIO);
    const count = perBay * (MAX_CONTENT_COLS + 1);
    const books = Array.from({ length: count }, (_, i) => {
      wide.set(`b${i}`, MAX_SPINE_RATIO);
      return book(`b${i}`);
    });
    const layout = layoutBooks(books, wide);
    expect(layout.contentCols).toBe(MAX_CONTENT_COLS);
    expect(layout.contentRows).toBeGreaterThan(1);
  });

  it('starts user books on a fresh row', () => {
    const layout = layoutBooks(
      [book('pub-1'), book('pub-2'), book('mine-1', 7)],
      new Map()
    );
    const byUuid = new Map(layout.placements.map((p) => [p.uuid, p]));
    expect(byUuid.get('pub-1')!.row).toBe(0);
    expect(byUuid.get('pub-2')!.row).toBe(0);
    expect(byUuid.get('mine-1')!.row).toBe(1);
    expect(layout.contentRows).toBe(2);
    expect(layout.totalRows).toBe(4);
  });

  it('uses measured spine ratios for width', () => {
    const ratios = new Map([['a', 0.3]]);
    const layout = layoutBooks([book('a')], ratios);
    expect(layout.placements[0].width).toBeCloseTo(0.3);
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
