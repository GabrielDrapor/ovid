import { describe, it, expect, beforeEach } from 'vitest';
import {
  SHELF_THEMES,
  DEFAULT_SHELF_THEME_ID,
  getShelfTheme,
  loadShelfThemePref,
  saveShelfThemePref,
} from '../../src/components/shelf3d/shelfThemes';

const HEX = /^#[0-9a-f]{6}$/i;

describe('shelf themes', () => {
  it('has unique ids and walnut as the default first entry', () => {
    const ids = SHELF_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_SHELF_THEME_ID).toBe('walnut');
    expect(SHELF_THEMES[0].id).toBe('walnut');
  });

  it('every theme has valid colors and surface params', () => {
    for (const th of SHELF_THEMES) {
      expect(th.swatch).toMatch(HEX);
      expect(th.room).toMatch(HEX);
      for (const s of [th.board, th.side, th.back]) {
        expect(s.color).toMatch(HEX);
        expect(s.roughness).toBeGreaterThanOrEqual(0);
        expect(s.roughness).toBeLessThanOrEqual(1);
        expect(s.metalness).toBeGreaterThanOrEqual(0);
        expect(s.metalness).toBeLessThanOrEqual(1);
      }
    }
  });

  it('structure params stay in sensible ranges', () => {
    for (const th of SHELF_THEMES) {
      const s = th.structure;
      for (const v of [s.chrome, s.plainBack, s.grain]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(s.boardScale).toBeGreaterThan(0.2);
      expect(s.boardScale).toBeLessThanOrEqual(1);
      expect(s.sideScale).toBeGreaterThan(0.2);
      expect(s.sideScale).toBeLessThanOrEqual(1);
    }
    // Steel is the structural outlier: thin panels, chrome on, no grain.
    const steel = getShelfTheme('steel').structure;
    expect(steel.chrome).toBe(1);
    expect(steel.grain).toBe(0);
    expect(steel.boardScale).toBeLessThan(0.5);
  });

  it('resolves unknown ids to the default theme', () => {
    expect(getShelfTheme('nope').id).toBe(DEFAULT_SHELF_THEME_ID);
    expect(getShelfTheme(null).id).toBe(DEFAULT_SHELF_THEME_ID);
    expect(getShelfTheme('steel').id).toBe('steel');
  });

  describe('preference persistence', () => {
    beforeEach(() => localStorage.clear());

    it('round-trips a saved theme', () => {
      saveShelfThemePref('white');
      expect(loadShelfThemePref()).toBe('white');
    });

    it('falls back to default for missing or unknown saved values', () => {
      expect(loadShelfThemePref()).toBe(DEFAULT_SHELF_THEME_ID);
      localStorage.setItem('ovid_shelf_theme', 'no-such-theme');
      expect(loadShelfThemePref()).toBe(DEFAULT_SHELF_THEME_ID);
    });
  });
});
