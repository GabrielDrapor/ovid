// Pure layout math for the 3D closet view. All sizes are in world units
// where one book is BOOK_HEIGHT tall.
//
// The wall is a grid of uniform bays (columns) and shelf rows. Books fill
// bays left-to-right, top row first; the rendered wall always adds one ring
// of empty bays around the content, so the closet looks like it has room to
// grow no matter how many books there are.

export const BOOK_HEIGHT = 1;
export const BOOK_DEPTH = 0.7;
export const BOOK_GAP = 0.006;
export const ROW_HEIGHT = 1.26;

/** Inner width of a single bay. */
export const BAY_INNER = 2.35;
/** Thickness of the vertical dividers between bays. */
export const DIVIDER_T = 0.11;
/** Horizontal distance between bay centers. */
export const BAY_PITCH = BAY_INNER + DIVIDER_T;
/** Content never grows wider than this many bays; it wraps to a new row. */
export const MAX_CONTENT_COLS = 4;

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
  /** Horizontal center of the book in wall coordinates (wall center = 0). */
  x: number;
  /** Content row index, 0 = top content row (the empty ring is excluded). */
  row: number;
  width: number;
}

export interface ShelfLayout {
  placements: PlacedBook[];
  /** Rows/columns actually holding books. */
  contentRows: number;
  contentCols: number;
  /** Full wall grid: content plus one ring of empty bays. */
  totalRows: number;
  totalCols: number;
  /** Inner width of the whole wall (totalCols bays plus dividers). */
  wallWidth: number;
}

/**
 * Pack books into uniform bays. Public books fill bays first; user books
 * always start on a fresh row. Each bay's run of books is centered within
 * the bay.
 */
export function layoutBooks(
  books: { uuid: string; user_id: number | null }[],
  ratios: Map<string, number>,
  bayInner: number = BAY_INNER,
  maxCols: number = MAX_CONTENT_COLS
): ShelfLayout {
  const groups = [
    books.filter((b) => !b.user_id),
    books.filter((b) => !!b.user_id),
  ].filter((g) => g.length > 0);

  interface Slot {
    uuid: string;
    width: number;
    /** Center offset of the book within its bay's left-aligned run. */
    offset: number;
    row: number;
    col: number;
  }

  const slots: Slot[] = [];
  let row = 0;
  let col = 0;
  let cursor = 0;
  let maxColUsed = -1;
  let started = false;

  for (const group of groups) {
    if (started) {
      // Each group (public / user books) starts on a fresh row.
      row++;
      col = 0;
      cursor = 0;
    }
    for (const book of group) {
      started = true;
      const w = spineWidth(ratios.get(book.uuid));
      // Epsilon keeps a bay that exactly fits from wrapping on float noise.
      if (cursor + w > bayInner + 1e-6 && cursor > 0) {
        col++;
        cursor = 0;
        if (col >= maxCols) {
          col = 0;
          row++;
        }
      }
      slots.push({
        uuid: book.uuid,
        width: w,
        offset: cursor + w / 2,
        row,
        col,
      });
      maxColUsed = Math.max(maxColUsed, col);
      cursor += w + BOOK_GAP;
    }
  }

  const contentRows = slots.length > 0 ? row + 1 : 0;
  const contentCols = slots.length > 0 ? maxColUsed + 1 : 0;
  const totalRows = contentRows > 0 ? contentRows + 2 : 0;
  const totalCols = contentCols > 0 ? contentCols + 2 : 0;
  const pitch = bayInner + DIVIDER_T;
  const wallWidth = totalCols * pitch + DIVIDER_T;

  // Width of each bay's run and how many bays each row uses.
  const runWidth = new Map<string, number>();
  const rowBays = new Map<number, Set<number>>();
  for (const s of slots) {
    const key = `${s.row}:${s.col}`;
    runWidth.set(key, Math.max(runWidth.get(key) ?? 0, s.offset + s.width / 2));
    if (!rowBays.has(s.row)) rowBays.set(s.row, new Set());
    rowBays.get(s.row)!.add(s.col);
  }

  const placements: PlacedBook[] = slots.map((s) => {
    // Content col c sits at global col c+1 (ring offset).
    const bayCenter = (s.col + 1 + 0.5 - totalCols / 2) * pitch;
    // A row that fills several bays reads as one continuous run, so its
    // books stay left-aligned; a lone bay looks better centered.
    if ((rowBays.get(s.row)?.size ?? 1) > 1) {
      return {
        uuid: s.uuid,
        width: s.width,
        row: s.row,
        x: bayCenter - bayInner / 2 + s.offset,
      };
    }
    const run = runWidth.get(`${s.row}:${s.col}`) ?? 0;
    return {
      uuid: s.uuid,
      width: s.width,
      row: s.row,
      x: bayCenter + s.offset - run / 2,
    };
  });

  return {
    placements,
    contentRows,
    contentCols,
    totalRows,
    totalCols,
    wallWidth,
  };
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
