/**
 * Image post-processing for book covers and spines.
 *
 * Spine processing pipeline:
 * 1. Download green-screen spine from R2
 * 2. Crop: find the spine rectangle by scanning edges inward
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
 * Check if a pixel is likely part of the green-screen background.
 * Catches pure green, yellow-green, lime, and other bright background variants.
 */
function isGreenBg(r: number, g: number, b: number): boolean {
  // Pure green: g dominates both r and b
  if (g > 60 && (g - r) > 25 && (g - b) > 25) return true;
  // Yellow-green / chartreuse variants (Gemini sometimes uses these instead of pure #00FF00)
  if (g > 100 && r > 80 && b < 120 && (g + r) > 220 && (g - b) > 30) return true;
  // Bright lime: high saturation green-ish
  if (g > 150 && b < 100 && g > r * 0.8) return true;
  return false;
}

/**
 * Find content bounds using a two-pass approach:
 * Pass 1: Use green detection to find left/right bounds (columns)
 * Pass 2: Use darkness detection to find top/bottom bounds (rows)
 *         within the already-found left/right range
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

  // --- Pass 1: find left/right using green detection ---
  function colIsGreenBg(x: number): boolean {
    let bgCount = 0, total = 0;
    for (let y = Math.floor(height / 4); y < Math.floor(3 * height / 4); y += 3) {
      const { r, g, b } = px(x, y);
      total++;
      if (isGreenBg(r, g, b)) bgCount++;
    }
    return bgCount / total > 0.3;
  }

  let left = 0;
  while (left < width && colIsGreenBg(left)) left++;

  let right = width - 1;
  while (right > left && colIsGreenBg(right)) right--;

  // If green detection didn't trim left/right, use edge-color comparison
  if (left === 0 && right === width - 1) {
    function getColEdgeAvg(cols: number[]): { r: number; g: number; b: number } {
      let tr = 0, tg = 0, tb = 0, count = 0;
      for (const x of cols) {
        for (let y = 0; y < height; y += 4) {
          const p = px(x, y);
          tr += p.r; tg += p.g; tb += p.b; count++;
        }
      }
      return { r: tr / count, g: tg / count, b: tb / count };
    }

    function colDiffersFromBg(x: number, bg: { r: number; g: number; b: number }): boolean {
      let diffCount = 0, total = 0;
      for (let y = Math.floor(height / 4); y < Math.floor(3 * height / 4); y += 2) {
        const { r, g, b } = px(x, y);
        total++;
        const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
        if (dist > 80) diffCount++;
      }
      return diffCount / total > 0.15;
    }

    const bgLeft = getColEdgeAvg([0, 1, 2]);
    const bgRight = getColEdgeAvg([width - 1, width - 2, width - 3]);
    while (left < width && !colDiffersFromBg(left, bgLeft)) left++;
    while (right > left && !colDiffersFromBg(right, bgRight)) right--;
  }

  if (left >= right) { left = 0; right = width - 1; }

  // --- Pass 2: find top/bottom ---
  // Use green detection for rows too, same as columns.
  // Then fall back: if no green rows found at edges, check if row
  // differs significantly from the very first/last row (edge row = background).
  function rowIsGreenBg(y: number): boolean {
    let bgCount = 0, total = 0;
    for (let x = left; x <= right; x += 2) {
      const { r, g, b } = px(x, y);
      total++;
      if (isGreenBg(r, g, b)) bgCount++;
    }
    return bgCount / total > 0.3;
  }

  // Get average color of the top-left corner (background reference)
  function getEdgeAvg(rows: number[]): { r: number; g: number; b: number } {
    let tr = 0, tg = 0, tb = 0, count = 0;
    for (const y of rows) {
      for (let x = 0; x < width; x += 4) {
        const p = px(x, y);
        tr += p.r; tg += p.g; tb += p.b; count++;
      }
    }
    return { r: tr / count, g: tg / count, b: tb / count };
  }

  function rowDiffersFromBg(y: number, bg: { r: number; g: number; b: number }): boolean {
    let diffCount = 0, total = 0;
    for (let x = left; x <= right; x += 2) {
      const { r, g, b } = px(x, y);
      total++;
      const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
      if (dist > 80) diffCount++;
    }
    return diffCount / total > 0.15;
  }

  // Try green detection first
  let top = 0;
  while (top < height && rowIsGreenBg(top)) top++;
  let bottom = height - 1;
  while (bottom > top && rowIsGreenBg(bottom)) bottom--;

  // If green detection didn't trim anything, use edge-color comparison
  if (top === 0 && bottom === height - 1) {
    const bgTop = getEdgeAvg([0, 1, 2]);
    const bgBottom = getEdgeAvg([height - 1, height - 2, height - 3]);
    while (top < height && !rowDiffersFromBg(top, bgTop)) top++;
    while (bottom > top && !rowDiffersFromBg(bottom, bgBottom)) bottom--;
  }

  // No padding adjustment — use the exact detected bounds.
  // The resize step uses 'contain' which won't clip content,
  // and background fill uses the spine's interior color.

  return { left, right, top, bottom };
}

/**
 * Remove green color spill from edge pixels only.
 * Only processes pixels within an edge band (5% of width/height from each
 * crop boundary) to prevent color damage to legitimate greens in artwork interiors.
 */
