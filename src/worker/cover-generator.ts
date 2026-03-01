/**
 * Generate book cover and spine images using Gemini 2.5 Flash Image.
 * Designed to run inside a Cloudflare Worker (uses fetch, R2).
 *
 * v2: No reference images — each book gets a unique style.
 * Spine uses flat 2D prompt with large text for thumbnail legibility.
 */

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const R2_PUBLIC_BASE = 'https://assets.ovid.jrd.pub';

interface CoverResult {
  coverUrl: string;
  spineUrl: string;
}

/**
 * Call Gemini API to generate an image (text-only prompt, no reference images).
 */
async function generateImage(apiKey: string, prompt: string): Promise<ArrayBuffer> {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
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

  const data = (await resp.json()) as any;
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
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
 * Ask Gemini to describe the cover's visual style (text-only response).
 * Used to make the spine visually consistent with the cover.
 */
async function describeCoverStyle(
  apiKey: string,
  coverB64: string,
): Promise<{ color: string; style: string; accent: string }> {
  const resp = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/png', data: coverB64 } },
          {
            text: `Describe this book cover in exactly 3 lines:
Line 1: The primary background color (e.g. "deep midnight blue", "burnt orange")
Line 2: The overall design style in a few words (e.g. "Art Deco geometric", "gothic ornamental", "minimalist")
Line 3: The accent/text color (e.g. "gold", "cream", "silver")
Respond with ONLY these 3 lines, nothing else.`,
          },
        ],
      }],
      generationConfig: { responseModalities: ['TEXT'] },
    }),
  });

  const defaults = { color: 'a distinctive thematic color', style: 'elegant', accent: 'gold' };
  if (!resp.ok) return defaults;

  const data = (await resp.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const lines = text.trim().split('\n').filter((l: string) => l.trim());

  return {
    color: lines[0]?.trim() || defaults.color,
    style: lines[1]?.trim() || defaults.style,
    accent: lines[2]?.trim() || defaults.accent,
  };
}

/**
 * Convert ArrayBuffer to base64 string.
 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Create a filename-safe slug.
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
 *
 * Flow:
 * 1. Generate cover (no reference image — unique style per book)
 * 2. Describe cover style via Gemini text-only call
 * 3. Generate spine as flat 2D graphic matching cover style
 * 4. Upload both to R2
 */
export async function generateBookCovers(
  apiKey: string,
  bucket: R2Bucket,
  title: string,
  author: string,
): Promise<CoverResult> {
  const slug = slugify(title);
  const uniqueId = crypto.randomUUID().slice(0, 8);

  // --- Step 1: Generate cover ---
  const coverPrompt = `Book cover for "${title}" by ${author}. Portrait orientation, approximately 3:4 ratio.

Design a visually striking, elegant book cover with a style that fits the book's themes and era. Be creative — Art Deco, gothic, minimalist, impressionist, or any style that suits the book.

Requirements:
- Title "${title.toUpperCase()}" prominently displayed in elegant typography
- Author "${author.toUpperCase()}" at the bottom in smaller text
- The design must fill the ENTIRE image edge to edge with NO white borders
- Rich, atmospheric, visually compelling`;

  const coverBuf = await generateImage(apiKey, coverPrompt);
  const coverB64 = arrayBufferToBase64(coverBuf);

  // --- Step 2: Describe cover for spine consistency ---
  const { color, style, accent } = await describeCoverStyle(apiKey, coverB64);

  // --- Step 3: Generate spine ---
  const spinePrompt = `A FLAT 2D book spine graphic on a pure white (#FFFFFF) background. NOT a photograph — a completely flat digital design with zero shadows, zero 3D effects.

The spine is a narrow vertical RECTANGLE with sharp edges, centered in the image. The white background surrounds it on all sides.

Design for "${title}" by ${author}:
- Rectangle fill: solid ${color} (matching the book's cover)
- Style: ${style}
- LARGE, BOLD ${accent} text filling most of the spine width — must be readable at thumbnail size
- Title "${title.toUpperCase()}" running vertically in LARGE BOLD capitals
- Author "${author.toUpperCase()}" at the bottom, also reasonably large
- A small decorative motif at the top
- Simple border lines on left and right edges
- Keep decoration MINIMAL — prioritize text legibility over ornament
- The rectangle should be about 1/6 the width of the total image
- NO shadows, NO rounded edges, NO page edges`;

  const spineBuf = await generateImage(apiKey, spinePrompt);

  // --- Step 4: Upload to R2 ---
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
