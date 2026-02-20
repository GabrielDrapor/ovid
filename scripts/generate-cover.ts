#!/usr/bin/env ts-node

/**
 * Generate book cover and spine images using Gemini 2.5 Flash Image.
 * Uses reference images from existing books for consistent style.
 * Uploads results to Cloudflare R2.
 *
 * Usage:
 *   yarn generate-cover --title="The Stranger" --author="Albert Camus"
 *   yarn generate-cover --title="The Stranger" --author="Albert Camus" --description="A novel about existential alienation in Algeria"
 *
 * Can also be imported and used programmatically:
 *   const { generateBookImages } = require('./generate-cover');
 *   const urls = await generateBookImages({ title, author, description });
 */

import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';

// Reference images for style consistency
const REFERENCE_COVER_URL = 'https://assets.ovid.jrd.pub/stud_01.png';
const REFERENCE_SPINE_URL = 'https://assets.ovid.jrd.pub/stud_02.png';

// R2 bucket and public URL
const R2_BUCKET = 'ovid';
const R2_PUBLIC_BASE = 'https://assets.ovid.jrd.pub';

interface GenerateOptions {
  title: string;
  author: string;
  description?: string;
  color?: string; // e.g. "deep burnt orange", "dark teal", "forest green"
  icon?: string; // e.g. "sun starburst", "paw print", "magnifying glass"
}

interface GenerateResult {
  coverUrl: string;
  spineUrl: string;
  coverPath: string;
  spinePath: string;
}

/**
 * Download a file from URL to local path
 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadFile(res.headers.location!, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(); });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * Call Gemini 2.5 Flash Image API to generate an image
 */
