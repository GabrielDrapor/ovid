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

  // Despill green fringe (edge-only to preserve interior colors)
  const despilled = despillGreen(cropped, channels, contentW, contentH);

  // Reconstruct image from raw pixels
  let spineImage = sharp(despilled, {
    raw: { width: contentW, height: contentH, channels: channels as 3 | 4 },
  });

  // Two-step resize to avoid color padding artifacts:
  // 1. Resize to target width (114px), preserving aspect ratio
  // 2. If height > target: crop from center. If height < target: pad with spine bg color.
  const step1Buf = await spineImage.png().toBuffer();
  const widthResized = await sharp(step1Buf)
    .resize(SPINE_WIDTH, null) // resize width to 114, height auto
    .png()
    .toBuffer();

  const wrMeta = await sharp(widthResized).metadata();
  const wrH = wrMeta.height || SPINE_HEIGHT;

  if (wrH >= SPINE_HEIGHT) {
    // Taller than target: crop from center vertically
    const cropY = Math.round((wrH - SPINE_HEIGHT) / 2);
    return sharp(widthResized)
      .extract({ left: 0, top: cropY, width: SPINE_WIDTH, height: SPINE_HEIGHT })
      .png()
      .toBuffer();
  } else {
    // Shorter than target: pad top/bottom with spine's interior background color
    const wrRaw = await sharp(widthResized).raw().toBuffer();
    const wrCh = wrMeta.channels || 3;
    const centerX = Math.floor(SPINE_WIDTH / 2);
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let sy = Math.floor(wrH * 0.3); sy < Math.floor(wrH * 0.7); sy += 4) {
      const si = (sy * SPINE_WIDTH + centerX) * wrCh;
      sr += wrRaw[si]; sg += wrRaw[si + 1]; sb += wrRaw[si + 2]; cnt++;
    }
    const bg = cnt > 0
      ? { r: Math.round(sr / cnt), g: Math.round(sg / cnt), b: Math.round(sb / cnt) }
      : { r: 255, g: 255, b: 255 };

    return sharp(widthResized)
      .resize(SPINE_WIDTH, SPINE_HEIGHT, { fit: 'contain', background: bg })
      .png()
      .toBuffer();
  }
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
