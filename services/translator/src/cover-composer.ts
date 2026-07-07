/**
 * Runtime cover/spine composition (pure Sharp — no AI at request time).
 *
 * Design: every uploaded book is placed onto a pre-generated blank cloth
 * hardcover "mockup" (a photo of a blank book centered on a light background,
 * see scripts/generate-blanks.ts). We then:
 *   - Cover: paste the book's real (embedded) cover as a smaller plate in the
 *     upper-center of the front face, with the title + author typeset below it.
 *     With no embedded cover we just typeset the title + author.
 *   - Spine: typeset the title + author vertically.
 *
 * The blank templates are AI-generated once and vary slightly, so we DETECT
 * the book's face rectangle against the uniform light background rather than
 * hard-coding coordinates. Text colour auto-contrasts against the cloth.
 */

import sharp from 'sharp';

export interface ComposeInput {
  /** Blank cloth front-cover mockup (book centered on a light background). */
  templateCover: Buffer;
  /** Blank cloth spine mockup (book centered on a light background). */
  templateSpine: Buffer;
  /** The book's own embedded cover, if the EPUB had one. */
  originalCover?: Buffer | null;
  title: string;
  /** Optional shorter title for the spine, where horizontal room is limited. */
  spineTitle?: string;
  author: string;
  /**
   * Spine width multiplier (book thickness). 1 = the template's native width;
   * <1 thinner, >1 thicker. Derived from the book's length by the caller. The
   * cloth is stretched horizontally BEFORE the text is printed, so the title
   * stays undistorted while the spine (and its 3D lighting) widens.
   */
  spineThickness?: number;
}

