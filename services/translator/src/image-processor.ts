/**
 * Image post-processing for book covers and spines.
 *
 * Spine processing pipeline:
 * 1. Extract the spine's bounding box from the lime-green screen
 * 2. Rotate 90° CW only if it came out landscape
 * 3. Fit into 114×607 with 'contain' (pad, never crop) so text isn't clipped
 * 4. Encode as PNG
 */

import sharp from 'sharp';

const SPINE_WIDTH = 114;
const SPINE_HEIGHT = 607;
const COVER_WIDTH = 437;
const COVER_HEIGHT = 606;

/**
 * Median color of a buffer's outer border — used as the pad color so the
 * side/top bars added by 'contain' blend with the spine's own edges.
 */
async function borderColor(buf: Buffer): Promise<{ r: number; g: number; b: number }> {
  const m = await sharp(buf).metadata();
  const w = m.width || 1;
  const h = m.height || 1;
  const ch = m.channels || 3;
  const raw = await sharp(buf).raw().toBuffer();
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * ch;
    rs.push(raw[i]); gs.push(raw[i + 1]); bs.push(raw[i + 2]);
  };
  const ys = Math.max(1, Math.floor(h / 60));
  const xs = Math.max(1, Math.floor(w / 60));
  for (let y = 0; y < h; y += ys) { push(0, y); push(w - 1, y); }
  for (let x = 0; x < w; x += xs) { push(x, 0); push(x, h - 1); }
  // Drop any lime-green fringe samples so a white/light spine doesn't get
  // greenish pad bars from residual anti-aliasing at the screen boundary.
  const keep: number[] = [];
  for (let i = 0; i < rs.length; i++) {
    if (gs[i] > 140 && gs[i] - rs[i] > 40 && gs[i] - bs[i] > 40) continue;
    keep.push(i);
  }
  const idx = keep.length ? keep : rs.map((_, i) => i);
  const med = (a: number[]) => a.slice().sort((p, q) => p - q)[a.length >> 1] || 0;
  return { r: med(idx.map(i => rs[i])), g: med(idx.map(i => gs[i])), b: med(idx.map(i => bs[i])) };
}

/**
 * Process a spine image: extract from green screen → orient → fit to 114×607.
 */
export async function processSpine(imageBuffer: Buffer): Promise<Buffer> {
  // Gemini draws a narrow vertical spine centered on a solid lime-green (#00FF00)
  // field. Extract it as the bounding box of every non-green pixel, then fit that
  // into the target slot with 'contain' (pad, never crop) so the title, author,
  // and motif at the spine's ends are never clipped.

  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const channels = metadata.channels || 3;
  const raw = await sharp(imageBuffer).raw().toBuffer();

  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * channels;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };

  // Calibrate the screen color from the four corners (the spine is centered and
  // narrow, so corners are reliably background).
  const med = (a: number[]) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const corners = [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)];
  const bgR = med(corners.map(c => c[0]));
  const bgG = med(corners.map(c => c[1]));
  const bgB = med(corners.map(c => c[2]));
  const greenScreen = bgG > bgR + 40 && bgG > bgB + 40;

  const TOL = 70;
  const isBg = (x: number, y: number): boolean => {
    const [r, g, b] = at(x, y);
    // Close to the sampled screen color.
    if (Math.abs(r - bgR) < TOL && Math.abs(g - bgG) < TOL && Math.abs(b - bgB) < TOL) return true;
    // Anti-aliased green fringe hugging the spine edge.
    if (greenScreen && g > 140 && g - r > 50 && g - b > 50) return true;
    return false;
  };

  // Bounding box of all non-background pixels — the full spine, however narrow.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isBg(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const validBox =
    maxX >= 0 &&
    boxW >= width * 0.02 &&
    boxH >= height * 0.05 &&
    (boxW < width * 0.97 || boxH < height * 0.97);

  let spine: Buffer;
  if (validBox) {
    // Inset a few px to drop the anti-aliased green fringe; clamp to bounds.
    const inset = 3;
    const left = Math.min(minX + inset, width - 1);
    const top = Math.min(minY + inset, height - 1);
    const w = Math.max(1, Math.min(boxW - inset * 2, width - left));
    const h = Math.max(1, Math.min(boxH - inset * 2, height - top));
    spine = await sharp(imageBuffer).extract({ left, top, width: w, height: h }).png().toBuffer();
  } else {
    spine = imageBuffer;
  }

  // Rotate only if the extracted spine is landscape (Gemini occasionally emits a
  // horizontal banner with no green screen).
  const sm = await sharp(spine).metadata();
  if ((sm.width || 1) > (sm.height || 1)) {
    spine = await sharp(spine).rotate(90).png().toBuffer();
  }

  // Fit into the target slot without cropping; pad with the spine's border color.
  const padBg = await borderColor(spine);
  return sharp(spine)
    .resize(SPINE_WIDTH, SPINE_HEIGHT, { fit: 'contain', background: padBg })
    .png()
    .toBuffer();
}

