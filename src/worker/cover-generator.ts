/**
 * Generate book cover and spine images using Gemini 2.5 Flash Image.
 * Designed to run inside a Cloudflare Worker (uses fetch, R2).
 */

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Reference images (cached as base64 after first download)
const REFERENCE_COVER_URL = 'https://assets.ovid.jrd.pub/stud_01.png';
const REFERENCE_SPINE_URL = 'https://assets.ovid.jrd.pub/stud_02.png';

const R2_PUBLIC_BASE = 'https://assets.ovid.jrd.pub';

interface CoverResult {
  coverUrl: string;
  spineUrl: string;
}

/**
 * Download image and return as base64
 */
async function fetchImageAsBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  // Convert to base64
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Call Gemini API to generate an image
 */
async function generateImage(
  apiKey: string,
  prompt: string,
  ...referenceImages: string[]
): Promise<ArrayBuffer> {
  const parts: any[] = [];
  for (const refB64 of referenceImages) {
    if (refB64) {
      parts.push({ inlineData: { mimeType: 'image/png', data: refB64 } });
    }
  }
  parts.push({ text: prompt });

  const body = {
    contents: [{
      parts,
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  const resp = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json() as any;
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        // Decode base64 to ArrayBuffer
        const binary = atob(part.inlineData.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
      }
    }
  }
  throw new Error('No image in Gemini response');
}

/**
 * Create a filename-safe slug
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

/**
 * Generate cover and spine, upload to R2, return public URLs.
 */
export async function generateBookCovers(
  apiKey: string,
  bucket: R2Bucket,
  title: string,
  author: string
): Promise<CoverResult> {
  const slug = slugify(title);
  const uniqueId = crypto.randomUUID().slice(0, 8);

  // Download reference images
  const [refCoverB64, refSpineB64] = await Promise.all([
    fetchImageAsBase64(REFERENCE_COVER_URL),
    fetchImageAsBase64(REFERENCE_SPINE_URL),
  ]);

  const coverPrompt = `Look at how this reference image works: the book cover graphic fills the ENTIRE image with zero margin. The background color goes all the way to every edge of the image. There is absolutely no white space, no border, no gap between the design and the image boundary.

Now generate a new cover in the same format for the book "${title}" by ${author}.

Requirements:
- The background color must touch ALL FOUR edges of the image. No white pixels anywhere on the borders.
- Background color: a distinctive color that is NOT white (solid, matte). Choose a color relevant to the book's themes.
- Central icon: a simple, iconic symbol relevant to the book's content, rendered as a flat cream/off-white silhouette
- Title "${title.toUpperCase()}" in cream/off-white elegant serif font, centered
- Author "${author.toUpperCase()}" in smaller cream serif text at bottom, centered
- Minimalist, two-tone only (background color + cream). No illustrations, no decorative borders.
- Same clean, modern aesthetic as the reference.`;

  // Generate cover first
  const coverBuf = await generateImage(apiKey, coverPrompt, refCoverB64);

  // Convert cover to base64 so we can feed it as reference for the spine
  const coverBytes = new Uint8Array(coverBuf);
  let coverBinary = '';
  for (let i = 0; i < coverBytes.length; i++) {
    coverBinary += String.fromCharCode(coverBytes[i]);
  }
  const coverB64 = btoa(coverBinary);

  // Step 2: Ask model to describe the cover's color and icon (text-only)
  const describeResp = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/png', data: coverB64 } },
          { text: 'Describe this book cover in exactly 2 lines:\nLine 1: The exact background color (e.g. "deep navy blue", "burnt orange", "forest green")\nLine 2: The central icon/symbol (e.g. "a sun starburst", "a magnifying glass", "a paw print")\nRespond with ONLY these 2 lines, nothing else.' },
        ],
      }],
      generationConfig: { responseModalities: ['TEXT'] },
    }),
  });
  
  let coverColor = 'a distinctive color matching the book\'s theme';
  let coverIcon = 'a simple thematic icon';
  
  if (describeResp.ok) {
    const descData = await describeResp.json() as any;
    const descText = descData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const lines = descText.trim().split('\n').filter((l: string) => l.trim());
    if (lines.length >= 2) {
      coverColor = lines[0].trim();
      coverIcon = lines[1].trim();
    }
  }

  // Step 3: Generate spine with only reference spine image + cover description in text
  const spinePrompt = `This is a reference book spine image. Generate a new book spine matching this EXACT format and aspect ratio — a very THIN, NARROW vertical strip (approximately 1:8 width-to-height ratio, like the reference).

New spine for "${title}" by ${author}:
- Background color: ${coverColor} (MUST match exactly — this is the same color as the book's front cover)
- Small icon at the very top: ${coverIcon} (same as the front cover, but tiny)
- Title "${title.toUpperCase()}" running vertically in cream/off-white serif font
- Author "${author.toUpperCase()}" at the bottom in smaller cream text
- SAME minimalist two-tone style as the reference
- The spine must be as THIN and NARROW as the reference image — do NOT make it wider`;

  const spineBuf = await generateImage(apiKey, spinePrompt, refSpineB64);

  // Upload to R2
  const coverKey = `${slug}_${uniqueId}_cover.png`;
  const spineKey = `${slug}_${uniqueId}_spine.png`;

  await bucket.put(coverKey, coverBuf, {
    httpMetadata: { contentType: 'image/png' },
  });
  await bucket.put(spineKey, spineBuf, {
    httpMetadata: { contentType: 'image/png' },
  });

  return {
    coverUrl: `${R2_PUBLIC_BASE}/${coverKey}`,
    spineUrl: `${R2_PUBLIC_BASE}/${spineKey}`,
  };
}