export interface ComposeResult {
  cover: Buffer;
  spine: Buffer;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Final output caps (preserve natural ratio, bound file size). */
const MAX_COVER_HEIGHT = 900;
const MAX_SPINE_HEIGHT = 900;

/**
 * Map a book's total source length (sum of chapter raw_html chars) to a spine
 * width multiplier — thicker books get visibly wider spines on the shelf. The
 * sqrt curve compresses the wide range of book lengths into a tasteful band,
 * clamped to [0.7, 1.7]× the template's native width.
 */
export function spineThicknessFromLength(htmlLen: number): number {
  const LO = 150000;
  const HI = 900000;
  const t =
    (Math.sqrt(Math.max(0, htmlLen)) - Math.sqrt(LO)) /
    (Math.sqrt(HI) - Math.sqrt(LO));
  return Math.max(0.7, Math.min(1.7, 0.7 + t));
}

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Detect the book's bounding box at full resolution: the tightest rectangle
 * containing pixels that differ STRONGLY from the uniform light background.
 *
 * A high threshold means the box hugs the SOLID book — the soft contact shadow
 * and anti-aliased edge (which differ from the backdrop only slightly) fall
 * outside it. Cropping to this box therefore yields the book flush to the image
 * edges, with no shadow halo or background margin. Pixel-exact (no downscale).
 */
async function detectBookBox(buffer: Buffer): Promise<Box> {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;

  const at = (x: number, y: number) => {
    const i = (y * W + x) * ch;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // Background colour = average of the four corners.
  const corners = [at(1, 1), at(W - 2, 1), at(1, H - 2), at(W - 2, H - 2)];
  const bg = [0, 1, 2].map(
    (k) => corners.reduce((s, c) => s + c[k], 0) / corners.length
  );

  // A pixel is "book" if it is colourful OR clearly darker than the backdrop.
  // The backdrop and the soft shadow are both NEUTRAL grey (low chroma, not very
  // dark); the cloth is either chromatic (tan/navy/burgundy/forest/slate) or
  // neutral-but-much-darker (gray cloth). This keeps light tan cloth while
  // rejecting the grey shadow.
  const CHROMA = 18; // backdrop/shadow chroma ~2-6; cloth ≥ ~40
  const DARK = 130; // gray cloth differs ~250; shadow differs < ~110
  const isBook = (x: number, y: number) => {
    const i = (y * W + x) * ch;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const diff =
      Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
    return chroma > CHROMA || diff > DARK;
  };

  // Use COLUMN then ROW projections, not raw min/max extremes: the book is the
  // dense block where most of a line is book. Keeping only lines whose book-count
  // clears half the peak rejects stray outliers — e.g. the bluish top glow beside
  // the navy spine — that would otherwise balloon the box, and trims tilted
  // corners. Rows are counted only WITHIN the column range so a column outlier
  // (the glow) can't inflate the row peak and collapse the height.
  const colCount = new Int32Array(W);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (isBook(x, y)) colCount[x]++;
  let maxCol = 0;
  for (let x = 0; x < W; x++) if (colCount[x] > maxCol) maxCol = colCount[x];

  if (maxCol === 0) {
    // Detection failed — assume the centre 40%×80% of the canvas.
    return {
      left: Math.round(W * 0.3),
      top: Math.round(H * 0.1),
      width: Math.round(W * 0.4),
      height: Math.round(H * 0.8),
    };
  }

  const colThresh = maxCol * 0.5;
  let minX = -1,
    maxX = -1;
  for (let x = 0; x < W; x++)
    if (colCount[x] >= colThresh) {
      if (minX < 0) minX = x;
      maxX = x;
    }

  const rowCount = new Int32Array(H);
  for (let y = 0; y < H; y++)
    for (let x = minX; x <= maxX; x++) if (isBook(x, y)) rowCount[y]++;
  let maxRow = 0;
  for (let y = 0; y < H; y++) if (rowCount[y] > maxRow) maxRow = rowCount[y];
  const rowThresh = maxRow * 0.5;
  let minY = -1,
    maxY = -1;
  for (let y = 0; y < H; y++)
    if (rowCount[y] >= rowThresh) {
      if (minY < 0) minY = y;
      maxY = y;
    }

  // The projection already excludes the slightly-tilted corners (those lines
  // fall below the half-peak threshold), so the bbox is flush to the book with
  // no background — crop to it directly, with NO inset (insetting here was what
  // trimmed into the book face).
  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/** Mean luminance of the cloth inside the face box (sub-sampled). */
async function faceLuminance(buffer: Buffer, box: Box): Promise<number> {
  const { data, info } = await sharp(buffer)
    .extract({
      left: box.left,
      top: box.top,
      width: Math.max(1, box.width),
      height: Math.max(1, box.height),
    })
    .resize(40, 40, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let sum = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    const r = data[i * ch],
      g = data[i * ch + 1],
      b = data[i * ch + 2];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return sum / n;
}

/** Approximate text width: CJK glyphs ~1.0em, latin ~0.55em. */
function glyphAdvance(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text)
    w += /[　-鿿＀-￯]/.test(ch) ? fontSize : fontSize * 0.55;
  return w;
}

/** Greedy word-wrap to a max pixel width (no truncation — callers size to fit). */
export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number
): string[] {
  const hasSpaces = /\s/.test(text.trim());
  const units = hasSpaces ? text.trim().split(/\s+/) : Array.from(text.trim());
  const sep = hasSpaces ? ' ' : '';
  const lines: string[] = [];
  let cur = '';
  for (const u of units) {
    const tentative = cur ? cur + sep + u : u;
    if (glyphAdvance(tentative, fontSize) > maxWidth && cur) {
      lines.push(cur);
      cur = u;
    } else {
      cur = tentative;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Largest font size (≤ start) at which `text`, wrapped to `maxWidth`, fits
 * within `maxHeight`. Shrinks so the WHOLE title shows rather than truncating.
 */
export function fitWrapped(
  text: string,
  startSize: number,
  maxWidth: number,
  maxHeight: number
): { size: number; lines: string[] } {
  const floor = Math.max(8, Math.round(startSize * 0.5));
  let size = startSize;
  for (; size > floor; size = Math.round(size * 0.92)) {
    const lines = wrapText(text, size, maxWidth);
    if (lines.length * (size * 1.18) <= maxHeight) return { size, lines };
  }
  return { size: floor, lines: wrapText(text, floor, maxWidth) };
}

/**
 * Compose the front cover: blank template + (optional) original-cover plate +
 * title/author typeset below.
 */
async function composeCover(input: ComposeInput): Promise<Buffer> {
  const { templateCover, originalCover, title, author } = input;
  const base = sharp(templateCover).removeAlpha();
  const meta = await base.metadata();
  const W = meta.width || 1408;
  const box = await detectBookBox(templateCover);
  const lum = await faceLuminance(templateCover, box);
  const ink = lum < 140 ? '#f1ede4' : '#262420';
  const inkSoft = lum < 140 ? '#d8d2c6' : '#403b34';

  const layers: sharp.OverlayOptions[] = [];

  // Geometry relative to the detected face.
  const authorSize = Math.round(box.width * 0.05);
  const cx = box.left + box.width / 2;

  let textTop: number;

  if (originalCover) {
    // Resize the real cover to a plate ~55% of the face width, preserving ratio.
    const om = await sharp(originalCover).metadata();
    const ow = om.width || 437;
    const oh = om.height || 606;
    const plateW = Math.round(box.width * 0.55);
    const plateH = Math.round(plateW * (oh / ow));
    const plateX = Math.round(box.left + (box.width - plateW) / 2);
    const plateY = Math.round(box.top + box.height * 0.16);

    const plate = await sharp(originalCover)
      .resize(plateW, plateH, { fit: 'fill' })
      .png()
      .toBuffer();

    // A thin shadow plate behind the cover so it reads as an inset label.
    const frame = Math.max(2, Math.round(plateW * 0.012));
    const shadowSvg = Buffer.from(
      `<svg width="${plateW + frame * 2}" height="${plateH + frame * 2}" xmlns="http://www.w3.org/2000/svg">
         <rect x="0" y="0" width="${plateW + frame * 2}" height="${plateH + frame * 2}"
               fill="rgba(0,0,0,0.28)"/>
       </svg>`
    );
    layers.push({
      input: shadowSvg,
      left: plateX - frame,
      top: plateY - frame,
    });
    layers.push({ input: plate, left: plateX, top: plateY });

    textTop = plateY + plateH + Math.round(box.height * 0.07);
  } else {
    textTop = Math.round(box.top + box.height * 0.3);
  }

  // Title (wrapped) + author, centered, drawn as one SVG over the full canvas.
  // The title font shrinks so the WHOLE title fits between the inset and the
  // author line — long titles wrap to more lines rather than being cut off.
  const bottomLimit = box.top + box.height - Math.round(box.height * 0.05);
  const titleMaxH = bottomLimit - textTop - Math.round(authorSize * 2.2);
  const { size: titleSize, lines: titleLines } = fitWrapped(
    title,
    Math.round(box.width * 0.085),
    box.width * 0.84,
    Math.max(titleMaxH, Math.round(box.width * 0.1))
  );
  const lineGap = Math.round(titleSize * 1.18);
  const svgH = meta.height || 768;
  let ty = textTop + titleSize;
  const titleTspans = titleLines
    .map((ln) => {
      const t = `<text x="${cx}" y="${ty}" text-anchor="middle" font-family="Georgia, 'Noto Serif', 'Songti SC', 'Noto Serif CJK SC', serif" font-size="${titleSize}" font-weight="600" fill="${ink}">${escapeXml(ln)}</text>`;
      ty += lineGap;
      return t;
    })
    .join('');
  const authorY = ty + Math.round(authorSize * 0.6);
  const authorText = author
    ? `<text x="${cx}" y="${authorY}" text-anchor="middle" font-family="Georgia, 'Noto Serif', 'Songti SC', 'Noto Serif CJK SC', serif" font-size="${authorSize}" font-style="italic" fill="${inkSoft}">${escapeXml(author)}</text>`
    : '';

  const textSvg = Buffer.from(
    `<svg width="${W}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">${titleTspans}${authorText}</svg>`
  );
  layers.push({ input: textSvg, left: 0, top: 0 });

  const composited = await base.composite(layers).png().toBuffer();

  // Crop flush to the book so the image IS the cover — no background margin.
  return cropToBook(composited, box, MAX_COVER_HEIGHT);
}

/** Compose the spine: blank template + vertical title/author. */
async function composeSpine(input: ComposeInput): Promise<Buffer> {
  const { author } = input;
  const title = input.spineTitle || input.title;

  // Apply book thickness: stretch the cloth horizontally BEFORE detecting the
  // spine and printing text, so the spine widens (with its 3D lighting) while
  // the title stays undistorted.
  const thickness = input.spineThickness ?? 1;
  let templateSpine = input.templateSpine;
  if (thickness !== 1) {
    const m = await sharp(templateSpine).metadata();
    templateSpine = await sharp(templateSpine)
      .resize({
        width: Math.max(1, Math.round((m.width || 1408) * thickness)),
        height: m.height || 768,
        fit: 'fill',
      })
      .toBuffer();
  }

  const box = await detectBookBox(templateSpine);
  const lum = await faceLuminance(templateSpine, box);
  const ink = lum < 140 ? '#f1ede4' : '#262420';
  const inkSoft = lum < 140 ? '#d8d2c6' : '#403b34';

  // Render text horizontally on a transparent strip sized to the ROTATED spine
  // face (so width = face height, height = face width), then rotate 90° CW.
  const stripW = box.height;
  const stripH = box.width;
  const padX = Math.round(stripW * 0.06);

  // Fit title + author along the spine length so long titles shrink to show in
  // full rather than running off the end. Title takes the bulk, author the tail.
  const avail = stripW - padX * 2;
  const authorReserve = author ? avail * 0.3 : 0;
  const gap = author ? stripH * 0.4 : 0;
  const titleSpace = avail - authorReserve - gap;
  const titleSize = Math.max(
    7,
    Math.min(
      Math.round(stripH * 0.42),
      Math.floor(titleSpace / Math.max(1, glyphAdvance(title, 1)))
    )
  );
  const authorSize = author
    ? Math.max(
        6,
        Math.min(
          Math.round(stripH * 0.26),
          Math.floor(authorReserve / Math.max(1, glyphAdvance(author, 1)))
        )
      )
    : 0;

  // Title left-anchored (becomes top after CW rotation), author right (bottom).
  const titleStr = escapeXml(title);
  const authorStr = author ? escapeXml(author) : '';
  const midY = stripH / 2;
  const strip = Buffer.from(
    `<svg width="${stripW}" height="${stripH}" xmlns="http://www.w3.org/2000/svg">
       <text x="${padX}" y="${midY}" dominant-baseline="middle" text-anchor="start"
             font-family="Georgia, 'Noto Serif', 'Songti SC', 'Noto Serif CJK SC', serif"
             font-size="${titleSize}" font-weight="600" fill="${ink}">${titleStr}</text>
       ${
         authorStr
           ? `<text x="${stripW - padX}" y="${midY}" dominant-baseline="middle" text-anchor="end"
             font-family="Georgia, 'Noto Serif', 'Songti SC', 'Noto Serif CJK SC', serif"
             font-size="${authorSize}" font-style="italic" fill="${inkSoft}">${authorStr}</text>`
           : ''
       }
     </svg>`
  );
  const rotated = await sharp(strip).rotate(90).png().toBuffer();

  const composited = await sharp(templateSpine)
    .removeAlpha()
    .composite([{ input: rotated, left: box.left, top: box.top }])
    .png()
    .toBuffer();

  return cropToBook(composited, box, MAX_SPINE_HEIGHT);
}

/**
 * Crop the composited image FLUSH to the detected book box, then make the
 * book's ROUNDED-CORNER background transparent. The hardcover has rounded
 * corners, so a flush rectangular crop still keeps light-neutral triangles of
 * mockup backdrop at the corners — invisible on a light page, but they show as
 * white specks on the dark shelf. Flood-filling that backdrop from the border to
 * transparency means nothing light survives on any background. Then cap height.
 */
async function cropToBook(
  buffer: Buffer,
  box: Box,
  maxHeight: number
): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const IW = meta.width || 1408;
  const IH = meta.height || 768;

  // Clamp the book box to the image bounds.
  const left = Math.max(0, Math.min(box.left, IW - 1));
  const top = Math.max(0, Math.min(box.top, IH - 1));
  const width = Math.max(1, Math.min(box.width, IW - left));
  const height = Math.max(1, Math.min(box.height, IH - top));

  const { data, info } = await sharp(buffer)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels; // 4 (RGBA)

  // Light-neutral backdrop only: high luminance + low chroma. Cloth (even light
  // tan ~170 luma, and the dark colours) stays below the luma cutoff or above
  // the chroma cutoff, so the flood never eats the book.
  const isBackdrop = (p: number) => {
    const r = data[p],
      g = data[p + 1],
      b = data[p + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    return lum > 185 && chroma < 18;
  };

  // Flood backdrop inward from the whole border; set those pixels transparent.
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const visit = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const idx = y * W + x;
    if (seen[idx]) return;
    seen[idx] = 1;
    if (!isBackdrop(idx * ch)) return;
    data[idx * ch + 3] = 0; // transparent
    stack.push(idx);
  };
  for (let x = 0; x < W; x++) {
    visit(x, 0);
    visit(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    visit(0, y);
    visit(W - 1, y);
  }
  while (stack.length) {
    const idx = stack.pop() as number;
    const x = idx % W;
    const y = (idx / W) | 0;
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }

  let pipe = sharp(Buffer.from(data), {
    raw: { width: W, height: H, channels: 4 },
  });
  if (H > maxHeight) {
    pipe = pipe.resize({ height: maxHeight });
  }
  return pipe.png().toBuffer();
}

/** Compose both cover and spine for a book. */
export async function composeBookImages(
  input: ComposeInput
): Promise<ComposeResult> {
  const [cover, spine] = await Promise.all([
    composeCover(input),
    composeSpine(input),
  ]);
  return { cover, spine };
}
