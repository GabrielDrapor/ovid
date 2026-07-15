import { describe, it, expect, beforeEach } from 'vitest';
import {
  READER_THEMES,
  THEME_STORAGE_KEY,
  getTheme,
  loadThemePref,
  resolveTheme,
  saveThemePref,
  themeCssVars,
} from '../../src/reader/themes';

// WCAG relative luminance / contrast ratio for #rrggbb colors.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('reader themes', () => {
  it('defines the four launch themes', () => {
    expect(READER_THEMES.map((t) => t.id)).toEqual([
      'paper',
      'sepia',
      'green',
      'dark',
    ]);
  });

  it('every theme meets WCAG AA (4.5:1) for body and translated text', () => {
    for (const theme of READER_THEMES) {
      const { bg, text, textTranslated } = theme.colors;
      expect(
        contrast(text, bg),
        `${theme.id} text on bg`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(textTranslated, bg),
        `${theme.id} translated text on bg`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('light themes avoid full-contrast pure black-on-white; dark theme avoids pure white-on-black', () => {
    for (const theme of READER_THEMES) {
      const { bg, text } = theme.colors;
      // Softened palettes: below the 21:1 extreme by a clear margin.
      expect(contrast(text, bg), `${theme.id} contrast cap`).toBeLessThan(16);
      if (theme.dark) {
        expect(bg).not.toBe('#000000');
        expect(text.toLowerCase()).not.toBe('#ffffff');
      }
    }
  });

  it('exposes every palette token as a CSS variable', () => {
    for (const theme of READER_THEMES) {
      const vars = themeCssVars(theme);
      expect(Object.keys(vars).length).toBe(Object.keys(theme.colors).length);
      for (const key of Object.keys(vars)) {
        expect(key.startsWith('--rt-')).toBe(true);
        expect(vars[key]).toBeTruthy();
      }
    }
  });
});

describe('theme preference resolution', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to auto: paper in light scheme, dark in dark scheme', () => {
    expect(resolveTheme('auto', false).id).toBe('paper');
    expect(resolveTheme('auto', true).id).toBe('dark');
  });

  it('an explicit theme wins over the system scheme', () => {
    expect(resolveTheme('sepia', true).id).toBe('sepia');
    expect(resolveTheme('green', false).id).toBe('green');
  });

  it('an unknown stored theme id falls back to auto behavior', () => {
    expect(resolveTheme('does-not-exist', true).id).toBe('dark');
    expect(resolveTheme('does-not-exist', false).id).toBe('paper');
  });

  it('round-trips the stored preference and rejects invalid values', () => {
    saveThemePref('green');
    expect(loadThemePref()).toBe('green');
    saveThemePref('auto');
    expect(loadThemePref()).toBe('auto');
    localStorage.setItem(THEME_STORAGE_KEY, 'not-a-theme');
    expect(loadThemePref()).toBe('auto');
  });

  it('getTheme finds themes by id', () => {
    expect(getTheme('dark')?.dark).toBe(true);
    expect(getTheme('paper')?.dark).toBe(false);
    expect(getTheme('nope')).toBeUndefined();
  });
});
