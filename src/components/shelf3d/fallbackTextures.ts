// Canvas-generated stand-in artwork for books that have no spine/cover image
// (or while the real image is still loading).

export function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00ffffff).toString(16).toUpperCase();
  return '#' + '00000'.substring(0, 6 - c.length) + c;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, ((n >> 16) & 0xff) + amount));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + amount));
  const b = Math.min(255, Math.max(0, (n & 0xff) + amount));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Average color of a loaded image, darkened a touch — used as the cloth
 * color for a book's back cover and page-edge rims. */
export function averageColor(
  img: CanvasImageSource & { width: number; height: number },
  fallback = '#3a3026'
): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 6;
    canvas.height = 6;
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallback;
    ctx.drawImage(img, 0, 0, 6, 6);
    const d = ctx.getImageData(0, 0, 6, 6).data;
    let r = 0,
      g = 0,
      b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    const dim = 0.82;
    return `rgb(${Math.round((r / n) * dim)}, ${Math.round((g / n) * dim)}, ${Math.round(
      (b / n) * dim
    )})`;
  } catch {
    return fallback;
  }
}

/**
 * Page-block edge texture: cream paper with fine striations (the stacked
 * sheets) and a thin cloth-colored rim where the cover boards overhang.
 * Striations run along the canvas's vertical axis, which matches both the
 * top face (lines along depth) and the fore edge (lines along height).
 */
export function makePageEdgesCanvas(cloth: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#eee2c9';
  ctx.fillRect(0, 0, 256, 256);

  // Sheet striations
  for (let x = 0; x < 256; x += 2) {
    const a = 0.05 + Math.abs(Math.sin(x * 12.9898)) * 0.1;
    ctx.fillStyle =
      x % 6 < 2 ? `rgba(120,100,70,${a})` : `rgba(255,250,236,${a})`;
    ctx.fillRect(x, 0, 1, 256);
  }
  // Soft shading toward the rims
  const shade = ctx.createLinearGradient(0, 0, 256, 0);
  shade.addColorStop(0, 'rgba(90,70,45,0.22)');
  shade.addColorStop(0.12, 'rgba(90,70,45,0)');
  shade.addColorStop(0.88, 'rgba(90,70,45,0)');
  shade.addColorStop(1, 'rgba(90,70,45,0.22)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 256, 256);

  // Cloth rim: the cover boards overhanging the page block
  ctx.strokeStyle = cloth;
  ctx.lineWidth = 18;
  ctx.strokeRect(0, 0, 256, 256);

  return canvas;
}

/**
 * Ghost spine for an empty upload slot: just a plus glyph in the shelf's
 * cream ink on a transparent background. Same 112x560 aspect as a real
 * spine so it sits in the slot undistorted.
 */
export function makeUploadGhostCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 112;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const arm = 16;
  ctx.strokeStyle = 'rgba(255, 246, 226, 0.9)';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy);
  ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm);
  ctx.lineTo(cx, cy + arm);
  ctx.stroke();

  return canvas;
}

export function makeSpineCanvas(title: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 112;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const base = stringToColor(title);
  const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
  grad.addColorStop(0, shade(base, -30));
  grad.addColorStop(0.5, base);
  grad.addColorStop(1, shade(base, -45));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(255, 250, 240, 0.92)';
  ctx.font = '600 40px Georgia, "Songti SC", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let text = title;
  while (text.length > 1 && ctx.measureText(text).width > canvas.height - 60) {
    text = text.slice(0, -2) + '…';
  }
  ctx.fillText(text, 0, 0);
  ctx.restore();

  return canvas;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
}

function isPlaceholderTitle(title: string): boolean {
  return title.trim().toLowerCase() === 'processing...';
}

