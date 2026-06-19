/**
 * processSpine has to handle three very different Gemini outputs:
 *   - Square (1024×1024) — rotate then cover-fit
 *   - Landscape (1600×600) — rotate then cover-fit
 *   - Very tall portrait (384×2736 — what we get when the prompt works) —
 *     scale to fit height and extend sides with background colour so the
 *     motif at the top and the author at the bottom aren't cropped away
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processSpine } from '../image-processor.js';

const SPINE_WIDTH = 114;
const SPINE_HEIGHT = 607;

async function makeSolid(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return await sharp({
    create: {
      width, height,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  }).png().toBuffer();
}

/**
 * Build a canvas with a single horizontal coloured band across the middle so
 * we can tell after processing whether the band ended up as the spine's
 * vertical content (rotation worked) or a thin vertical strip lost in a
 * middle-column crop (rotation did NOT happen).
 */
async function makeCanvasWithMiddleBand(
  width: number,
  height: number,
  background: [number, number, number],
  band: [number, number, number],
  bandHeight = 80,
): Promise<Buffer> {
  const bg = sharp({
    create: { width, height, channels: 3, background: { r: background[0], g: background[1], b: background[2] } },
  });
  const bandImg = await sharp({
    create: { width, height: bandHeight, channels: 3, background: { r: band[0], g: band[1], b: band[2] } },
  }).png().toBuffer();
  return await bg.composite([{ input: bandImg, top: Math.floor((height - bandHeight) / 2), left: 0 }]).png().toBuffer();
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

describe('processSpine', () => {
  it('outputs the target 114×607 dimensions', async () => {
    const square = await makeSolid(1024, 1024, [200, 100, 50]);
    const out = await processSpine(square);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(SPINE_WIDTH);
    expect(meta.height).toBe(SPINE_HEIGHT);
  });

  it('rotates a square canvas so horizontal title text ends up running top-to-bottom', async () => {
    // Square canvas, magenta background, cyan band horizontally across the middle.
    // If rotated, the cyan should appear as a vertical column in the center of
    // the spine — meaning sampling the center column at multiple y values hits cyan.
    // If NOT rotated (the previous bug), the cyan band is at y≈H/2 only, and most
    // of the spine is magenta — sampling y=100 and y=500 would both miss cyan.
    const canvas = await makeCanvasWithMiddleBand(1024, 1024, [255, 0, 255], [0, 255, 255], 120);
    const out = await processSpine(canvas);

    const midX = Math.floor(SPINE_WIDTH / 2);
    const [r1, g1, b1] = await pixel(out, midX, 100);
    const [r2, g2, b2] = await pixel(out, midX, 500);

    // Both samples should be cyan (the band, rotated into a column).
    const isCyan = (r: number, g: number, b: number) => r < 80 && g > 180 && b > 180;
    expect(isCyan(r1, g1, b1)).toBe(true);
    expect(isCyan(r2, g2, b2)).toBe(true);
  });

  it('rotates a landscape canvas (continues to behave as before)', async () => {
    const canvas = await makeCanvasWithMiddleBand(1600, 600, [255, 0, 255], [0, 255, 255], 80);
    const out = await processSpine(canvas);

    const midX = Math.floor(SPINE_WIDTH / 2);
    const [r1, g1, b1] = await pixel(out, midX, 100);
    const [r2, g2, b2] = await pixel(out, midX, 500);
    const isCyan = (r: number, g: number, b: number) => r < 80 && g > 180 && b > 180;
    expect(isCyan(r1, g1, b1)).toBe(true);
    expect(isCyan(r2, g2, b2)).toBe(true);
  });

  it('leaves a portrait canvas unrotated (no double-flip)', async () => {
    // Portrait (taller than wide) with a horizontal band — if rotated, the band
    // would appear as a vertical column. We want it left alone so the band
    // stays horizontal (i.e., concentrated near y=H/2 in the output).
    const canvas = await makeCanvasWithMiddleBand(400, 1600, [255, 0, 255], [0, 255, 255], 120);
    const out = await processSpine(canvas);

    const midX = Math.floor(SPINE_WIDTH / 2);
    const midY = Math.floor(SPINE_HEIGHT / 2);
    const [r_mid, g_mid, b_mid] = await pixel(out, midX, midY);
    const [r_top, g_top, b_top] = await pixel(out, midX, 50);
    const isCyan = (r: number, g: number, b: number) => r < 80 && g > 180 && b > 180;
    const isMagenta = (r: number, g: number, b: number) => r > 180 && g < 80 && b > 180;

    expect(isCyan(r_mid, g_mid, b_mid)).toBe(true);
    expect(isMagenta(r_top, g_top, b_top)).toBe(true);
  });

  it('preserves top and bottom content for very tall portrait input (no end-crop)', async () => {
    // 384×2736 mimics what Gemini returns when it cooperates with the spine
    // prompt — aspect ratio 0.14, narrower than our 0.188 target. Cover-fit
    // would scale-to-width and crop the top/bottom (motif + author). We want
    // scale-to-fit-height + sides extended with the background colour.
    //
    // Set up: magenta background everywhere, with a cyan band at the top
    // 100 rows and a yellow band at the bottom 100 rows. Both must survive.
    const W = 384, H = 2736;
    const bg = sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 0, b: 255 } } });
    const cyanBand = await sharp({ create: { width: W, height: 100, channels: 3, background: { r: 0, g: 255, b: 255 } } }).png().toBuffer();
    const yellowBand = await sharp({ create: { width: W, height: 100, channels: 3, background: { r: 255, g: 255, b: 0 } } }).png().toBuffer();
    const canvas = await bg.composite([
      { input: cyanBand, top: 0, left: 0 },
      { input: yellowBand, top: H - 100, left: 0 },
    ]).png().toBuffer();

    const out = await processSpine(canvas);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(SPINE_WIDTH);
    expect(meta.height).toBe(SPINE_HEIGHT);

    // The bands should still be visible near the top and bottom of the spine.
    // After scale-to-fit-height the source becomes 85×607 (with edge padding);
    // the cyan band lands in roughly y < 25, yellow in y > 582.
    const cx = Math.floor(SPINE_WIDTH / 2);
    const [tr, tg, tb] = await pixel(out, cx, 5);
    const [br, bg2, bb] = await pixel(out, cx, SPINE_HEIGHT - 5);
    const isCyan = (r: number, g: number, b: number) => r < 80 && g > 180 && b > 180;
    const isYellow = (r: number, g: number, b: number) => r > 180 && g > 180 && b < 80;
    expect(isCyan(tr, tg, tb)).toBe(true);
    expect(isYellow(br, bg2, bb)).toBe(true);
  });
});