function generateImage(
  apiKey: string,
  prompt: string,
  ...referenceImages: string[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: any[] = [];

    // Add reference images
    for (const refB64 of referenceImages) {
      if (refB64) {
        parts.push({
          inlineData: {
            mimeType: 'image/png',
            data: refB64,
          },
        });
      }
    }

    // Add text prompt
    parts.push({ text: prompt });

    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`;
    const urlObj = new URL(url);

    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 120000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');

          if (res.statusCode !== 200) {
            reject(new Error(`Gemini API error ${res.statusCode}: ${responseBody.slice(0, 500)}`));
            return;
          }

          try {
            const data = JSON.parse(responseBody);
            for (const candidate of data.candidates || []) {
              for (const part of candidate.content?.parts || []) {
                if (part.text) {
                  console.log(`   🤖 Model: ${part.text.slice(0, 200)}`);
                }
                if (part.inlineData) {
                  const imgBuf = Buffer.from(part.inlineData.data, 'base64');
                  resolve(imgBuf);
                  return;
                }
              }
            }
            reject(new Error('No image in Gemini response'));
          } catch (e) {
            reject(new Error(`Failed to parse Gemini response: ${e}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini API request timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Upload a file to R2 using wrangler
 */
function uploadToR2(localPath: string, r2Key: string): void {
  const cwd = path.resolve(__dirname, '..');
  execSync(
    `npx wrangler r2 object put ${R2_BUCKET}/${r2Key} --file="${localPath}" --remote`,
    { cwd, stdio: 'pipe' }
  );
}

/**
 * Generate a filename-safe slug from a book title
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

/**
 * Main function: generate cover and spine, upload to R2
 */
export async function generateBookImages(options: GenerateOptions): Promise<GenerateResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  const { title, author, description, color, icon } = options;
  const slug = slugify(title);
  const tmpDir = path.resolve(__dirname, '..', '.tmp_covers');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Download reference images
  console.log('   📥 Downloading reference images...');
  const refCoverPath = path.join(tmpDir, 'ref_cover.png');
  const refSpinePath = path.join(tmpDir, 'ref_spine.png');

  // Use cached reference images if they exist
  if (!fs.existsSync(refCoverPath)) {
    await downloadFile(REFERENCE_COVER_URL, refCoverPath);
  }
  if (!fs.existsSync(refSpinePath)) {
    await downloadFile(REFERENCE_SPINE_URL, refSpinePath);
  }

  const refCoverB64 = fs.readFileSync(refCoverPath).toString('base64');
  const refSpineB64 = fs.readFileSync(refSpinePath).toString('base64');

  // Build cover prompt
  const colorHint = color || 'a distinctive color that is NOT white and NOT the same red as the reference';
  const iconHint = icon || 'a simple, iconic symbol relevant to the book\'s content';
  const descHint = description ? ` The book is about: ${description}.` : '';

  const coverPrompt = `Look at how this reference image works: the book cover graphic fills the ENTIRE image with zero margin. The background color goes all the way to every edge of the image. There is absolutely no white space, no border, no gap between the design and the image boundary.

Now generate a new cover in the same format for the book "${title}" by ${author}.${descHint}

Requirements:
- The background color must touch ALL FOUR edges of the image. No white pixels anywhere on the borders.
- Background color: ${colorHint} (solid, matte)
- Central icon: ${iconHint}, rendered as a flat cream/off-white silhouette
- Title "${title.toUpperCase()}" in cream/off-white elegant serif font, centered
- Author "${author.toUpperCase()}" in smaller cream serif text at bottom, centered
- Minimalist, two-tone only (background color + cream). No illustrations, no decorative borders.
- Same clean, modern aesthetic as the reference.`;

  // Generate cover first
  console.log('   🎨 Generating cover...');
  const coverBuf = await generateImage(apiKey, coverPrompt, refCoverB64);
  const coverPath = path.join(tmpDir, `${slug}_cover.png`);
  fs.writeFileSync(coverPath, coverBuf);
  console.log(`   ✅ Cover saved: ${coverPath} (${coverBuf.length} bytes)`);

  // Step 2: Ask model to describe cover's color and icon
  console.log('   🔍 Analyzing cover design...');
  const coverB64 = coverBuf.toString('base64');
  let coverColor = 'a distinctive color matching the book\'s theme';
  let coverIcon = 'a simple thematic icon';
  
  try {
    const descResult = await new Promise<string>((resolve, reject) => {
      const descBody = JSON.stringify({
        contents: [{ parts: [
          { inlineData: { mimeType: 'image/png', data: coverB64 } },
          { text: 'Describe this book cover in exactly 2 lines:\nLine 1: The exact background color (e.g. "deep navy blue", "burnt orange", "forest green")\nLine 2: The central icon/symbol (e.g. "a sun starburst", "a magnifying glass", "a paw print")\nRespond with ONLY these 2 lines, nothing else.' },
        ] }],
        generationConfig: { responseModalities: ['TEXT'] },
      });
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`;
      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(descBody) },
        timeout: 30000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const data = JSON.parse(body);
          resolve(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
        });
      });
      req.on('error', reject);
      req.write(descBody);
      req.end();
    });
    
    const lines = descResult.trim().split('\n').filter(l => l.trim());
    if (lines.length >= 2) {
      coverColor = lines[0].trim();
      coverIcon = lines[1].trim();
    }
    console.log(`   ✅ Cover: ${coverColor} | ${coverIcon}`);
  } catch (e) {
    console.warn('   ⚠️ Could not analyze cover, using defaults');
  }

  // Step 3: Generate spine with only reference spine + text description
  const spinePrompt = `This is a reference book spine image. Generate a new book spine matching this EXACT format and aspect ratio — a very THIN, NARROW vertical strip (approximately 1:8 width-to-height ratio, like the reference).

New spine for "${title}" by ${author}:
- Background color: ${coverColor} (MUST match exactly — this is the same color as the book's front cover)
- Small icon at the very top: ${coverIcon} (same as the front cover, but tiny)
- Title "${title.toUpperCase()}" running vertically in cream/off-white serif font
- Author "${author.toUpperCase()}" at the bottom in smaller cream text
- SAME minimalist two-tone style as the reference
- The spine must be as THIN and NARROW as the reference image — do NOT make it wider`;

  console.log('   🎨 Generating spine...');
  const spineBuf = await generateImage(apiKey, spinePrompt, refSpineB64);
  const spinePath = path.join(tmpDir, `${slug}_spine.png`);
  fs.writeFileSync(spinePath, spineBuf);
  console.log(`   ✅ Spine saved: ${spinePath} (${spineBuf.length} bytes)`);

  // Upload to R2
  const uniqueId = Date.now().toString(36);
  const coverKey = `${slug}_${uniqueId}_cover.png`;
  const spineKey = `${slug}_${uniqueId}_spine.png`;

  console.log('   ☁️  Uploading to R2...');
  uploadToR2(coverPath, coverKey);
  console.log(`   ✅ Cover uploaded: ${R2_PUBLIC_BASE}/${coverKey}`);
  uploadToR2(spinePath, spineKey);
  console.log(`   ✅ Spine uploaded: ${R2_PUBLIC_BASE}/${spineKey}`);

  // Clean up temp files
  fs.unlinkSync(coverPath);
  fs.unlinkSync(spinePath);

  return {
    coverUrl: `${R2_PUBLIC_BASE}/${coverKey}`,
    spineUrl: `${R2_PUBLIC_BASE}/${spineKey}`,
    coverPath: coverKey,
    spinePath: spineKey,
  };
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const options: any = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        options[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        options[arg.slice(2)] = true;
      }
    }
  }

  if (options.help || !options.title || !options.author) {
    console.log(`
🎨 Ovid Cover Generator

Generates book cover and spine images using AI, uploads to R2.

Usage:
  yarn generate-cover --title="The Stranger" --author="Albert Camus"

Options:
  --title         Book title (required)
  --author        Book author (required)
  --description   Brief book description (helps with icon/color choice)
  --color         Background color hint (e.g. "deep teal", "forest green")
  --icon          Icon hint (e.g. "sun", "paw print", "magnifying glass")
  --help          Show this help

Environment Variables:
  GEMINI_API_KEY    Gemini API key (required)
`);
    process.exit(0);
  }

  try {
    const result = await generateBookImages(options);
    console.log('\n🎉 Done!');
    console.log(`   Cover: ${result.coverUrl}`);
    console.log(`   Spine: ${result.spineUrl}`);
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
