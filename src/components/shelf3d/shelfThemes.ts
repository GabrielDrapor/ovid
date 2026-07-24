// Shelf color themes for the 3D closet.
//
// A theme is pure data: material tints (multiplied over the shared neutral
// grain textures) plus surface parameters and the room backdrop color. The
// Bookcase lerps its live materials toward the active theme every frame, so
// switching is a smooth crossfade rather than a texture swap.

export interface ShelfSurface {
  color: string;
  roughness: number;
  metalness: number;
}

export interface ShelfTheme {
  id: string;
  /** Color shown on the theme-switch swatch button */
  swatch: string;
  /** Shelf boards + top cap */
  board: ShelfSurface;
  /** End stiles + bay dividers */
  side: ShelfSurface;
  /** Case back panel */
  back: ShelfSurface;
  /** Scene background (the void around the wall unit) */
  room: string;
}

export const SHELF_THEMES: ShelfTheme[] = [
  {
    // The original dark-walnut study — tints match the average tone of the
    // pre-theme procedural walnut canvases.
    id: 'walnut',
    swatch: '#5e4130',
    board: { color: '#63452f', roughness: 0.8, metalness: 0 },
    side: { color: '#5e4230', roughness: 0.8, metalness: 0 },
    back: { color: '#3f2a1a', roughness: 0.88, metalness: 0 },
    room: '#171210',
  },
  {
    // Whitewashed cafe bookcase: matte off-white paint with the wood grain
    // faintly showing through, bright warm room.
    id: 'white',
    swatch: '#e9e4da',
    board: { color: '#eae5dc', roughness: 0.92, metalness: 0 },
    side: { color: '#e4dfd5', roughness: 0.92, metalness: 0 },
    back: { color: '#dcd6ca', roughness: 0.94, metalness: 0 },
    room: '#a9a29a',
  },
  {
    // USM-style steel unit: cool light panels with a soft metallic sheen,
    // warm gallery-beige room.
    id: 'steel',
    swatch: '#c7c9cd',
    // Metalness stays modest — with no environment map, high metalness just
    // reads as flat gray. The sheen comes from low roughness instead.
    board: { color: '#e7e9ec', roughness: 0.4, metalness: 0.35 },
    side: { color: '#d9dce0', roughness: 0.34, metalness: 0.45 },
    back: { color: '#f0ede8', roughness: 0.62, metalness: 0.1 },
    room: '#93897b',
  },
];

export const DEFAULT_SHELF_THEME_ID = SHELF_THEMES[0].id;

export function getShelfTheme(id: string | null | undefined): ShelfTheme {
  return SHELF_THEMES.find((t) => t.id === id) ?? SHELF_THEMES[0];
}

const STORAGE_KEY = 'ovid_shelf_theme';

export function loadShelfThemePref(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SHELF_THEMES.some((t) => t.id === saved)) return saved;
  } catch {}
  return DEFAULT_SHELF_THEME_ID;
}

export function saveShelfThemePref(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}
