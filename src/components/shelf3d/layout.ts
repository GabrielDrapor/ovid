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

export interface PlacedBay {
  rowCoord: number;
  colCoord: number;
  /** Content-relative row — same convention as `PlacedBook.row`. */
  row: number;
  /** World-space X center of the bay. */
  x: number;
  shelfSlotId: number | null;
  /** Public (seeded-collection) shelves reject drag-and-drop entirely. */
  isPublic: boolean;
  /** Book uuids in this bay, left-to-right layout order. */
  bookUuids: string[];
}

export interface ShelfLayout {
  placements: PlacedBook[];
  slotLabels: PlacedShelfLabel[];
  uploadTargets: PlacedUploadTarget[];
  /**
   * Every bay in the full wall grid (content plus the empty ring), whether
   * occupied or not. Drives drag-and-drop drop-target resolution.
   */
  bays: PlacedBay[];
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
  is_public?: number | boolean | null;
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
    // Legacy layout has no real (row, col) coordinate system to drop onto —
    // drag-and-drop is disabled in this mode (see resolveDropTarget callers).
    bays: [],
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
  isPublic?: boolean;
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
        isPublic: !!slot.is_public,
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
    // Books with no slot of their own (not yet migrated to a physical slot)
    // get a stable block of their own rows, packed the same way the legacy
    // wall used to: grouped, fresh row per group, left-to-right wrap. It's
    // anchored one row below whatever physical slots already exist so it
    // never collides with them, and it only grows as those unplaced books
    // themselves change — placing one more explicit slot elsewhere on the
    // shelf can't reshuffle it.
    const explicitRows = Array.from(runMap.values()).map((run) => run.rowCoord);
    const startRow =
      explicitRows.length > 0 ? Math.max(...explicitRows) + 1 : 0;
    const packed = packBookGroups(
      unplaced,
      ratios,
      bayInner,
      MAX_CONTENT_COLS,
      startRow
    );
    for (const run of Array.from(packed.values())) {
      runMap.set(`${run.rowCoord}:${run.colCoord}`, run);
    }
  }

  const runs = Array.from(runMap.values());
  if (runs.length === 0) {
    return {
      placements: [],
      slotLabels: [],
      uploadTargets: [],
      bays: [],
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
  const bays: PlacedBay[] = [];
  for (let visualRow = 0; visualRow < totalRows; visualRow++) {
    const rowCoord = minRow + visualRow - 1;
    const row = rowCoord - minRow;
    for (let visualCol = 0; visualCol < totalCols; visualCol++) {
      const colCoord = minCol + visualCol - 1;
      const run = runMap.get(`${rowCoord}:${colCoord}`);
      const bayCenter = (visualCol + 0.5 - totalCols / 2) * pitch;
      const bayLeft = bayCenter - bayInner / 2;
      const slotId = Number.isFinite(run?.slotId) ? Number(run?.slotId) : null;

      // Full grid enumeration (content + ring, occupied or not) for
      // drag-drop hit-testing — unlike uploadTargets below, this never
      // skips a bay just because it's full.
      bays.push({
        rowCoord,
        colCoord,
        row,
        x: bayCenter,
        shelfSlotId: slotId,
        isPublic: !!run?.isPublic,
        bookUuids: run ? run.books.map((book) => book.uuid) : [],
      });

      // Public shelves accept no uploads — no ghost placeholder, no hit area.
      if (run?.isPublic) continue;

      const widths =
        run?.books.map((book) => spineWidth(ratios.get(book.uuid))) ?? [];
      const usedWidth =
        widths.reduce((sum, width) => sum + width, 0) +
        Math.max(0, widths.length - 1) * BOOK_GAP;
      const emptyLeft = bayLeft + usedWidth + (usedWidth > 0 ? BOOK_GAP : 0);
      const remaining = bayLeft + bayInner - emptyLeft;
      if (remaining < UPLOAD_PLACEHOLDER_WIDTH - 1e-6) continue;
      uploadTargets.push({
        shelfSlotId: slotId,
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
    bays,
    contentRows,
    contentCols,
    totalRows,
    totalCols,
    wallWidth,
  };
}

/**
 * Packs ungrouped books into a block of fresh rows starting at `startRow`:
 * each shelf_id/ownership group gets its own row, wrapping left-to-right at
 * `maxCols` bays — the same packing legacy (non-physical) books use.
 */
function packBookGroups(
  books: LayoutBook[],
  ratios: Map<string, number>,
  bayInner: number,
  maxCols: number,
  startRow: number
): Map<string, PhysicalRun> {
  const grouped = new Map<string, LayoutBook[]>();
  for (const book of books) {
    const key = groupKey(book);
    const group = grouped.get(key);
    if (group) group.push(book);
    else grouped.set(key, [book]);
  }

  const runs = new Map<string, PhysicalRun>();
  let row = startRow;
  let col = 0;
  let cursor = 0;
  let started = false;

  for (const [, group] of Array.from(grouped.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (started) {
      row++;
      col = 0;
      cursor = 0;
    }
    for (const book of group.slice().sort(sortBooks)) {
      started = true;
      const w = spineWidth(ratios.get(book.uuid));
      if (cursor + w > bayInner + 1e-6 && cursor > 0) {
        col++;
        cursor = 0;
        if (col >= maxCols) {
          col = 0;
          row++;
        }
      }
      const key = `${row}:${col}`;
      let run = runs.get(key);
      if (!run) {
        run = { rowCoord: row, colCoord: col, books: [] };
        runs.set(key, run);
      }
      run.books.push(book);
      cursor += w + BOOK_GAP;
    }
  }

  return runs;
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

export interface DropTarget {
  rowCoord: number;
  colCoord: number;
  /** Content-relative row — same convention as `PlacedBook.row`. */
  row: number;
  /** World-space X center of the candidate bay. */
  x: number;
  /** 0-based insertion index among the bay's existing books, dragged book excluded. */
  insertIndex: number;
  /** Carried from the resolved bay so callers don't re-scan `layout.bays`. */
  shelfSlotId: number | null;
  bookUuids: string[];
}

/**
 * Map a live drag position to the bay it would land in and where among that
 * bay's books it would be inserted. Inverts the exact formulas
 * `layoutPhysicalSlots` uses to place bays/books, so a resolved target never
 * drifts from what's rendered. Returns null when dropped off the wall
 * entirely (including its empty ring) — `layout.bays` spans the full grid,
 * so landing on a ring cell resolves to that (possibly new) bay rather than
 * null, matching how the existing upload-into-the-ring flow works.
 */
export function resolveDropTarget(
  worldX: number,
  worldY: number,
  layout: ShelfLayout,
  draggedUuid: string,
  bayInner: number = BAY_INNER,
  rowHeight: number = ROW_HEIGHT
): DropTarget | null {
  const { totalRows, totalCols, bays, placements } = layout;
  if (totalRows === 0 || totalCols === 0 || bays.length === 0) return null;
  const pitch = bayInner + DIVIDER_T;

  // Inverse of rowYCenters: centers[i] = ((totalRows-1)/2 - i) * rowHeight.
  const visualRow = Math.round((totalRows - 1) / 2 - worldY / rowHeight);
  if (visualRow < 0 || visualRow >= totalRows) return null;

  // Inverse of the bay-center formula used for both placements and bays.
  const visualCol = Math.round(worldX / pitch + totalCols / 2 - 0.5);
  if (visualCol < 0 || visualCol >= totalCols) return null;

  const bay = bays[visualRow * totalCols + visualCol];
  if (!bay) return null;

  // Public (seeded-collection) shelves reject drops entirely.
  if (bay.isPublic) return null;

  const placementByUuid = new Map(placements.map((p) => [p.uuid, p]));

  // Capacity: the dragged book must physically fit. A same-bay reorder is
  // always allowed (net width unchanged) — this only gates cross-bay drops,
  // so an over-full bay can't be forced to spill into the divider.
  if (!bay.bookUuids.includes(draggedUuid)) {
    const dragged = placementByUuid.get(draggedUuid);
    const draggedWidth = dragged?.width ?? spineWidth(undefined);
    let usedWidth = 0;
    let count = 0;
    for (const uuid of bay.bookUuids) {
      const p = placementByUuid.get(uuid);
      if (!p) continue;
      usedWidth += p.width;
      count++;
    }
    usedWidth += Math.max(0, count - 1) * BOOK_GAP;
    const needed = usedWidth + (count > 0 ? BOOK_GAP : 0) + draggedWidth;
    if (needed > bayInner + 1e-6) return null;
  }

  let insertIndex = 0;
  for (const uuid of bay.bookUuids) {
    if (uuid === draggedUuid) continue;
    const p = placementByUuid.get(uuid);
    if (p !== undefined && p.x < worldX) insertIndex++;
  }

  return {
    rowCoord: bay.rowCoord,
    colCoord: bay.colCoord,
    row: bay.row,
    x: bay.x,
    insertIndex,
    shelfSlotId: bay.shelfSlotId,
    bookUuids: bay.bookUuids,
  };
}
