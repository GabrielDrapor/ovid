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
