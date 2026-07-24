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

export interface ShelfStructure {
  /** Shelf-board thickness as a fraction of the walnut baseline */
  boardScale: number;
  /** Stile/divider thickness as a fraction of the walnut baseline */
  sideScale: number;
  /** 1 = show the chromed tube-and-ball frame (USM look), 0 = hidden */
  chrome: number;
  /** 1 = cover the planked back with a smooth panel, 0 = show planks */
  plainBack: number;
  /** Grain-texture strength on boards/stiles: 1 = full wood grain,
      0 = smooth (powder-coated steel panels have none) */
  grain: number;
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
  /** Geometry treatment — lerped alongside the colors on switch */
  structure: ShelfStructure;
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
    structure: {
      boardScale: 1,
      sideScale: 1,
      chrome: 0,
      plainBack: 0,
      grain: 1,
    },
  },
  {
    // Whitewashed cafe bookcase: matte off-white paint with the wood grain
    // faintly showing through, bright warm room.
    id: 'white',
    swatch: '#e9e4da',
    board: { color: '#eae5dc', roughness: 0.92, metalness: 0 },
    side: { color: '#e4dfd5', roughness: 0.92, metalness: 0 },
    // Smooth plaster-white back — the planked veneer reads wrong on paint.
    back: { color: '#e7e2d8', roughness: 0.94, metalness: 0 },
    room: '#a9a29a',
    structure: {
      boardScale: 1,
      sideScale: 1,
      chrome: 0,
      plainBack: 1,
      grain: 1,
    },
  },
  {
    // USM-style steel unit: cool light panels with a soft metallic sheen,
    // warm gallery-beige room.
    id: 'steel',
    swatch: '#c7c9cd',
    // Metalness stays modest — with no environment map, high metalness just
    // reads as flat gray. The sheen comes from low roughness instead.
    // Thin powder-coated panels on a chromed tube-and-ball frame (USM look).
    board: { color: '#eceef1', roughness: 0.42, metalness: 0.25 },
    side: { color: '#dde0e4', roughness: 0.36, metalness: 0.35 },
    back: { color: '#f1eeea', roughness: 0.62, metalness: 0.08 },
    room: '#93897b',
    structure: {
      boardScale: 0.36,
      sideScale: 0.4,
      chrome: 1,
      plainBack: 1,
      grain: 0,
    },
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