/**
 * Resize cover to target dimensions (437×606).
 * First trims any uniform-color border (white, green, etc.) from Gemini output,
 * then uses 'cover' to crop-to-fill without distortion.
 */
export async function processCover(imageBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const channels = metadata.channels || 3;
  const raw = await sharp(imageBuffer).raw().toBuffer();

  // Find content bounds by scanning from each edge inward.
  // A pixel is "background" if it's white-ish (>240 all channels),
  // green-ish (g > r+20 && g > b+20), or very uniform with its neighbors.
  const isBg = (x: number, y: number): boolean => {
    const i = (y * width + x) * channels;
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    // White/near-white
    if (r > 240 && g > 240 && b > 240) return true;
    // Green background (Gemini's green screen)
    if (g > r + 20 && g > b + 20) return true;
    return false;
  };

  // Scan columns from left/right, rows from top/bottom
  // Use middle 60% of the perpendicular axis for sampling
  const sampleYs = Array.from({ length: 20 }, (_, i) =>
    Math.floor(height * 0.2) + Math.floor((height * 0.6 * i) / 19)
  );
  const sampleXs = Array.from({ length: 20 }, (_, i) =>
    Math.floor(width * 0.2) + Math.floor((width * 0.6 * i) / 19)
  );

  let left = 0, right = width - 1, top = 0, bottom = height - 1;

  // Scan left
  for (let x = 0; x < Math.floor(width * 0.3); x++) {
    const bgCount = sampleYs.filter(y => isBg(x, y)).length;
    if (bgCount > sampleYs.length * 0.8) left = x + 1;
    else break;
  }
  // Scan right
  for (let x = width - 1; x > Math.floor(width * 0.7); x--) {
    const bgCount = sampleYs.filter(y => isBg(x, y)).length;
    if (bgCount > sampleYs.length * 0.8) right = x - 1;
    else break;
  }
  // Scan top
  for (let y = 0; y < Math.floor(height * 0.3); y++) {
    const bgCount = sampleXs.filter(x => isBg(x, y)).length;
    if (bgCount > sampleXs.length * 0.8) top = y + 1;
    else break;
  }
  // Scan bottom
  for (let y = height - 1; y > Math.floor(height * 0.7); y--) {
    const bgCount = sampleXs.filter(x => isBg(x, y)).length;
    if (bgCount > sampleXs.length * 0.8) bottom = y - 1;
    else break;
  }

  const cropW = right - left + 1;
  const cropH = bottom - top + 1;

  let cropped: Buffer;
  if (cropW < width * 0.95 || cropH < height * 0.95) {
    // Significant border detected — crop it
    cropped = await sharp(imageBuffer)
      .extract({ left, top, width: cropW, height: cropH })
      .png()
      .toBuffer();
  } else {
    cropped = imageBuffer;
  }

  return sharp(cropped)
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
}
