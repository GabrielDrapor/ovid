// Procedurally generated wood + shading textures for the 3D closet.
// Everything is drawn on canvas so no external assets (or CORS) are needed.

/** Deterministic pseudo-random stream from a string seed. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Warm oak-like plank texture. Grain runs horizontally; rotate the texture
 * (or the mesh UVs) for vertical members.
 */
export function makeWoodCanvas(
  seed = 'ovid-wood',
  width = 1024,
  height = 512
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const rand = seededRandom(seed);

  // Base: dark walnut, sampled from the classic shelf's bookcase_bg.jpeg
  const base = ctx.createLinearGradient(0, 0, 0, height);
  base.addColorStop(0, '#54382a');
  base.addColorStop(0.45, '#5e4130');
  base.addColorStop(0.55, '#563a2b');
  base.addColorStop(1, '#4c3324');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // Broad tonal blotches (heartwood variation)
  for (let i = 0; i < 26; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const rx = 120 + rand() * 320;
    const ry = 20 + rand() * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rx);
    const dark = rand() > 0.5;
    g.addColorStop(0, dark ? 'rgba(36,22,14,0.12)' : 'rgba(148,108,78,0.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    ctx.translate(-x, -y);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // Grain: long wavy strands
  for (let i = 0; i < 170; i++) {
    const y0 = rand() * height;
    const amp = 1 + rand() * 4;
    const wl = 90 + rand() * 260;
    const phase = rand() * Math.PI * 2;
    const alpha = 0.05 + rand() * 0.12;
    const light = rand() > 0.68;
    ctx.strokeStyle = light
      ? `rgba(158,118,86,${alpha})`
      : `rgba(30,18,11,${alpha})`;
    ctx.lineWidth = 0.6 + rand() * 1.8;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 8) {
      const y =
        y0 +
        Math.sin(x / wl + phase) * amp +
        Math.sin(x / (wl * 0.37) + phase * 2) * amp * 0.4;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Occasional knots
  for (let i = 0; i < 4; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const r = 5 + rand() * 12;
    for (let ring = 4; ring >= 1; ring--) {
      ctx.strokeStyle = `rgba(52,32,16,${0.1 + 0.05 * ring})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(
        x,
        y,
        (r * ring) / 3.2,
        (r * ring) / 4.4,
        0.3,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
  }

  // Fine noise for tooth
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 10;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  return canvas;
}

/**
 * Convert a canvas to a bright neutral (grayscale) version whose mean
 * luminance is `targetMean`, preserving relative grain contrast. Multiplying
 * the result by a material color tint then reproduces the original look for
 * wood tones — and unlocks painted/metal finishes from the same grain.
 */
export function neutralizeCanvas(
  canvas: HTMLCanvasElement,
  targetMean = 235
): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const mean = sum / (d.length / 4) || 1;
  const scale = targetMean / mean;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.max(0, Math.min(255, lum * scale));
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Neutral (tintable) variant of the plank texture. */
export function makeNeutralWoodCanvas(
  seed = 'ovid-wood',
  width = 1024,
  height = 512
): HTMLCanvasElement {
  return neutralizeCanvas(makeWoodCanvas(seed, width, height));
}

/**
 * Wall paneling: wood grain running vertically with V-groove panel seams.
 * One canvas tile covers ~4 world units, i.e. each 128px panel ≈ 0.5 units.
 */
export function makePanelCanvas(seed = 'ovid-panel'): HTMLCanvasElement {
  const size = 1024;
  const wood = makeWoodCanvas(seed, size, size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Rotate the grain to run vertically.
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(wood, -size / 2, -size / 2);
  ctx.restore();

  const rand = seededRandom(seed + ':panels');
  const panel = 128;
  for (let x = 0; x <= size; x += panel) {
    // Slight tone shift per panel so boards read as separate pieces.
    ctx.fillStyle = `rgba(${rand() > 0.5 ? '182,142,104' : '28,17,10'},${
      0.02 + rand() * 0.04
    })`;
    ctx.fillRect(x, 0, panel, size);
    // V-groove: dark seam plus a light catch on its right edge.
    ctx.fillStyle = 'rgba(20,12,7,0.55)';
    ctx.fillRect(x - 2, 0, 3, size);
    ctx.fillStyle = 'rgba(172,132,96,0.14)';
    ctx.fillRect(x + 1, 0, 1, size);
  }
  return canvas;
}

/** Neutral (tintable) variant of the back paneling. */
export function makeNeutralPanelCanvas(seed = 'ovid-panel'): HTMLCanvasElement {
  return neutralizeCanvas(makePanelCanvas(seed));
}

/**
 * Floorboards: horizontal planks with seams and staggered butt joints.
 * One canvas tile covers ~4 world units.
 */
export function makeFloorCanvas(seed = 'ovid-floor'): HTMLCanvasElement {
  const size = 1024;
  const canvas = makeWoodCanvas(seed, size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Deepen the tone: floors read darker than furniture.
  ctx.fillStyle = 'rgba(22,13,8,0.30)';
  ctx.fillRect(0, 0, size, size);

  const rand = seededRandom(seed + ':boards');
  const board = 128;
  for (let y = 0; y <= size; y += board) {
    ctx.fillStyle = `rgba(${rand() > 0.5 ? '170,132,98' : '22,13,8'},${
      0.03 + rand() * 0.05
    })`;
    ctx.fillRect(0, y, size, board);
    ctx.fillStyle = 'rgba(20,12,6,0.6)';
    ctx.fillRect(0, y - 1, size, 2);
    // Staggered butt joints within the row.
    const joints = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < joints; j++) {
      const jx = rand() * size;
      ctx.fillRect(jx, y, 2, board);
    }
  }
  return canvas;
}

/**
 * Transparent shading overlay for the inside of a shelf cavity: darkest up
 * under the board above, easing out toward the middle — a cheap ambient
 * occlusion. Also pinches slightly darker at the left/right ends.
 */
export function makeCavityShadeCanvas(
  width = 512,
  height = 256
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const top = ctx.createLinearGradient(0, 0, 0, height);
  top.addColorStop(0, 'rgba(0,0,0,0.28)');
  top.addColorStop(0.42, 'rgba(0,0,0,0.06)');
  top.addColorStop(0.75, 'rgba(0,0,0,0.02)');
  top.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, width, height);

  const left = ctx.createLinearGradient(0, 0, width * 0.18, 0);
  left.addColorStop(0, 'rgba(0,0,0,0.18)');
  left.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, width, height);

  const right = ctx.createLinearGradient(width, 0, width * 0.82, 0);
  right.addColorStop(0, 'rgba(0,0,0,0.18)');
  right.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = right;
  ctx.fillRect(0, 0, width, height);

  return canvas;
}
