/**
 * The runtime composer places a book onto a blank cloth template, insets the
 * real cover (when present), and typesets the title/author — all with Sharp,
 * no AI. These tests use synthetic templates (a "book" rectangle on a light
 * background) so they are self-contained and deterministic.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  composeBookImages,
  spineThicknessFromLength,
  wrapText,
  fitWrapped,
} from '../cover-composer.js';

const BG = '#dfe1e1'; // light-neutral backdrop, same family as the real mockups

/** A blank front-cover mockup: dark portrait book centered on a light bg. */
async function fakeCoverTemplate(bookColor = '#7f8a8a'): Promise<Buffer> {
  const W = 1408,
    H = 768;
  const bw = 360,
    bh = 600;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <rect x="${(W - bw) / 2}" y="${(H - bh) / 2}" width="${bw}" height="${bh}" fill="${bookColor}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Like fakeCoverTemplate but with ROUNDED corners (real hardcovers are round). */
async function fakeRoundedCoverTemplate(
  bookColor = '#2b3a55'
): Promise<Buffer> {
  const W = 1408,
    H = 768;
  const bw = 360,
    bh = 600;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <rect x="${(W - bw) / 2}" y="${(H - bh) / 2}" width="${bw}" height="${bh}" rx="46" ry="46" fill="${bookColor}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A blank spine mockup: narrow tall book centered on a light bg. */
async function fakeSpineTemplate(bookColor = '#7f8a8a'): Promise<Buffer> {
  const W = 1408,
    H = 768;
  const bw = 70,
    bh = 600;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <rect x="${(W - bw) / 2}" y="${(H - bh) / 2}" width="${bw}" height="${bh}" fill="${bookColor}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A spine mockup with a stray bright chromatic blob off to the side. */
async function fakeSpineWithOutlier(): Promise<Buffer> {
  const W = 1408,
    H = 768;
  const bw = 70,
    bh = 600;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <rect x="${(W - bw) / 2}" y="${(H - bh) / 2}" width="${bw}" height="${bh}" fill="#2f3f63"/>
    <rect x="${Math.round(W * 0.82)}" y="${Math.round(H * 0.12)}" width="44" height="60" fill="#c63a1e"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A portrait "embedded cover" to inset. */
async function fakeOriginalCover(): Promise<Buffer> {
  const svg = `<svg width="437" height="606" xmlns="http://www.w3.org/2000/svg">
    <rect width="437" height="606" fill="#2b3a55"/>
    <circle cx="218" cy="303" r="120" fill="#e0a030"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pixel(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

describe('composeBookImages', () => {
  it('produces portrait cover + narrow spine PNGs with an embedded cover', async () => {
    const { cover, spine } = await composeBookImages({
      templateCover: await fakeCoverTemplate(),
      templateSpine: await fakeSpineTemplate(),
      originalCover: await fakeOriginalCover(),
      title: 'The Test Title',
      author: 'A. Author',
    });

    const cm = await sharp(cover).metadata();
    const sm = await sharp(spine).metadata();

    expect(cm.format).toBe('png');
    expect(sm.format).toBe('png');
    expect(cm.height!).toBeGreaterThan(cm.width!); // cover is portrait
    expect(cm.height!).toBeLessThanOrEqual(900);
    expect(sm.height! / sm.width!).toBeGreaterThan(3); // spine is tall + narrow
  });

  it('works without an embedded cover (typeset-only fallback)', async () => {
    const { cover, spine } = await composeBookImages({
      templateCover: await fakeCoverTemplate(),
      templateSpine: await fakeSpineTemplate(),
      originalCover: null,
      title: 'No Image Book',
      author: 'Someone',
    });
    expect((await sharp(cover).metadata()).format).toBe('png');
    expect((await sharp(spine).metadata()).format).toBe('png');
  });

  it('accepts a shorter spine title without affecting cover composition', async () => {
    const { cover, spine } = await composeBookImages({
      templateCover: await fakeCoverTemplate(),
      templateSpine: await fakeSpineTemplate(),
      originalCover: null,
      title: '可能性的艺术：比较政治学30讲',
      spineTitle: '可能性的艺术',
      author: '刘瑜',
    });

    expect((await sharp(cover).metadata()).format).toBe('png');
    expect((await sharp(spine).metadata()).format).toBe('png');
  });

  it('handles CJK titles and a long wrapping title without throwing', async () => {
    const cjk = await composeBookImages({
      templateCover: await fakeCoverTemplate('#22304a'),
      templateSpine: await fakeSpineTemplate('#22304a'),
      originalCover: await fakeOriginalCover(),
      title: '尤利西斯',
      author: '詹姆斯·乔伊斯',
    });
    expect((await sharp(cjk.cover).metadata()).format).toBe('png');

    const long = await composeBookImages({
      templateCover: await fakeCoverTemplate(),
      templateSpine: await fakeSpineTemplate(),
      originalCover: null,
      title: 'A Remarkably Long Book Title That Must Wrap Across Several Lines',
      author: 'Verbose Author Name',
    });
    expect((await sharp(long.cover).metadata()).format).toBe('png');
  });

  it('crops flush to the book — output is far smaller than the 1408px canvas', async () => {
    const { cover } = await composeBookImages({
      templateCover: await fakeCoverTemplate(),
      templateSpine: await fakeSpineTemplate(),
      originalCover: null,
      title: 'Flush',
      author: 'A',
    });
    const m = await sharp(cover).metadata();
    // The book is 360px wide in a 1408px canvas; flush crop ≈ the book.
    expect(m.width!).toBeLessThan(420);
    expect(m.width!).toBeGreaterThan(300);
  });

  it('keeps a square-cornered book opaque to the edges (no backdrop, no holes)', async () => {
    const { cover } = await composeBookImages({
      templateCover: await fakeCoverTemplate('#7f8a8a'),
      templateSpine: await fakeSpineTemplate('#7f8a8a'),
      originalCover: null,
      title: 'Opaque',
      author: 'A',
    });
    const m = await sharp(cover).metadata();
    const corner = await pixel(cover, 1, 1);
    const center = await pixel(cover, m.width! >> 1, m.height! >> 1);
    expect(corner.a).toBe(255); // square book fills its bbox → opaque corner
    expect(center.a).toBe(255);
    // corner is cloth, not the light backdrop
    expect(corner.r).toBeLessThan(180);
  });

  it('makes the rounded-corner backdrop transparent, keeps the book opaque', async () => {
    const { cover } = await composeBookImages({
      templateCover: await fakeRoundedCoverTemplate(),
      templateSpine: await fakeSpineTemplate('#2b3a55'),
      originalCover: null,
      title: 'Round',
      author: 'A',
    });
    const m = await sharp(cover).metadata();
    const corner = await pixel(cover, 1, 1); // outside the rounding → backdrop
    const center = await pixel(cover, m.width! >> 1, m.height! >> 1);
    expect(corner.a).toBe(0); // backdrop at the rounded corner → transparent
    expect(center.a).toBe(255); // book body stays opaque
  });

  it('spine width scales monotonically with thickness', async () => {
    const widths: number[] = [];
    for (const t of [0.7, 1.0, 1.6]) {
      const { spine } = await composeBookImages({
        templateCover: await fakeCoverTemplate(),
        templateSpine: await fakeSpineTemplate(),
        originalCover: null,
        title: '监视',
        author: '作者',
        spineThickness: t,
      });
      widths.push((await sharp(spine).metadata()).width!);
    }
    expect(widths[0]).toBeLessThan(widths[1]);
    expect(widths[1]).toBeLessThan(widths[2]);
  });

  it('rejects a stray off-spine blob (projection keeps the box on the spine)', async () => {
    const { spine } = await composeBookImages({
      templateCover: await fakeCoverTemplate('#2f3f63'),
      templateSpine: await fakeSpineWithOutlier(),
      originalCover: null,
      title: '监视',
      author: '作者',
    });
    const m = await sharp(spine).metadata();
    // Without outlier rejection the box would stretch ~600px toward the blob.
    expect(m.width!).toBeLessThan(130);
  });
});

describe('spineThicknessFromLength', () => {
  it('clamps short books to the thin end and long books to the thick end', () => {
    expect(spineThicknessFromLength(0)).toBe(0.7);
    expect(spineThicknessFromLength(50_000)).toBe(0.7);
    expect(spineThicknessFromLength(5_000_000)).toBe(1.7);
  });

  it('is monotonic across the usable range and stays within [0.7, 1.7]', () => {
    const a = spineThicknessFromLength(200_000);
    const b = spineThicknessFromLength(500_000);
    const c = spineThicknessFromLength(850_000);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    for (const v of [a, b, c]) {
      expect(v).toBeGreaterThanOrEqual(0.7);
      expect(v).toBeLessThanOrEqual(1.7);
    }
  });
});

describe('text fitting (no truncation)', () => {
  it('wraps latin by word and preserves every word', () => {
    const lines = wrapText('one two three four five six', 30, 90);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('one two three four five six');
  });

  it('wraps CJK by character and preserves every glyph', () => {
    const lines = wrapText('一二三四五六七八九十', 30, 80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('一二三四五六七八九十');
  });

  it('fitWrapped keeps short text at full size on one line', () => {
    const { size, lines } = fitWrapped('Hi', 40, 300, 200);
    expect(size).toBe(40);
    expect(lines).toEqual(['Hi']);
  });

  it('fitWrapped shrinks a long title to fit but never drops words', () => {
    const title =
      'The Half Second How first reactions get installed and how to edit them';
    const { size, lines } = fitWrapped(title, 48, 240, 160);
    expect(size).toBeLessThan(48); // had to shrink
    expect(lines.join(' ')).toBe(title); // nothing truncated
  });
});
