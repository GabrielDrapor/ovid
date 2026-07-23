// Reader font families.
//
// A font option is pure data: an id plus the CSS font-family stack applied to
// the reading column. The bundled webfonts (LXGW Neo ZhiSong / LXGW WenKai,
// declared in public/index.html) are scoped via unicode-range and only
// download once a stack that uses them is selected. All options are free to
// use: Neo ZhiSong is IPA Font License, WenKai and Literata are SIL OFL,
// and the sans stack is pure system fonts.
//
// Every option restyles BOTH scripts:
// - song: LXGW Neo ZhiSong for CJK + Literata for Latin (default pairing).
// - kai: LXGW WenKai for CJK AND Basic Latin — its handwritten Latin glyphs
//   are part of the kai look (system kai fonts as fallback).
// - sans: system sans-serif (SF/Segoe/Roboto for Latin, PingFang/YaHei/Noto
//   for CJK) — no webfont download at all.

export interface ReaderFont {
  id: string;
  stack: string;
}

export const READER_FONTS: ReaderFont[] = [
  {
    id: 'song',
    stack:
      '"LXGW Neo ZhiSong Screen", "Literata", "New York", ui-serif, "Times New Roman", Times, serif',
  },
  {
    id: 'kai',
    stack:
      '"LXGW WenKai Screen", "Literata", "Kaiti SC", "STKaiti", KaiTi, "New York", ui-serif, serif',
  },
  {
    id: 'sans',
    stack:
      'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Helvetica Neue", Arial, sans-serif',
  },
];

export const DEFAULT_FONT_ID = READER_FONTS[0].id;

/** Resolve a stored font id to its stack, falling back to the default. */
export function fontStack(id: string | null | undefined): string {
  return (READER_FONTS.find((f) => f.id === id) ?? READER_FONTS[0]).stack;
}
