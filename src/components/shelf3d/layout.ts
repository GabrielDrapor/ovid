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
export const UPLOAD_PLACEHOLDER_WIDTH = DEFAULT_SPINE_RATIO;

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

export interface PlacedShelfLabel {
  key: string;
  text: string;
  /** Left edge of the label plane in wall coordinates. */
  left: number;
  /** Content row index, 0 = top content row (the empty ring is excluded). */
  row: number;
}

export interface PlacedUploadTarget {
  shelfSlotId?: number | null;
  rowCoord: number;
  colCoord: number;
  label?: string | null;
  /**
   * Row relative to the content grid. The empty visual ring uses -1 above
   * the content and contentRows below it.
   */
  row: number;
  /** Center of the placeholder spine in wall coordinates. */
  x: number;
  width: number;
  /** Invisible hit area covering the usable remaining shelf space. */
  hitX: number;
  hitWidth: number;
}

export interface ShelfLayout {
  placements: PlacedBook[];
  slotLabels: PlacedShelfLabel[];
  uploadTargets: PlacedUploadTarget[];
  /** Rows/columns actually holding books. */
  contentRows: number;
  contentCols: number;
  /** Full wall grid: content plus one ring of empty bays. */
  totalRows: number;
  totalCols: number;
  /** Inner width of the whole wall (totalCols bays plus dividers). */
  wallWidth: number;
}

type LayoutBook = {
  uuid: string;
  user_id: number | null;
  shelf_id?: string | null;
  shelf_position?: number | null;
  shelf_row?: number | null;
  shelf_col?: number | null;
  shelf_slot_id?: number | null;
  shelf_slot_order?: number | null;
  shelf_slot_label?: string | null;
  display_order?: number | null;
};

type LayoutShelfSlot = {
  id: number;
  shelf_id?: string | null;
  row: number;
  col: number;
  sort_order?: number | null;
  label?: string | null;
};

/**
 * Pack books into uniform bays. Public books fill bays first; user books
 * always start on a fresh row. Each bay's run of books is centered within
 * the bay.
 */
export function layoutBooks(
  books: LayoutBook[],
  ratios: Map<string, number>,
  bayInner: number = BAY_INNER,
  maxCols: number = MAX_CONTENT_COLS,
  shelfSlots: LayoutShelfSlot[] = []
): ShelfLayout {
  if (
    shelfSlots.length > 0 ||
    books.some(
      (book) =>
        Number.isFinite(book.shelf_row) && Number.isFinite(book.shelf_col)
    )
  ) {
    return layoutPhysicalSlots(books, ratios, bayInner, shelfSlots);
  }

  return layoutLegacyBooks(books, ratios, bayInner, maxCols);
}

function groupKey(book: LayoutBook) {
  if (book.shelf_id) return book.shelf_id;
  return book.user_id ? '90-user' : '00-public';
}

function orderValue(book: LayoutBook) {
  return book.shelf_position ?? book.display_order ?? 0;
}

function sortBooks(a: LayoutBook, b: LayoutBook) {
  const byPosition = orderValue(a) - orderValue(b);
  if (byPosition !== 0) return byPosition;
  return a.uuid.localeCompare(b.uuid);
}

function layoutLegacyBooks(
  books: LayoutBook[],
  ratios: Map<string, number>,
  bayInner: number,
  maxCols: number
): ShelfLayout {
  const groupForBook = (book: LayoutBook) => {
    if (book.shelf_id) return book.shelf_id;
    return book.user_id ? '90-user' : '00-public';
  };

  const grouped = new Map<string, LayoutBook[]>();
  for (const book of books) {
    const key = groupForBook(book);
    const group = grouped.get(key);
    if (group) group.push(book);
    else grouped.set(key, [book]);
  }
  const groups = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => group.slice().sort(sortBooks))
    .filter((g) => g.length > 0);

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
    slotLabels: [],
    uploadTargets: [],
    contentRows,
    contentCols,
    totalRows,
    totalCols,
    wallWidth,
  };
}

