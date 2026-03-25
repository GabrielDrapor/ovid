/**
 * Image post-processing for book covers and spines.
 *
 * Spine processing pipeline:
 * 1. Trim any accidental border from the generated horizontal banner
 * 2. Rotate 90° CW for vertical spine orientation
 * 3. Resize to target dimensions (114×607)
 * 4. Encode as PNG
 */

import sharp from 'sharp';

const SPINE_WIDTH = 114;
const SPINE_HEIGHT = 607;
const COVER_WIDTH = 437;
const COVER_HEIGHT = 606;

/**
 * Process a spine image:
 * trim border → rotate 90° → resize to 114×607.
 */
export async function processSpine(imageBuffer: Buffer): Promise<Buffer> {
  // No more green-screen extraction — the prompt now generates the spine directly
  // filling the entire canvas. Just trim any accidental white/green border and resize.

  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const channels = metadata.channels || 3;

  // Trim any uniform-color border (white, green) that Gemini might still add
  const raw = await sharp(imageBuffer).raw().toBuffer();
  const isBg = (x: number, y: number): boolean => {
    const idx = (y * width + x) * channels;
    const r = raw[idx], g = raw[idx + 1], b = raw[idx + 2];
    if (r > 240 && g > 240 && b > 240) return true;
    if (g > 60 && (g - r) > 15 && (g - b) > 15) return true;
    return false;
  };

  const sampleYs = Array.from({ length: 30 }, (_, i) =>
    Math.floor(height * 0.1) + Math.floor((height * 0.8 * i) / 29)
  );
  const sampleXs = Array.from({ length: 30 }, (_, i) =>
    Math.floor(width * 0.1) + Math.floor((width * 0.8 * i) / 29)
  );

  let left = 0, right = width - 1, top = 0, bottom = height - 1;
  for (let x = 0; x < Math.floor(width * 0.4); x++) {
    if (sampleYs.filter(y => isBg(x, y)).length > sampleYs.length * 0.7) left = x + 1; else break;
  }
  for (let x = width - 1; x > Math.floor(width * 0.6); x--) {
    if (sampleYs.filter(y => isBg(x, y)).length > sampleYs.length * 0.7) right = x - 1; else break;
  }
  for (let y = 0; y < Math.floor(height * 0.4); y++) {
    if (sampleXs.filter(x => isBg(x, y)).length > sampleXs.length * 0.7) top = y + 1; else break;
  }
  for (let y = height - 1; y > Math.floor(height * 0.6); y--) {
    if (sampleXs.filter(x => isBg(x, y)).length > sampleXs.length * 0.7) bottom = y - 1; else break;
  }

  const cropW = Math.max(1, right - left + 1);
  const cropH = Math.max(1, bottom - top + 1);

  let trimmed: Buffer;
  if (cropW < width * 0.95 || cropH < height * 0.95) {
    trimmed = await sharp(imageBuffer)
      .extract({ left, top, width: cropW, height: cropH })
      .png()
      .toBuffer();
  } else {
    trimmed = imageBuffer;
  }

  // Always rotate 90° CW — the prompt generates horizontal text,
  // rotation makes it vertical like a real book spine.
  // This is unconditional because the prompt explicitly asks for horizontal text.
  const oriented = await sharp(trimmed).rotate(90).png().toBuffer();

  // Resize to target using 'cover' + centre — fills the full area, crops excess
  return sharp(oriented)
    .resize(SPINE_WIDTH, SPINE_HEIGHT, { fit: 'cover', position: 'centre' })
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
