import { describe, expect, it } from 'vitest';
import {
  BAY_INNER,
  DEFAULT_SPINE_RATIO,
  DIVIDER_T,
  ROW_HEIGHT,
  layoutBooks,
  resolveDropTarget,
  rowYCenters,
} from '../../src/components/shelf3d/layout';

const ratios = new Map<string, number>();

describe('layoutBooks', () => {
  it('starts mapped shelf groups on fresh rows in shelf order', () => {
    const books = [
      { uuid: 'private-old', user_id: 1, display_order: 1 },
      { uuid: 'public-core', user_id: null, display_order: 1 },
      {
        uuid: 'gutenberg-a',
        user_id: null,
        shelf_id: '10-gutenberg-top',
        shelf_position: 2,
      },
      {
        uuid: 'gutenberg-b',
        user_id: null,
        shelf_id: '10-gutenberg-top',
        shelf_position: 1,
      },
    ];

    const layout = layoutBooks(books, ratios);
    const rows = new Map(layout.placements.map((p) => [p.uuid, p.row]));

    expect(rows.get('public-core')).toBe(0);
    expect(rows.get('gutenberg-b')).toBe(1);
    expect(rows.get('gutenberg-a')).toBe(1);
    expect(rows.get('private-old')).toBe(2);
  });

  it('wraps a large shelf group onto multiple rows from the left', () => {
    const books = Array.from({ length: 40 }, (_, i) => ({
      uuid: `gutenberg-${i}`,
      user_id: null,
      shelf_id: '10-gutenberg-top',
      shelf_position: i,
    }));
    const layout = layoutBooks(books, ratios, BAY_INNER, 1);
    const firstRow = layout.placements.filter((p) => p.row === 0);
    const secondRow = layout.placements.filter((p) => p.row === 1);

    expect(firstRow.length).toBeGreaterThan(0);
    expect(secondRow.length).toBeGreaterThan(0);
    expect(firstRow[0].x).toBeLessThan(0);
    expect(secondRow[0].x).toBeLessThan(0);
    expect(firstRow[0].width).toBeCloseTo(DEFAULT_SPINE_RATIO, 4);
  });

  it('uses physical slot coordinates when shelf rows and columns are present', () => {
    const books = [
      {
        uuid: 'sherlock',
        user_id: null,
        shelf_id: 'main',
        shelf_slot_id: 1,
        shelf_row: 0,
        shelf_col: 0,
        shelf_position: 1,
      },
      {
        uuid: 'gutenberg-left',
        user_id: null,
        shelf_id: 'main',
        shelf_slot_id: 2,
        shelf_row: 0,
        shelf_col: -1,
        shelf_position: 1,
      },
      {
        uuid: 'gutenberg-top',
        user_id: null,
        shelf_id: 'main',
        shelf_slot_id: 3,
        shelf_row: -1,
        shelf_col: 0,
        shelf_slot_label: 'Gutenberg books',
        shelf_position: 1,
      },
    ];

    const layout = layoutBooks(books, ratios);
    const byUuid = new Map(layout.placements.map((p) => [p.uuid, p]));

    expect(layout.contentRows).toBe(2);
    expect(layout.contentCols).toBe(2);
    expect(byUuid.get('gutenberg-top')?.row).toBe(0);
    expect(byUuid.get('sherlock')?.row).toBe(1);
    expect(byUuid.get('gutenberg-left')!.x).toBeLessThan(
      byUuid.get('sherlock')!.x
    );
    const pitch = BAY_INNER + DIVIDER_T;
    const sherlockBayCenter = (1 + 1 + 0.5 - layout.totalCols / 2) * pitch;
    expect(
      byUuid.get('sherlock')!.x - byUuid.get('sherlock')!.width / 2
    ).toBeCloseTo(sherlockBayCenter - BAY_INNER / 2, 4);
    // The labeled bay keeps its text; the other two occupied slotted bays
    // get empty-text entries (the click-to-add-label affordance).
    expect(layout.slotLabels).toHaveLength(3);
    expect(layout.slotLabels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: '-1:0:Gutenberg books',
          text: 'Gutenberg books',
          row: 0,
          slotId: 3,
        }),
        expect.objectContaining({ text: '', slotId: 1 }),
        expect.objectContaining({ text: '', slotId: 2 }),
      ])
    );
    expect(layout.uploadTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shelfSlotId: 3,
          rowCoord: -1,
          colCoord: 0,
          label: 'Gutenberg books',
        }),
      ])
    );
  });

  it('preserves spine widths in crowded physical slots', () => {
    const books = Array.from({ length: 30 }, (_, i) => ({
      uuid: `private-${i}`,
      user_id: 1,
      shelf_id: 'main',
      shelf_row: 0,
      shelf_col: 1,
      shelf_position: i,
    }));

    const layout = layoutBooks(books, ratios);
    const left = Math.min(...layout.placements.map((p) => p.x - p.width / 2));
    const right = Math.max(...layout.placements.map((p) => p.x + p.width / 2));

    expect(layout.placements[0].width).toBeCloseTo(DEFAULT_SPINE_RATIO, 4);
    expect(left).toBeCloseTo(-BAY_INNER / 2, 4);
    expect(right - left).toBeGreaterThan(BAY_INNER);
  });

  it('emits label entries only for labeled or occupied slotted bays', () => {
    const books = [
      {
        uuid: 'slotted',
        user_id: 1,
        shelf_slot_id: 2,
        shelf_row: 0,
        shelf_col: 1,
        shelf_position: 0,
      },
      // No slot of its own — packed into the legacy block, no label entry.
      { uuid: 'unplaced', user_id: 1, display_order: 0 },
    ];
    const layout = layoutBooks(books, ratios, BAY_INNER, 4, [
      { id: 1, shelf_id: 'main', row: 0, col: 0, sort_order: 0, label: 'Named, empty', is_public: 1 },
      { id: 2, shelf_id: 'main', row: 0, col: 1, sort_order: 1, label: null, is_public: 0 },
      { id: 3, shelf_id: 'main', row: 0, col: 2, sort_order: 2, label: null, is_public: 0 },
    ]);

    // Labeled-but-empty slot keeps its label (public flag carried through);
    // occupied unlabeled slot gets an empty entry; empty unlabeled slot and
    // the slotless legacy bay get nothing.
    expect(layout.slotLabels).toHaveLength(2);
    expect(layout.slotLabels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Named, empty',
          slotId: 1,
          isPublic: true,
        }),
        expect.objectContaining({ text: '', slotId: 2, isPublic: false }),
      ])
    );
  });

  it('creates upload targets for empty physical slots', () => {
    const layout = layoutBooks([], ratios, BAY_INNER, 4, [
      {
        id: 7,
        shelf_id: 'main',
        row: 1,
        col: -1,
        sort_order: 7,
        label: 'Empty slot',
      },
    ]);

    expect(layout.placements).toHaveLength(0);
    expect(layout.contentRows).toBe(1);
    expect(layout.contentCols).toBe(1);
    expect(layout.uploadTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shelfSlotId: 7,
          rowCoord: 1,
          colCoord: -1,
          label: 'Empty slot',
        }),
        expect.objectContaining({
          shelfSlotId: null,
          rowCoord: 0,
          colCoord: -2,
          label: null,
        }),
        expect.objectContaining({
          shelfSlotId: null,
          rowCoord: 2,
          colCoord: 0,
          label: null,
        }),
      ])
    );
    const slotTarget = layout.uploadTargets.find(
      (target) => target.rowCoord === 1 && target.colCoord === -1
    );
    expect(slotTarget!.x - slotTarget!.width / 2).toBeCloseTo(
      -BAY_INNER / 2,
      4
    );
  });

  it('packs books with no slot of their own into a stable block below existing physical slots', () => {
    const shelfSlots = [
      { id: 1, shelf_id: 'main', row: 0, col: 0, sort_order: 0, label: null },
    ];
    const slotted = {
      uuid: 'slotted',
      user_id: null,
      shelf_slot_id: 1,
      shelf_row: 0,
      shelf_col: 0,
      shelf_position: 1,
    };
    const unplaced = [
      { uuid: 'public-a', user_id: null, display_order: 1 },
      { uuid: 'user-a', user_id: 9, display_order: 1 },
    ];

    const layout = layoutBooks(
      [slotted, ...unplaced],
      ratios,
      BAY_INNER,
      4,
      shelfSlots
    );
    const byUuid = new Map(layout.placements.map((p) => [p.uuid, p]));

    // Unplaced groups start one row below the explicit slot (row 0), each
    // getting its own fresh row, and never share a row with the slotted book.
    expect(byUuid.get('slotted')?.row).toBe(0);
    expect(byUuid.get('public-a')?.row).toBe(1);
    expect(byUuid.get('user-a')?.row).toBe(2);
  });

  it('does not reshuffle already-unplaced books when a new physical slot appears elsewhere', () => {
    const unplaced = [
      { uuid: 'public-a', user_id: null, display_order: 1 },
      { uuid: 'user-a', user_id: 9, display_order: 1 },
    ];

    const before = layoutBooks(
      [
        {
          uuid: 'slotted',
          user_id: null,
          shelf_slot_id: 1,
          shelf_row: 0,
          shelf_col: 0,
          shelf_position: 1,
        },
        ...unplaced,
      ],
      ratios,
      BAY_INNER,
      4,
      [{ id: 1, shelf_id: 'main', row: 0, col: 0, sort_order: 0, label: null }]
    );

    // A second explicit slot is created at the same row (a neighboring bay),
    // as happens when another user uploads into an adjacent empty slot —
    // the row bound doesn't grow, so the unplaced block shouldn't move.
    const after = layoutBooks(
      [
        {
          uuid: 'slotted',
          user_id: null,
          shelf_slot_id: 1,
          shelf_row: 0,
          shelf_col: 0,
          shelf_position: 1,
        },
        {
          uuid: 'new-slotted',
          user_id: null,
          shelf_slot_id: 2,
          shelf_row: 0,
          shelf_col: 1,
          shelf_position: 1,
        },
        ...unplaced,
      ],
      ratios,
      BAY_INNER,
      4,
      [
        { id: 1, shelf_id: 'main', row: 0, col: 0, sort_order: 0, label: null },
        { id: 2, shelf_id: 'main', row: 0, col: 1, sort_order: 1, label: null },
      ]
    );

    const beforeByUuid = new Map(before.placements.map((p) => [p.uuid, p]));
    const afterByUuid = new Map(after.placements.map((p) => [p.uuid, p]));
    expect(afterByUuid.get('public-a')?.row).toBe(
      beforeByUuid.get('public-a')?.row
    );
    expect(afterByUuid.get('user-a')?.row).toBe(
      beforeByUuid.get('user-a')?.row
    );
  });

  it('creates upload targets for missing interior cells', () => {
    const layout = layoutBooks([], ratios, BAY_INNER, 4, [
      {
        id: 1,
        shelf_id: 'main',
        row: 1,
        col: 1,
        sort_order: 1,
        label: null,
      },
      {
        id: 2,
        shelf_id: 'main',
        row: -1,
        col: 0,
        sort_order: 2,
        label: null,
      },
    ]);

    expect(layout.uploadTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shelfSlotId: null,
          rowCoord: 1,
          colCoord: -1,
        }),
      ])
    );
  });
});