interface PhysicalRun {
  rowCoord: number;
  colCoord: number;
  slotId?: number | null;
  label?: string | null;
  books: LayoutBook[];
}

function layoutPhysicalSlots(
  books: LayoutBook[],
  ratios: Map<string, number>,
  bayInner: number,
  shelfSlots: LayoutShelfSlot[]
): ShelfLayout {
  const runMap = new Map<string, PhysicalRun>();
  const unplaced: LayoutBook[] = [];

  for (const slot of shelfSlots) {
    if (
      !Number.isFinite(slot.id) ||
      !Number.isFinite(slot.row) ||
      !Number.isFinite(slot.col)
    ) {
      continue;
    }
    const rowCoord = Number(slot.row);
    const colCoord = Number(slot.col);
    const key = `${rowCoord}:${colCoord}`;
    if (!runMap.has(key)) {
      runMap.set(key, {
        rowCoord,
        colCoord,
        slotId: Number(slot.id),
        label: slot.label?.trim() || null,
        books: [],
      });
    }
  }

  const addToRun = (rowCoord: number, colCoord: number, book: LayoutBook) => {
    const key = `${rowCoord}:${colCoord}`;
    let run = runMap.get(key);
    if (!run) {
      run = { rowCoord, colCoord, books: [] };
      runMap.set(key, run);
    }
    if (Number.isFinite(book.shelf_slot_id)) {
      run.slotId = Number(book.shelf_slot_id);
    }
    if (!run.label && book.shelf_slot_label?.trim()) {
      run.label = book.shelf_slot_label.trim();
    }
    run.books.push(book);
  };

  for (const book of books) {
    if (Number.isFinite(book.shelf_row) && Number.isFinite(book.shelf_col)) {
      addToRun(Number(book.shelf_row), Number(book.shelf_col), book);
    } else {
      unplaced.push(book);
    }
  }

  for (const run of Array.from(runMap.values())) {
    run.books.sort(sortBooks);
  }

  if (unplaced.length > 0) {
    const occupied = new Set(runMap.keys());
    const grouped = new Map<string, LayoutBook[]>();
    for (const book of unplaced) {
      const key = groupKey(book);
      const group = grouped.get(key);
      if (group) group.push(book);
      else grouped.set(key, [book]);
    }

    for (const [, group] of Array.from(grouped.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      let currentRun: PhysicalRun | null = null;
      let cursor = 0;
      for (const book of group.slice().sort(sortBooks)) {
        const w = spineWidth(ratios.get(book.uuid));
        if (!currentRun || (cursor + w > bayInner + 1e-6 && cursor > 0)) {
          const [rowCoord, colCoord] = nextCenterOutCoord(occupied);
          currentRun = { rowCoord, colCoord, books: [] };
          runMap.set(`${rowCoord}:${colCoord}`, currentRun);
          occupied.add(`${rowCoord}:${colCoord}`);
          cursor = 0;
        }
        currentRun.books.push(book);
        cursor += w + BOOK_GAP;
      }
    }
  }

  const runs = Array.from(runMap.values());
  if (runs.length === 0) {
    return {
      placements: [],
      slotLabels: [],
      uploadTargets: [],
      contentRows: 0,
      contentCols: 0,
      totalRows: 0,
      totalCols: 0,
      wallWidth: 0,
    };
  }

  const minRow = Math.min(...runs.map((run) => run.rowCoord));
  const maxRow = Math.max(...runs.map((run) => run.rowCoord));
  const minCol = Math.min(...runs.map((run) => run.colCoord));
  const maxCol = Math.max(...runs.map((run) => run.colCoord));
  const contentRows = maxRow - minRow + 1;
  const contentCols = maxCol - minCol + 1;
  const totalRows = contentRows + 2;
  const totalCols = contentCols + 2;
  const pitch = bayInner + DIVIDER_T;
  const wallWidth = totalCols * pitch + DIVIDER_T;

  const placements: PlacedBook[] = [];
  const slotLabels: PlacedShelfLabel[] = [];
  for (const run of runs) {
    const row = run.rowCoord - minRow;
    const col = run.colCoord - minCol;
    const bayCenter = (col + 1 + 0.5 - totalCols / 2) * pitch;
    const widths = run.books.map((book) => spineWidth(ratios.get(book.uuid)));
    const bayLeft = bayCenter - bayInner / 2;
    const labelText =
      run.label ??
      run.books
        .map((book) => book.shelf_slot_label?.trim())
        .find((label): label is string => !!label);

    if (labelText) {
      slotLabels.push({
        key: `${run.rowCoord}:${run.colCoord}:${labelText}`,
        text: labelText,
        left: bayLeft + 0.08,
        row,
      });
    }

    let cursor = 0;
    run.books.forEach((book, index) => {
      const width = widths[index];
      placements.push({
        uuid: book.uuid,
        width,
        row,
        x: bayLeft + cursor + width / 2,
      });
      cursor += width + BOOK_GAP;
    });
  }

  const uploadTargets: PlacedUploadTarget[] = [];
  for (let visualRow = 0; visualRow < totalRows; visualRow++) {
    const rowCoord = minRow + visualRow - 1;
    const row = rowCoord - minRow;
    for (let visualCol = 0; visualCol < totalCols; visualCol++) {
      const colCoord = minCol + visualCol - 1;
      const run = runMap.get(`${rowCoord}:${colCoord}`);
      const bayCenter = (visualCol + 0.5 - totalCols / 2) * pitch;
      const bayLeft = bayCenter - bayInner / 2;
      const widths =
        run?.books.map((book) => spineWidth(ratios.get(book.uuid))) ?? [];
      const usedWidth =
        widths.reduce((sum, width) => sum + width, 0) +
        Math.max(0, widths.length - 1) * BOOK_GAP;
      const emptyLeft = bayLeft + usedWidth + (usedWidth > 0 ? BOOK_GAP : 0);
      const remaining = bayLeft + bayInner - emptyLeft;
      if (remaining < UPLOAD_PLACEHOLDER_WIDTH - 1e-6) continue;
      uploadTargets.push({
        shelfSlotId: Number.isFinite(run?.slotId) ? Number(run?.slotId) : null,
        rowCoord,
        colCoord,
        label: run?.label ?? null,
        row,
        x: emptyLeft + UPLOAD_PLACEHOLDER_WIDTH / 2,
        width: UPLOAD_PLACEHOLDER_WIDTH,
        hitX: emptyLeft + remaining / 2,
        hitWidth: remaining,
      });
    }
  }

  return {
    placements,
    slotLabels,
    uploadTargets,
    contentRows,
    contentCols,
    totalRows,
    totalCols,
    wallWidth,
  };
}

function nextCenterOutCoord(occupied: Set<string>): [number, number] {
  for (let radius = 0; radius < 50; radius++) {
    const candidates: Array<[number, number]> = [];
    for (let row = -radius; row <= radius; row++) {
      for (let col = -radius; col <= radius; col++) {
        if (Math.max(Math.abs(row), Math.abs(col)) !== radius) continue;
        candidates.push([row, col]);
      }
    }
    candidates.sort(([rowA, colA], [rowB, colB]) => {
      const distA = Math.abs(rowA) + Math.abs(colA);
      const distB = Math.abs(rowB) + Math.abs(colB);
      if (distA !== distB) return distA - distB;
      if (rowA !== rowB) return rowA - rowB;
      return colA - colB;
    });
    for (const [row, col] of candidates) {
      if (!occupied.has(`${row}:${col}`)) return [row, col];
    }
  }
  return [0, occupied.size + 1];
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
