#!/usr/bin/env tsx
/**
 * Generate the pool of BLANK cloth hardcover mockups (cover + spine pairs) that
 * uploaded books are composited onto at runtime (see
 * services/translator/src/cover-composer.ts).
 *
 * Approach (per the product design): start from two reference photographs of a
 * blank GRAY cloth hardcover — a front cover and a spine, each a book centered
 * on a light neutral background — and use nano banana (Gemini 2.5 Flash Image)
 * to recolour them into several muted "library cloth" colours, preserving the
 * exact framing/lighting so the runtime face-detection stays uniform.
 *
 * The gray pair is uploaded as-is (the seed). Each generated pair + a manifest
 * are written to R2 under blanks/ via wrangler.
 *
 * Usage:
 *   yarn tsx scripts/generate-blanks.ts
 *   yarn tsx scripts/generate-blanks.ts --only=navy,burgundy   # subset
 *   yarn tsx scripts/generate-blanks.ts --cover=~/g1.jpeg --spine=~/g2.jpeg
 *
 * Requires GEMINI_API_KEY in .env and an authenticated wrangler (R2 access).
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const R2_BUCKET = 'ovid';
const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const expand = (p: string) => p.replace(/^~/, os.homedir());
const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const REF_COVER = expand(arg('cover') || '~/default_gray_01.jpeg');
const REF_SPINE = expand(arg('spine') || '~/default_gray_02.jpeg');

/**
 * The pool. `gray` is the seed (uploaded directly from the references); the
 * rest are recoloured by nano banana. Keep these muted/desaturated so the shelf
 * reads as a row of real cloth-bound books.
 */
const COLORS: { key: string; desc: string; seed?: boolean }[] = [
  { key: 'gray', desc: 'cool neutral gray', seed: true },
  { key: 'navy', desc: 'deep muted navy blue, like dark naval cloth' },
  { key: 'burgundy', desc: 'deep muted burgundy / oxblood maroon' },
  { key: 'forest', desc: 'muted dark forest green' },
  { key: 'tan', desc: 'warm sand / camel linen beige' },
  { key: 'slate', desc: 'dark charcoal slate, almost black' },
];

const recolorPrompt = (desc: string, kind: 'cover' | 'spine') =>
  `This is a photograph of a blank cloth hardcover book ${
    kind === 'spine'
      ? 'spine (a narrow vertical book)'
      : '(front cover facing the camera)'
  }, centered on a light neutral background.

Produce the SAME photograph — identical framing, camera angle, book position, book size, lighting direction, soft drop shadow, and the same light background — but change ONLY the book's cloth binding colour to ${desc}.

Strict requirements:
- Keep it a completely BLANK cover: no text, no title, no author, no logo, no decoration of any kind.
- Preserve the woven cloth/linen fabric texture and the matte hardcover material.
- Do NOT move, rotate, crop, or resize the book; keep the exact same composition and margins.
- Photorealistic studio product shot. Output the full image edge-to-edge.`;

async function generateRecolor(
  apiKey: string,
  refPath: string,
  desc: string,
  kind: 'cover' | 'spine',
  maxRetries = 3
): Promise<Buffer> {
  const refB64 = fs.readFileSync(refPath).toString('base64');
  const mimeType = refPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inlineData: { mimeType, data: refB64 } },
                { text: recolorPrompt(desc, kind) },
              ],
            },
          ],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      });
      if (!resp.ok) {
        throw new Error(
          `Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`
        );
      }
      const data: any = await resp.json();
      for (const cand of data.candidates || []) {
        for (const part of cand.content?.parts || []) {
          if (part.inlineData?.data) {
            const buf = Buffer.from(part.inlineData.data, 'base64');
            if (buf.length < 2000)
              throw new Error(`Image too small (${buf.length}b)`);
            return buf;
          }
        }
      }
      throw new Error('No image in response');
    } catch (err) {
      lastErr = err as Error;
      console.warn(`  attempt ${attempt} failed: ${lastErr.message}`);
      if (attempt < maxRetries)
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
    }
  }
  throw lastErr || new Error('generation failed');
}

const DRY_RUN = process.argv.includes('--dry-run');
const DRY_DIR = expand(arg('out') || './blanks-preview');

function uploadToR2(localPath: string, r2Key: string): void {
  if (DRY_RUN) {
    const dest = path.join(DRY_DIR, r2Key.replace(/\//g, '_'));
    fs.copyFileSync(localPath, dest);
    console.log(`  → (dry-run) ${dest}`);
    return;
  }
  console.log(`  → r2://${R2_BUCKET}/${r2Key}`);
  execSync(
    `npx wrangler r2 object put ${R2_BUCKET}/${r2Key} --file="${localPath}" --remote`,
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');
  for (const p of [REF_COVER, REF_SPINE]) {
    if (!fs.existsSync(p)) throw new Error(`Reference image not found: ${p}`);
  }

  const only = arg('only')
    ?.split(',')
    .map((s) => s.trim());
  const selected = only ? COLORS.filter((c) => only.includes(c.key)) : COLORS;

  if (DRY_RUN) fs.mkdirSync(DRY_DIR, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blanks-'));
  const produced: string[] = [];

  for (const color of selected) {
    console.log(`\n[${color.key}] ${color.desc}`);
    let coverBuf: Buffer;
    let spineBuf: Buffer;

    if (color.seed) {
      coverBuf = fs.readFileSync(REF_COVER);
      spineBuf = fs.readFileSync(REF_SPINE);
      console.log('  seed: using reference images directly');
    } else {
      console.log('  generating cover…');
      coverBuf = await generateRecolor(apiKey, REF_COVER, color.desc, 'cover');
      console.log('  generating spine…');
      spineBuf = await generateRecolor(apiKey, REF_SPINE, color.desc, 'spine');
    }

    const coverPath = path.join(tmp, `${color.key}_cover.png`);
    const spinePath = path.join(tmp, `${color.key}_spine.png`);
    // Normalize to PNG via sharp so R2 always serves a consistent format.
    const sharp = (await import('sharp')).default;
    await sharp(coverBuf).png().toFile(coverPath);
    await sharp(spineBuf).png().toFile(spinePath);

    uploadToR2(coverPath, `blanks/${color.key}_cover.png`);
    uploadToR2(spinePath, `blanks/${color.key}_spine.png`);
    produced.push(color.key);
  }

  // Merge into any existing manifest so subset runs don't drop colours.
  let existing: string[] = [];
  if (DRY_RUN) {
    console.log(`\n✅ Dry run complete. Previews in ${DRY_DIR}`);
    return;
  }
  try {
    existing = JSON.parse(
      execSync(
        `npx wrangler r2 object get ${R2_BUCKET}/blanks/manifest.json --remote --pipe`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
    ).colors;
  } catch {
    /* no manifest yet */
  }
  const colors = Array.from(new Set([...existing, ...produced]));
  const manifestPath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ colors }, null, 2));
  uploadToR2(manifestPath, 'blanks/manifest.json');

  console.log(`\n✅ Done. Pool colours: ${colors.join(', ')}`);
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
