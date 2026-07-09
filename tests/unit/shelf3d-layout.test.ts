import { describe, expect, it } from 'vitest';
import {
  BAY_INNER,
  DEFAULT_SPINE_RATIO,
  DIVIDER_T,
  layoutBooks,
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
    expect(layout.slotLabels).toEqual([
      expect.objectContaining({
        key: '-1:0:Gutenberg books',
        text: 'Gutenberg books',
        row: 0,
      }),
    ]);
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
