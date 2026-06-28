/**
 * The runtime composer places a book onto a blank cloth template, insets the
 * real cover (when present), and typesets the title/author — all with Sharp,
 * no AI. These tests use synthetic templates (a dark "book" rectangle on a
 * light background) so they are self-contained and deterministic.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { composeBookImages } from '../cover-composer.js';

/** A blank front-cover mockup: dark portrait book centered on a light bg. */
async function fakeCoverTemplate(bookColor = '#7f8a8a'): Promise<Buffer> {
  const W = 1408,
    H = 768;
  const bw = 360,
    bh = 600;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#dfe1e1"/>
    <rect x="${(W - bw) / 2}" y="${(H - bh) / 2}" width="${bw}" height="${bh}" fill="${bookColor}"/>
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
    <rect width="${W}" height="${H}" fill="#dfe1e1"/>
    <rect x="${(W - bw) / 2}" y="${(H - bh) / 2}" width="${bw}" height="${bh}" fill="${bookColor}"/>
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
    // Cover is cropped to the book, so it is portrait (taller than wide).
    expect(cm.height!).toBeGreaterThan(cm.width!);
    expect(cm.height!).toBeLessThanOrEqual(900);
    // Spine is much taller than it is wide.
    expect(sm.height! / sm.width!).toBeGreaterThan(3);
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

  it('handles CJK titles and a long wrapping title without throwing', async () => {
    const cjk = await composeBookImages({
      templateCover: await fakeCoverTemplate('#22304a'), // dark → light ink branch
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
});