export function makeProcessingSpineCanvas(
  title: string,
  progress: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 112;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const p = clampProgress(progress);
  const fog = 0.62 * (1 - p);
  const blur = 8 * (1 - p);

  const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
  grad.addColorStop(0, '#4c4942');
  grad.addColorStop(0.45, '#777268');
  grad.addColorStop(1, '#393730');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Soft cloth grain and bands. Low progress keeps this intentionally out of
  // focus; high progress reveals a more book-like spine.
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  for (let y = 0; y < canvas.height; y += 18) {
    const alpha = 0.05 + Math.abs(Math.sin(y * 0.07)) * 0.04;
    ctx.fillStyle = `rgba(255, 246, 226, ${alpha * (0.4 + p)})`;
    ctx.fillRect(10, y, canvas.width - 20, 3);
  }
  const shine = ctx.createLinearGradient(0, 0, canvas.width, 0);
  shine.addColorStop(0, 'rgba(255,255,255,0)');
  shine.addColorStop(0.55, `rgba(255,255,255,${0.12 + p * 0.18})`);
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!isPlaceholderTitle(title) && p > 0.45) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = `rgba(255, 250, 240, ${(p - 0.45) / 0.55})`;
    ctx.font = '600 38px Georgia, "Songti SC", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let text = title;
    while (
      text.length > 1 &&
      ctx.measureText(text).width > canvas.height - 70
    ) {
      text = text.slice(0, -2) + '...';
    }
    ctx.fillText(text, 0, 0);
  } else {
    ctx.fillStyle = `rgba(255, 250, 240, ${0.12 + p * 0.18})`;
    ctx.fillRect(canvas.width / 2 - 10, 90, 20, canvas.height - 180);
  }
  ctx.restore();

  ctx.fillStyle = `rgba(238, 232, 220, ${fog})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = `rgba(255, 250, 240, ${0.18 + p * 0.3})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 5, canvas.width - 8, canvas.height - 10);

  return canvas;
}

export function makeProcessingCoverCanvas(
  title: string,
  author: string,
  progress: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 880;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const p = clampProgress(progress);
  const fog = 0.58 * (1 - p);
  const blur = 10 * (1 - p);

  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, '#6f695f');
  grad.addColorStop(0.52, '#45423b');
  grad.addColorStop(1, '#898174');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  ctx.strokeStyle = `rgba(255, 250, 240, ${0.22 + p * 0.36})`;
  ctx.lineWidth = 5;
  ctx.strokeRect(42, 42, canvas.width - 84, canvas.height - 84);

  if (!isPlaceholderTitle(title) && p > 0.45) {
    ctx.fillStyle = `rgba(255, 250, 240, ${(p - 0.45) / 0.55})`;
    ctx.textAlign = 'center';
    ctx.font = '600 50px Georgia, "Songti SC", serif';
    const lines = wrapText(ctx, title, canvas.width - 150);
    const startY = canvas.height / 2 - ((lines.length - 1) * 62) / 2 - 40;
    lines.forEach((line, i) => {
      ctx.fillText(line, canvas.width / 2, startY + i * 62);
    });
    if (author) {
      ctx.font = '400 30px Georgia, "Songti SC", serif';
      ctx.fillStyle = `rgba(255, 250, 240, ${0.35 + p * 0.35})`;
      ctx.fillText(author, canvas.width / 2, canvas.height - 130);
    }
  } else {
    ctx.fillStyle = `rgba(255, 250, 240, ${0.12 + p * 0.22})`;
    ctx.fillRect(150, 310, 300, 28);
    ctx.fillRect(190, 360, 220, 20);
    ctx.fillRect(230, 700, 140, 16);
  }
  ctx.restore();

  ctx.fillStyle = `rgba(238, 232, 220, ${fog})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  return canvas;
}

export function makeCoverCanvas(
  title: string,
  author: string
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 880;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const base = stringToColor(title);
  ctx.fillStyle = shade(base, -20);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255, 250, 240, 0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(36, 36, canvas.width - 72, canvas.height - 72);

  ctx.fillStyle = 'rgba(255, 250, 240, 0.95)';
  ctx.textAlign = 'center';
  ctx.font = '600 52px Georgia, "Songti SC", serif';
  const lines = wrapText(ctx, title, canvas.width - 140);
  const startY = canvas.height / 2 - ((lines.length - 1) * 64) / 2 - 60;
  lines.forEach((line, i) => {
    ctx.fillText(line, canvas.width / 2, startY + i * 64);
  });

  ctx.font = '400 32px Georgia, "Songti SC", serif';
  ctx.fillStyle = 'rgba(255, 250, 240, 0.75)';
  ctx.fillText(author, canvas.width / 2, canvas.height - 130);

  return canvas;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  let current = '';
  // Split on spaces for latin text; fall back to per-character for CJK.
  const units = text.includes(' ') ? text.split(' ') : Array.from(text);
  const joiner = text.includes(' ') ? ' ' : '';
  for (const unit of units) {
    const candidate = current ? current + joiner + unit : unit;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}
