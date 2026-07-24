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

export interface ShelfLight {
  color: string;
  intensity: number;
}

export interface ShelfLights {
  /** Overall room bounce */
  ambient: ShelfLight;
  /** Ceiling key spotlight (the only shadow caster) */
  key: ShelfLight;
  /** Cool directional fill from the side */
  fill: ShelfLight;
  /** Low warm bounce point light */
  bounce: ShelfLight;
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
  /** Upload-slot ghost (plus glyph + hover fill) — must contrast the case */
  ghost: string;
  /** Light rig tuning — color temperature and level to match the finish */
  lights: ShelfLights;
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
    ghost: '#fff6e2',
    structure: {
      boardScale: 1,
      sideScale: 1,
      chrome: 0,
      plainBack: 0,
      grain: 1,
    },
    // The original warm evening-lamp rig.
    lights: {
      ambient: { color: '#f4ede3', intensity: 0.62 },
      key: { color: '#f4e7d3', intensity: 1.55 },
      fill: { color: '#ccd4e8', intensity: 0.26 },
      bounce: { color: '#ece1cf', intensity: 0.15 },
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
    ghost: '#7a6f5e',
    structure: {
      boardScale: 1,
      sideScale: 1,
      chrome: 0,
      plainBack: 1,
      grain: 1,
    },
    // Bright, airy cafe daylight: lifted ambient, near-white key with a
    // cool window fill (warm/cool contrast keeps it from reading
    // fluorescent).
    lights: {
      ambient: { color: '#f6f3ee', intensity: 0.92 },
      key: { color: '#fdf7ea', intensity: 1.78 },
      fill: { color: '#d3dbea', intensity: 0.4 },
      bounce: { color: '#f0ebe2', intensity: 0.22 },
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
    ghost: '#5d636d',
    structure: {
      boardScale: 0.36,
      sideScale: 0.4,
      chrome: 1,
      plainBack: 1,
      grain: 0,
    },
    // Neutral showroom light: cooler key and fill flatter the chrome and
    // powder-coat without the walnut rig's amber cast.
    lights: {
      ambient: { color: '#edf0f3', intensity: 0.8 },
      key: { color: '#f0f2f5', intensity: 1.68 },
      fill: { color: '#c9d3e4', intensity: 0.42 },
      bounce: { color: '#e8e9ec', intensity: 0.18 },
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