function despillGreen(pixels: Buffer, channels: number, width: number, height: number): Buffer {
  const result = Buffer.from(pixels);
  const bandX = Math.max(2, Math.round(width * 0.05));
  const bandY = Math.max(2, Math.round(height * 0.05));

  for (let y = 0; y < height; y++) {
    const inYBand = y < bandY || y >= height - bandY;
    for (let x = 0; x < width; x++) {
      if (!inYBand && x >= bandX && x < width - bandX) continue;
      const i = (y * width + x) * channels;
      const r = result[i];
      const g = result[i + 1];
      const b = result[i + 2];
      const avgRB = Math.floor((r + b) / 2);
      if (g > 100 && g > avgRB + 20) {
        result[i + 1] = avgRB + 5;
      }
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

  // Find content bounds — try green detection first, fall back to general bg detection
  let bounds = findContentBounds(rawPixels, width, height, channels);
  let contentW = bounds.right - bounds.left + 1;
  let contentH = bounds.bottom - bounds.top + 1;

  // If findContentBounds returned nearly the full image, it likely failed.
  // Fall back to the more robust bg-scanning approach (same as processCover).
  if (contentW > width * 0.95 && contentH > height * 0.95) {
    const isBg = (x: number, y: number): boolean => {
      const idx = (y * width + x) * channels;
      const r = rawPixels[idx], g = rawPixels[idx + 1], b = rawPixels[idx + 2];
      if (r > 240 && g > 240 && b > 240) return true; // white
      if (g > 60 && (g - r) > 15 && (g - b) > 15) return true; // green (loose)
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
      const bgCount = sampleYs.filter(y => isBg(x, y)).length;
      if (bgCount > sampleYs.length * 0.7) left = x + 1; else break;
    }
    for (let x = width - 1; x > Math.floor(width * 0.6); x--) {
      const bgCount = sampleYs.filter(y => isBg(x, y)).length;
      if (bgCount > sampleYs.length * 0.7) right = x - 1; else break;
    }
    for (let y = 0; y < Math.floor(height * 0.4); y++) {
      const bgCount = sampleXs.filter(x => isBg(x, y)).length;
      if (bgCount > sampleXs.length * 0.7) top = y + 1; else break;
    }
    for (let y = height - 1; y > Math.floor(height * 0.6); y--) {
      const bgCount = sampleXs.filter(x => isBg(x, y)).length;
      if (bgCount > sampleXs.length * 0.7) bottom = y - 1; else break;
    }

    bounds = { left, right, top, bottom };
    contentW = right - left + 1;
    contentH = bottom - top + 1;
  }

  if (contentW <= 0 || contentH <= 0) {
    throw new Error(`Invalid content bounds: ${JSON.stringify(bounds)}`);
  }

  // Extract the content region + trim 2% inward to remove boundary artifacts
  const trimPxX = Math.max(2, Math.round(contentW * 0.02));
  const trimPxY = Math.max(2, Math.round(contentH * 0.02));
  const extractLeft = Math.min(bounds.left + trimPxX, bounds.left + contentW - 1);
  const extractTop = Math.min(bounds.top + trimPxY, bounds.top + contentH - 1);
  const extractW = Math.max(1, contentW - trimPxX * 2);
  const extractH = Math.max(1, contentH - trimPxY * 2);

  const cropped = await sharp(imageBuffer)
    .extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH })
    .raw()
    .toBuffer();

  // Despill green fringe (edge-only to preserve interior colors)
  const despilled = despillGreen(cropped, channels, extractW, extractH);

  // Reconstruct image from raw pixels
  let spineImage = sharp(despilled, {
    raw: { width: extractW, height: extractH, channels: channels as 3 | 4 },
  });

  // The spine from Gemini may be horizontal (landscape) — we asked for horizontal text
  // that we'll rotate in post-processing. Detect orientation and rotate if needed.
  const step1Buf = await spineImage.png().toBuffer();
  const step1Meta = await sharp(step1Buf).metadata();
  const isLandscape = (step1Meta.width || 0) > (step1Meta.height || 0);

  let oriented: Buffer;
  if (isLandscape) {
    // Rotate 90° clockwise so horizontal text becomes vertical (like real book spines)
    oriented = await sharp(step1Buf).rotate(90).png().toBuffer();
  } else {
    oriented = step1Buf;
  }

  // Resize to target using 'fill' (stretch to exact dimensions).
  return sharp(oriented)
    .resize(SPINE_WIDTH, SPINE_HEIGHT, { fit: 'fill' })
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
