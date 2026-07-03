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