describe('resolveDropTarget', () => {
  function crowdedBayLayout() {
    const books = [
      { uuid: 'b0', user_id: 1, shelf_id: 'main', shelf_row: 0, shelf_col: 0, shelf_position: 0 },
      { uuid: 'b1', user_id: 1, shelf_id: 'main', shelf_row: 0, shelf_col: 0, shelf_position: 1 },
      { uuid: 'b2', user_id: 1, shelf_id: 'main', shelf_row: 0, shelf_col: 0, shelf_position: 2 },
      { uuid: 'other-row', user_id: 1, shelf_id: 'main', shelf_row: 1, shelf_col: 0, shelf_position: 0 },
    ];
    return layoutBooks(books, ratios);
  }

  function yFor(layout: ReturnType<typeof layoutBooks>, row: number) {
    return rowYCenters(layout.totalRows)[row + 1];
  }

  it('resolves insertIndex before, between, and after existing books', () => {
    const layout = crowdedBayLayout();
    const byUuid = new Map(layout.placements.map((p) => [p.uuid, p]));
    const [b0, b1, b2] = ['b0', 'b1', 'b2'].map((u) => byUuid.get(u)!);
    const y = yFor(layout, 0);

    const before = resolveDropTarget(b0.x - 1, y, layout, 'dragged');
    expect(before?.insertIndex).toBe(0);

    const between = resolveDropTarget((b0.x + b1.x) / 2, y, layout, 'dragged');
    expect(between?.insertIndex).toBe(1);

    const after = resolveDropTarget(b2.x + 1, y, layout, 'dragged');
    expect(after?.insertIndex).toBe(3);
  });

  it('excludes the dragged book itself from insertIndex counting', () => {
    const layout = crowdedBayLayout();
    const byUuid = new Map(layout.placements.map((p) => [p.uuid, p]));
    const y = yFor(layout, 0);

    // Dropped near b2's own position while dragging b0: only b1 and b2
    // remain as siblings, both left of the drop point.
    const result = resolveDropTarget(byUuid.get('b2')!.x + 1, y, layout, 'b0');
    expect(result?.insertIndex).toBe(2);
  });

  it('resolves insertIndex 0 in an empty bay', () => {
    const layout = layoutBooks([], ratios, BAY_INNER, 4, [
      { id: 1, shelf_id: 'main', row: 0, col: 5, sort_order: 0, label: null },
    ]);
    const result = resolveDropTarget(0, yFor(layout, 0), layout, 'dragged');
    expect(result).toEqual(
      expect.objectContaining({ rowCoord: 0, colCoord: 5, insertIndex: 0 })
    );
  });

  it('returns null when dropped off the wall entirely', () => {
    const layout = crowdedBayLayout();
    const farY = yFor(layout, 0) + layout.totalRows * ROW_HEIGHT * 5;
    expect(resolveDropTarget(0, farY, layout, 'dragged')).toBeNull();

    const pitch = BAY_INNER + DIVIDER_T;
    const farX = layout.totalCols * pitch * 5;
    expect(resolveDropTarget(farX, yFor(layout, 0), layout, 'dragged')).toBeNull();
  });

  it('resolves a point in the divider gap to a real, non-null bay', () => {
    const layout = crowdedBayLayout();
    const pitch = BAY_INNER + DIVIDER_T;
    // Halfway between col=0's bay center and its neighboring bay center —
    // squarely in the divider strip between them, not any book's own x.
    const result = resolveDropTarget(pitch / 2, yFor(layout, 0), layout, 'dragged');
    expect(result).not.toBeNull();
  });

  it('resolves a different row when dropped there', () => {
    const layout = crowdedBayLayout();
    const result = resolveDropTarget(0, yFor(layout, 1), layout, 'dragged');
    expect(result?.rowCoord).toBe(1);
  });

  it('round-trips every placed book back to its own bay', () => {
    const layout = crowdedBayLayout();
    for (const placement of layout.placements) {
      const bay = layout.bays.find((b) => b.bookUuids.includes(placement.uuid));
      expect(bay).toBeTruthy();
      const y = rowYCenters(layout.totalRows)[placement.row + 1];
      // 'other-row' is a real placed book (row 1), so capacity math treats
      // this as a cross-bay probe with a known dragged width.
      const result = resolveDropTarget(placement.x, y, layout, 'other-row');
      expect(result?.rowCoord).toBe(bay!.rowCoord);
      expect(result?.colCoord).toBe(bay!.colCoord);
    }
  });

  it('rejects a cross-bay drop into a bay with no room left', () => {
    // 30 default-width spines overflow a single bay well past BAY_INNER.
    const books = Array.from({ length: 30 }, (_, i) => ({
      uuid: `full-${i}`,
      user_id: 1,
      shelf_id: 'main',
      shelf_row: 0,
      shelf_col: 0,
      shelf_position: i,
    }));
    books.push({
      uuid: 'outsider',
      user_id: 1,
      shelf_id: 'main',
      shelf_row: 1,
      shelf_col: 0,
      shelf_position: 0,
    });
    const layout = layoutBooks(books, ratios);
    const fullBay = layout.bays.find(
      (b) => b.rowCoord === 0 && b.colCoord === 0
    )!;
    const y = rowYCenters(layout.totalRows)[fullBay.row + 1];
    expect(resolveDropTarget(fullBay.x, y, layout, 'outsider')).toBeNull();
  });

  it('still allows reordering within an over-full bay', () => {
    const books = Array.from({ length: 30 }, (_, i) => ({
      uuid: `full-${i}`,
      user_id: 1,
      shelf_id: 'main',
      shelf_row: 0,
      shelf_col: 0,
      shelf_position: i,
    }));
    const layout = layoutBooks(books, ratios);
    const bay = layout.bays.find((b) => b.rowCoord === 0 && b.colCoord === 0)!;
    const y = rowYCenters(layout.totalRows)[bay.row + 1];
    const result = resolveDropTarget(bay.x, y, layout, 'full-5');
    expect(result).not.toBeNull();
  });

  it('rejects drops onto a public shelf slot', () => {
    const books = [
      {
        uuid: 'mine',
        user_id: 1,
        shelf_id: 'main',
        shelf_row: 1,
        shelf_col: 0,
        shelf_position: 0,
      },
    ];
    const layout = layoutBooks(books, ratios, BAY_INNER, 4, [
      { id: 1, shelf_id: 'main', row: 0, col: 0, sort_order: 0, label: 'Gutenberg books', is_public: 1 },
      { id: 2, shelf_id: 'main', row: 1, col: 0, sort_order: 1, label: null, is_public: 0 },
    ]);
    const publicBay = layout.bays.find(
      (b) => b.rowCoord === 0 && b.colCoord === 0
    )!;
    expect(publicBay.isPublic).toBe(true);
    const y = rowYCenters(layout.totalRows)[publicBay.row + 1];
    expect(resolveDropTarget(publicBay.x, y, layout, 'mine')).toBeNull();

    // Public shelves also get no upload placeholder.
    expect(
      layout.uploadTargets.find((t) => t.rowCoord === 0 && t.colCoord === 0)
    ).toBeUndefined();
    expect(
      layout.uploadTargets.find((t) => t.rowCoord === 1 && t.colCoord === 0)
    ).toBeDefined();

    const ownBay = layout.bays.find(
      (b) => b.rowCoord === 1 && b.colCoord === 0
    )!;
    const ownY = rowYCenters(layout.totalRows)[ownBay.row + 1];
    expect(resolveDropTarget(ownBay.x, ownY, layout, 'mine')).not.toBeNull();
  });
});
