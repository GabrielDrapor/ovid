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

  // Base: vertical-ish gradient of warm browns
  const base = ctx.createLinearGradient(0, 0, 0, height);
  base.addColorStop(0, '#8a5c33');
  base.addColorStop(0.45, '#96683c');
  base.addColorStop(0.55, '#8d5f36');
  base.addColorStop(1, '#7d5330');
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
    g.addColorStop(0, dark ? 'rgba(70,44,22,0.10)' : 'rgba(214,164,106,0.08)');
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
    const alpha = 0.03 + rand() * 0.09;
    const light = rand() > 0.72;
    ctx.strokeStyle = light
      ? `rgba(226,180,120,${alpha})`
      : `rgba(58,36,18,${alpha})`;
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
  top.addColorStop(0, 'rgba(0,0,0,0.52)');
  top.addColorStop(0.42, 'rgba(0,0,0,0.10)');
  top.addColorStop(0.75, 'rgba(0,0,0,0.04)');
  top.addColorStop(1, 'rgba(0,0,0,0.30)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, width, height);

  const left = ctx.createLinearGradient(0, 0, width * 0.18, 0);
  left.addColorStop(0, 'rgba(0,0,0,0.38)');
  left.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, width, height);

  const right = ctx.createLinearGradient(width, 0, width * 0.82, 0);
  right.addColorStop(0, 'rgba(0,0,0,0.38)');
  right.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = right;
  ctx.fillRect(0, 0, width, height);

  return canvas;
}
