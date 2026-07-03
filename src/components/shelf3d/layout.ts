// Pure layout math for the 3D closet view. All sizes are in world units
// where one book is BOOK_HEIGHT tall.

export const BOOK_HEIGHT = 1;
export const BOOK_DEPTH = 0.7;
export const BOOK_GAP = 0.006;
export const SHELF_INNER_WIDTH = 6.9;
export const ROW_HEIGHT = 1.26;

export const DEFAULT_SPINE_RATIO = 1 / 5.3;
export const MIN_SPINE_RATIO = 0.04;
export const MAX_SPINE_RATIO = 0.35;

export function clampSpineRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_SPINE_RATIO;
  return Math.min(MAX_SPINE_RATIO, Math.max(MIN_SPINE_RATIO, ratio));
}

export function spineWidth(
  ratio: number | undefined,
  height: number = BOOK_HEIGHT
): number {
  return clampSpineRatio(ratio ?? DEFAULT_SPINE_RATIO) * height;
}

export interface PlacedBook {
  uuid: string;
  /** Horizontal center of the book, relative to the bookcase center. */
  x: number;
  /** Shelf row index, 0 = top row. */
  row: number;
  width: number;
}

export interface ShelfLayout {
  placements: PlacedBook[];
  rowCount: number;
  /** Widest row's content width — the bookcase is sized to hug this. */
  caseWidth: number;
}

/**
 * Pack books onto shelves. Public books fill the top rows; user books always
 * start on a fresh row (mirroring the classic two-row shelf). Each row's
 * content is centered horizontally.
 *
 * The shelf width adapts to the collection: with only a handful of books the
 * bookcase hugs them tightly instead of leaving metres of empty board.
 */
export function layoutBooks(
  books: { uuid: string; user_id: number | null }[],
  ratios: Map<string, number>,
  innerWidth: number = SHELF_INNER_WIDTH
): ShelfLayout {
  const groups = [
    books.filter((b) => !b.user_id),
    books.filter((b) => !!b.user_id),
  ].filter((g) => g.length > 0);

  // Adaptive shelf width: spread each group over as few rows as fit in
  // innerWidth, then shrink the shelf to the width those rows actually need.
  let effectiveWidth = 0;
  for (const group of groups) {
    const total =
      group.reduce((sum, b) => sum + spineWidth(ratios.get(b.uuid)), 0) +
      BOOK_GAP * (group.length - 1);
    const rowsNeeded = Math.max(1, Math.ceil(total / innerWidth));
    const perRow = total / rowsNeeded + (rowsNeeded > 1 ? 0.35 : 0);
    effectiveWidth = Math.max(effectiveWidth, perRow);
  }
  effectiveWidth = Math.min(Math.max(effectiveWidth, 1.2), innerWidth);

  const placements: PlacedBook[] = [];
  let row = 0;
  let caseWidth = 0;

  for (const group of groups) {
    let cursor = 0;
    let rowStart = placements.length;

    const finishRow = () => {
      const contentWidth = cursor - BOOK_GAP;
      caseWidth = Math.max(caseWidth, contentWidth);
      for (let i = rowStart; i < placements.length; i++) {
        placements[i].x -= contentWidth / 2;
      }
    };

    for (const book of group) {
      const w = spineWidth(ratios.get(book.uuid));
      // Epsilon keeps a row that exactly fits from wrapping on float noise.
      if (cursor + w > effectiveWidth + 1e-6 && cursor > 0) {
        finishRow();
        row++;
        cursor = 0;
        rowStart = placements.length;
      }
      placements.push({ uuid: book.uuid, x: cursor + w / 2, row, width: w });
      cursor += w + BOOK_GAP;
    }
    finishRow();
    row++;
  }

  return { placements, rowCount: row, caseWidth };
}

/** Vertical center of each row, rows stacked symmetrically around y = 0. */
export function rowYCenters(
  rowCount: number,
  rowHeight: number = ROW_HEIGHT
): number[] {
  const centers: number[] = [];
  for (let i = 0; i < rowCount; i++) {
    centers.push(((rowCount - 1) / 2 - i) * rowHeight);
  }
  return centers;
}
