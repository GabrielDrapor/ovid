/**
 * Gemini draws the spine as a narrow vertical rectangle centered on a solid
 * lime-green (#00FF00) screen — but its size, aspect, and orientation vary, and
 * a white spine leaves a faint green anti-aliased fringe. processSpine must:
 *   - extract the rectangle as the bounding box of every non-green pixel,
 *   - keep the title/author/motif at the ends (never crop them away),
 *   - pad to 114×607 with the spine's own color (no green bars),
 *   - rotate a landscape banner back to portrait.
 * These tests feed synthetic green-screen inputs so they run offline in CI.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processSpine } from '../image-processor.js';

const GREEN = { r: 50, g: 230, b: 50 };
const CANVAS_W = 1376;
const CANVAS_H = 768;

type RGB = { r: number; g: number; b: number };

/** Build a lime-green canvas with a centered rectangle made of stacked bands. */
async function greenScreen(
  rectW: number,
  rectH: number,
  bands: Array<{ frac: number; color: RGB }>,
): Promise<Buffer> {
  const base = sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 3, background: GREEN },
  });
  const left = Math.floor((CANVAS_W - rectW) / 2);
  const top = Math.floor((CANVAS_H - rectH) / 2);
  const layers: sharp.OverlayOptions[] = [];
  let y = top;
  for (const band of bands) {
    const h = Math.max(1, Math.round(rectH * band.frac));
    const buf = await sharp({
      create: { width: rectW, height: h, channels: 3, background: band.color },
    }).png().toBuffer();
    layers.push({ input: buf, left, top: y });
    y += h;
  }
  return base.composite(layers).png().toBuffer();
}

async function pixels(buf: Buffer) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return {
    w: info.width,
    h: info.height,
    at: (x: number, y: number): RGB => {
      const i = (y * info.width + x) * info.channels;
      return { r: data[i], g: data[i + 1], b: data[i + 2] };
    },
  };
}

const isLimeGreen = (c: RGB) => c.g > 140 && c.g - c.r > 60 && c.g - c.b > 60;
const near = (c: RGB, t: RGB, tol = 45) =>
  Math.abs(c.r - t.r) < tol && Math.abs(c.g - t.g) < tol && Math.abs(c.b - t.b) < tol;

describe('processSpine — green-screen extraction', () => {
  it('outputs exactly 114×607', async () => {
    const img = await greenScreen(90, 620, [{ frac: 1, color: { r: 200, g: 80, b: 40 } }]);
    const out = await processSpine(img);
    const m = await sharp(out).metadata();
    expect(m.width).toBe(114);
    expect(m.height).toBe(607);
  });

  it('keeps the top motif and bottom author band — never crops the ends', async () => {
    // Distinct red cap and blue foot so we can confirm both survive.
    const RED = { r: 220, g: 40, b: 40 };
    const BLUE = { r: 40, g: 60, b: 210 };
    const BODY = { r: 235, g: 225, b: 200 };
    const img = await greenScreen(90, 620, [
      { frac: 0.12, color: RED },
      { frac: 0.76, color: BODY },
      { frac: 0.12, color: BLUE },
    ]);
    const out = await processSpine(img);
    const p = await pixels(out);
    const cx = Math.floor(p.w / 2);

    // Red cap survives near the top, blue foot near the bottom.
    let redTop = false, blueBottom = false;
    for (let y = 0; y < p.h * 0.18; y++) if (near(p.at(cx, y), RED)) redTop = true;
    for (let y = Math.floor(p.h * 0.82); y < p.h; y++) if (near(p.at(cx, y), BLUE)) blueBottom = true;
    expect(redTop).toBe(true);
    expect(blueBottom).toBe(true);
  });

  it('removes the green screen — no lime-green left in the body', async () => {
    const img = await greenScreen(90, 620, [{ frac: 1, color: { r: 200, g: 80, b: 40 } }]);
    const out = await processSpine(img);
    const p = await pixels(out);
    let green = 0, total = 0;
    for (let y = 0; y < p.h; y += 5) for (let x = 0; x < p.w; x += 3) { total++; if (isLimeGreen(p.at(x, y))) green++; }
    expect(green / total).toBeLessThan(0.02);
  });

  it('pads a white spine with white bars, not green', async () => {
    const WHITE = { r: 245, g: 245, b: 245 };
    const img = await greenScreen(88, 620, [{ frac: 1, color: WHITE }]);
    const out = await processSpine(img);
    const p = await pixels(out);
    // A narrow spine is padded on the left/right — sample the pad columns.
    for (const x of [1, p.w - 2]) {
      const c = p.at(x, Math.floor(p.h / 2));
      expect(isLimeGreen(c)).toBe(false);
      expect(near(c, WHITE)).toBe(true);
    }
  });

  it('rotates a landscape banner back to portrait', async () => {
    // Wider than tall: simulates Gemini emitting a horizontal banner.
    const img = await greenScreen(620, 96, [{ frac: 1, color: { r: 30, g: 30, b: 30 } }]);
    const out = await processSpine(img);
    const m = await sharp(out).metadata();
    expect(m.width).toBe(114);
    expect(m.height).toBe(607);
    // The dark banner should dominate the output (it was extracted, not the green).
    const p = await pixels(out);
    let dark = 0, total = 0;
    for (let y = 0; y < p.h; y += 5) for (let x = 0; x < p.w; x += 3) { total++; const c = p.at(x, y); if (c.r < 90 && c.g < 90 && c.b < 90) dark++; }
    expect(dark / total).toBeGreaterThan(0.4);
  });
});
