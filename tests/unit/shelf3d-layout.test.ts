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
        shelf_row: 0,
        shelf_col: 0,
        shelf_position: 1,
      },
      {
        uuid: 'gutenberg-left',
        user_id: null,
        shelf_id: 'main',
        shelf_row: 0,
        shelf_col: -1,
        shelf_position: 1,
      },
      {
        uuid: 'gutenberg-top',
        user_id: null,
        shelf_id: 'main',
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

});
