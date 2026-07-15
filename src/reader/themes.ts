// Reader color themes.
//
// A theme is pure data: an id plus a palette of named color tokens that get
// applied as CSS custom properties on the reader root. Adding a theme means
// adding an entry to READER_THEMES; a future "custom theme" feature can
// construct a ReaderTheme at runtime and feed it through the same pipeline.
//
// Palette rationale (see docs in PR / research report):
// - Light themes soften the default near-white/near-black pairing; values for
//   sepia and green come from measured WeRead theme colors.
// - The dark theme deliberately avoids pure black + pure white (halation for
//   astigmatic readers; industry practice is reduced-contrast dark modes).

export interface ReaderThemeColors {
  /** Page + reading column background */
  bg: string;
  /** Primary body text (original-language text) */
  text: string;
  /** Translated text — one step softer than primary */
  textTranslated: string;
  /** Secondary text: nav arrows, chapter numbers, captions */
  textMuted: string;
  /** Floating surfaces: menu, chapters modal, note popover */
  surface: string;
  /** Hover/active fills and modal headers on those surfaces */
  surfaceAlt: string;
  /** Hairline borders and dividers */
  border: string;
  /** Links, note markers, small emphasis */
  accent: string;
  /** Translucent accent fill (link hover, note-marker hover) */
  accentSoft: string;
  /** Paragraph hover hint on the reading surface */
  hover: string;
  /** Jump-landing flash highlight */
  flash: string;
  /** Floating action button */
  fabBg: string;
  fabFg: string;
}

export interface ReaderTheme {
  id: string;
  /** Dark themes get font-weight compensation and darker chrome */
  dark: boolean;
  colors: ReaderThemeColors;
}

export const READER_THEMES: ReaderTheme[] = [
  {
    id: 'white',
    dark: false,
    colors: {
      bg: '#fefefe',
      text: '#262626',
      textTranslated: '#454545',
      textMuted: '#8b8b85',
      surface: '#ffffff',
      surfaceAlt: '#f3f3f1',
      border: '#e4e4e0',
      accent: '#8b5a2b',
      accentSoft: 'rgba(139, 90, 43, 0.1)',
      hover: 'rgba(0, 0, 0, 0.03)',
      flash: 'rgba(216, 178, 113, 0.4)',
      fabBg: '#333333',
      fabFg: '#ffffff',
    },
  },
  {
    id: 'paper',
    dark: false,
    colors: {
      bg: '#faf6ec',
      text: '#2f2a21',
      textTranslated: '#4a443a',
      textMuted: '#8a8171',
      surface: '#fffdf6',
      surfaceAlt: '#f2edde',
      border: '#e6dfcc',
      accent: '#8b5a2b',
      accentSoft: 'rgba(139, 90, 43, 0.12)',
      hover: 'rgba(43, 36, 26, 0.04)',
      flash: 'rgba(216, 178, 113, 0.45)',
      fabBg: '#3a3324',
      fabFg: '#f6f2e7',
    },
  },
  {
    id: 'sepia',
    dark: false,
    colors: {
      bg: '#f7f0df',
      text: '#272623',
      textTranslated: '#454038',
      textMuted: '#8d8371',
      surface: '#fcf6e8',
      surfaceAlt: '#efe7d1',
      border: '#e3d9c0',
      accent: '#8b5a2b',
      accentSoft: 'rgba(139, 90, 43, 0.14)',
      hover: 'rgba(43, 36, 26, 0.05)',
      flash: 'rgba(210, 170, 105, 0.45)',
      fabBg: '#3d3423',
      fabFg: '#f6f0e0',
    },
  },
  {
    id: 'green',
    dark: false,
    colors: {
      bg: '#ccf0cf',
      text: '#202621',
      textTranslated: '#3a453b',
      textMuted: '#5f7261',
      surface: '#def5e0',
      surfaceAlt: '#bfe4c3',
      border: '#afd8b4',
      accent: '#34663f',
      accentSoft: 'rgba(52, 102, 63, 0.14)',
      hover: 'rgba(32, 38, 33, 0.05)',
      flash: 'rgba(110, 180, 125, 0.35)',
      fabBg: '#2c3e30',
      fabFg: '#e6f5e8',
    },
  },
  {
    id: 'dark',
    dark: true,
    colors: {
      bg: '#16181c',
      text: '#c9cdd3',
      textTranslated: '#b0b5bc',
      textMuted: '#7c828b',
      surface: '#22252b',
      surfaceAlt: '#2c3037',
      border: '#383d45',
      accent: '#c79b67',
      accentSoft: 'rgba(199, 155, 103, 0.16)',
      hover: 'rgba(255, 255, 255, 0.05)',
      flash: 'rgba(199, 155, 103, 0.28)',
      fabBg: '#454b54',
      fabFg: '#e8eaed',
    },
  },
];

/** 'auto' follows prefers-color-scheme; otherwise a theme id. */
export type ReaderThemePref = 'auto' | string;

export const THEME_STORAGE_KEY = 'ovid_reader_theme';

const DEFAULT_LIGHT_ID = 'paper';
const DEFAULT_DARK_ID = 'dark';

export function getTheme(id: string): ReaderTheme | undefined {
  return READER_THEMES.find((t) => t.id === id);
}

export function loadThemePref(): ReaderThemePref {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'auto' || (stored && getTheme(stored))) return stored;
  } catch {
    // Storage unavailable — fall through.
  }
  return 'auto';
}

export function saveThemePref(pref: ReaderThemePref): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Preference just won't persist.
  }
}

export function resolveTheme(
  pref: ReaderThemePref,
  systemDark: boolean
): ReaderTheme {
  if (pref !== 'auto') {
    const theme = getTheme(pref);
    if (theme) return theme;
  }
  return getTheme(systemDark ? DEFAULT_DARK_ID : DEFAULT_LIGHT_ID)!;
}

/** Palette as CSS custom properties, for the reader root's inline style. */
export function themeCssVars(theme: ReaderTheme): Record<string, string> {
  const c = theme.colors;
  return {
    '--rt-bg': c.bg,
    '--rt-text': c.text,
    '--rt-text-translated': c.textTranslated,
    '--rt-text-muted': c.textMuted,
    '--rt-surface': c.surface,
    '--rt-surface-alt': c.surfaceAlt,
    '--rt-border': c.border,
    '--rt-accent': c.accent,
    '--rt-accent-soft': c.accentSoft,
    '--rt-hover': c.hover,
    '--rt-flash': c.flash,
    '--rt-fab-bg': c.fabBg,
    '--rt-fab-fg': c.fabFg,
  };
}
