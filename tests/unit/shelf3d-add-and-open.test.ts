import { describe, expect, it } from 'vitest';
import {
  BAY_PITCH,
  ROW_HEIGHT,
  layoutBooks,
  narrowOpeningView,
  pickAddBookTarget,
  rowYCenters,
  targetsBesideOwnBooks,
} from '../../src/components/shelf3d/layout';

const ratios = new Map<string, number>();

// A 3×3 block: a public row on top, then the viewer's own bay at (1,1) and
// another reader-free bay at (2,0).
const slots = [
  { id: 1, row: 0, col: 0, is_public: 1 },
  { id: 2, row: 0, col: 1, is_public: 1 },
  { id: 3, row: 0, col: 2, is_public: 1 },
  { id: 4, row: 1, col: 1 },
  { id: 5, row: 2, col: 0 },
];
const book = (
  uuid: string,
  slot: number,
  row: number,
  col: number,
  user_id: number | null
) => ({
  uuid,
  user_id,
  shelf_slot_id: slot,
  shelf_row: row,
  shelf_col: col,
  shelf_position: 1,
});
const books = [
  book('pub-a', 1, 0, 0, null),
  book('pub-b', 2, 0, 1, null),
  book('pub-c', 3, 0, 2, null),
  book('mine', 4, 1, 1, 7),
  book('other', 5, 2, 0, 7),
];
const layout = layoutBooks(books, ratios, undefined, undefined, slots);

describe('where Add book puts a new book', () => {
  it('goes next to your own books', () => {
    const target = pickAddBookTarget(layout, new Set(['mine']));
    expect(target).toMatchObject({ rowCoord: 1, colCoord: 1, shelfSlotId: 4 });
  });

  it('without books of your own, takes the first empty bay inside the wall', () => {
    const target = pickAddBookTarget(layout, new Set());
    // (1,0) is the first empty, non-public bay in reading order.
    expect(target).toMatchObject({ rowCoord: 1, colCoord: 0 });
  });

  it('never picks a public bay', () => {
    const target = pickAddBookTarget(layout, new Set(['pub-a']));
    expect(target?.rowCoord).not.toBe(0);
  });

  it('keeps the plus visible only in bays that hold your books', () => {
    const keys = targetsBesideOwnBooks(layout, new Set(['mine', 'other'])).map(
      (t) => `${t.rowCoord}:${t.colCoord}`
    );
    expect(keys).toEqual(['1:1', '2:0']);
    expect(targetsBesideOwnBooks(layout, new Set())).toEqual([]);
  });
});

describe('opening view on narrow screens', () => {
  const rowCenters = rowYCenters(layout.totalRows);
  const tanHalf = Math.tan((38 / 2) * (Math.PI / 180));
  const phone = { aspect: 375 / 812, tanHalf, minZoom: 2.5, maxZoom: 11 };
  const bayCenter = (visualCol: number) =>
    (visualCol + 0.5 - layout.totalCols / 2) * BAY_PITCH;

  it('keeps the normal framing when the filled bays fit', () => {
    const desktop = { ...phone, aspect: 1920 / 1080 };
    expect(narrowOpeningView(layout, rowCenters, desktop, null)).toBeNull();
  });

  it('frames one whole bay on a phone instead of the gap between two', () => {
    const view = narrowOpeningView(layout, rowCenters, phone, null)!;
    expect(view).not.toBeNull();
    // First book in reading order is pub-a, in the first content column.
    expect(view.x).toBeCloseTo(bayCenter(1), 6);
    // Exactly one bay wide, plus a small margin.
    const visibleW = 2 * tanHalf * view.z * phone.aspect;
    expect(visibleW).toBeGreaterThan(BAY_PITCH);
    expect(visibleW).toBeLessThan(BAY_PITCH * 1.25);
  });

  it('sits on the rows that hold books in that bay', () => {
    const view = narrowOpeningView(layout, rowCenters, phone, null)!;
    // Column 1 holds books in content rows 0 and 2 → centered between them.
    const mid = (rowCenters[0 + 1] + rowCenters[2 + 1]) / 2;
    expect(view.y).toBeCloseTo(mid, 6);
    const visibleH = 2 * tanHalf * view.z;
    expect(rowCenters[1] + ROW_HEIGHT / 2).toBeLessThanOrEqual(
      view.y + visibleH / 2
    );
  });

  it('opens on the last-read book', () => {
    const view = narrowOpeningView(layout, rowCenters, phone, 'mine')!;
    expect(view.x).toBeCloseTo(bayCenter(2), 6);
    expect(view.y).toBeCloseTo(rowCenters[1 + 1], 6);
  });

  it('shows two whole bays on a tablet held upright', () => {
    const tablet = { ...phone, aspect: 768 / 1024 };
    const view = narrowOpeningView(layout, rowCenters, tablet, null)!;
    // Bays 1 and 2: the camera sits on the divider between them.
    expect(view.x).toBeCloseTo((bayCenter(1) + bayCenter(2)) / 2, 6);
    const visibleW = 2 * tanHalf * view.z * tablet.aspect;
    expect(visibleW).toBeGreaterThan(2 * BAY_PITCH);
    expect(visibleW).toBeLessThan(2 * BAY_PITCH * 1.15);
  });
});
