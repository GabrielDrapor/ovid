/**
 * Image post-processing for book covers and spines.
 *
 * Spine processing pipeline:
 * 1. Download green-screen spine from R2
 * 2. Crop: scan from center outward, find green/background boundary
 * 3. Despill: remove green color cast from edge pixels
 * 4. Resize to target dimensions (114×607)
 * 5. Encode as PNG
 */

import sharp from 'sharp';

const SPINE_WIDTH = 114;
const SPINE_HEIGHT = 607;
const COVER_WIDTH = 437;
const COVER_HEIGHT = 606;

/**
 * Check if a pixel is background green.
 * More lenient than before — catches yellow-green and lime variations
 * that Gemini sometimes produces instead of pure #00FF00.
 */
function isBackground(r: number, g: number, b: number): boolean {
  // Pure green screen: g dominates both r and b
  if (g > 60 && (g - r) > 25 && (g - b) > 25) return true;
  // Yellow-green variants: high g+r, low b
  if (g > 100 && r > 80 && b < 100 && (g + r) > 250 && (g - b) > 40) return true;
  // Very bright / near-white background
  if (r > 230 && g > 230 && b > 230) return true;
  return false;
}

/**
 * Crop background from spine image.
 * Scans from center outward to find content boundaries.
 */
function findContentBounds(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
): { left: number; right: number; top: number; bottom: number } {
  const px = (x: number, y: number) => {
    const idx = (y * width + x) * channels;
    return { r: pixels[idx], g: pixels[idx + 1], b: pixels[idx + 2] };
  };

  function colIsBg(x: number): boolean {
    let bgCount = 0, total = 0;
    const startY = Math.floor(height / 4);
    const endY = Math.floor(3 * height / 4);
    for (let y = startY; y < endY; y += 3) {
      const { r, g, b } = px(x, y);
      total++;
      if (isBackground(r, g, b)) bgCount++;
    }
    return bgCount / total > 0.15;
  }

  function rowIsBg(y: number, left: number, right: number): boolean {
    let bgCount = 0, total = 0;
    for (let x = left; x <= right; x += 2) {
      const { r, g, b } = px(x, y);
      total++;
      if (isBackground(r, g, b)) bgCount++;
    }
    return bgCount / total > 0.15;
  }

  // Find left/right from center
  const cx = Math.floor(width / 2);

  let left = cx;
  while (left > 0 && !colIsBg(left)) left--;
  left += 2;

  let right = cx;
  while (right < width - 1 && !colIsBg(right)) right++;
  right -= 2;

  // Find top/bottom
  let top = 0;
  while (top < height && rowIsBg(top, left, right)) top++;
  top += 2;

  let bottom = height - 1;
  while (bottom > 0 && rowIsBg(bottom, left, right)) bottom--;
  bottom -= 2;

  return { left, right, top, bottom };
}

/**
 * Remove green color spill from pixels.
 * If green channel exceeds the average of red and blue, pull it down.
 */
function despillGreen(pixels: Buffer, channels: number): Buffer {
  const result = Buffer.from(pixels);
  for (let i = 0; i < result.length; i += channels) {
    const r = result[i];
    const g = result[i + 1];
    const b = result[i + 2];
    const avgRB = Math.floor((r + b) / 2);
    if (g > avgRB + 5) {
      result[i + 1] = avgRB + 2;
    }
  }
  return result;
}

/**
 * Process a green-screen spine image:
 * crop background → despill → resize to 114×607.
 */
export async function processSpine(imageBuffer: Buffer): Promise<Buffer> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const { width, height, channels } = metadata;

  if (!width || !height || !channels) {
    throw new Error('Cannot read image metadata');
  }

  const rawPixels = await image.raw().toBuffer();

  // Find content bounds
  const bounds = findContentBounds(rawPixels, width, height, channels);
  const contentW = bounds.right - bounds.left + 1;
  const contentH = bounds.bottom - bounds.top + 1;

  if (contentW <= 0 || contentH <= 0) {
    throw new Error(`Invalid content bounds: ${JSON.stringify(bounds)}`);
  }

  // Extract the content region
  const cropped = await sharp(imageBuffer)
    .extract({
      left: bounds.left,
      top: bounds.top,
      width: contentW,
      height: contentH,
    })
    .raw()
    .toBuffer();

  // Despill green fringe
  const despilled = despillGreen(cropped, channels);

  // Reconstruct and resize to target.
  // Use 'cover' to crop-to-fill if aspect ratio doesn't match.
  return sharp(despilled, {
    raw: { width: contentW, height: contentH, channels: channels as 3 | 4 },
  })
    .resize(SPINE_WIDTH, SPINE_HEIGHT, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
}

/**
 * Resize cover to target dimensions (437×606).
 * Uses 'cover' to crop-to-fill without distortion.
 */
export async function processCover(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer)
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
}
