/**
 * Generate book cover and spine images using Gemini 2.5 Flash Image.
 * Designed to run inside a Cloudflare Worker (uses fetch, R2).
 *
 * v2: No reference images — each book gets a unique style.
 * Spine uses green-screen (#00FF00) background; post-processing
 * (crop + despill + resize) is done by the Railway cover-processor service.
 */

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const R2_PUBLIC_BASE = 'https://assets.ovid.jrd.pub';

interface CoverResult {
  coverUrl: string;
  spineUrl: string;
}

/**
 * Call Gemini API to generate an image (text-only prompt).
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
Line 2: The overall design style in a few words (e.g. "Art Deco geometric", "gothic ornamental")
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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

/**
 * Generate cover and spine, upload raw images to R2,
 * then webhook Railway service for post-processing.
 *
 * Flow:
 * 1. Generate cover (unique style per book)
 * 2. Describe cover style via Gemini
 * 3. Generate spine on green-screen background
 * 4. Upload raw images to R2
 * 5. Webhook Railway cover-processor for crop + despill + resize + DB update
 */
export async function generateBookCovers(
  apiKey: string,
  bucket: R2Bucket,
  title: string,
  author: string,
  bookUuid: string,
  translatorUrl: string,
  translatorSecret: string,
): Promise<CoverResult> {
  const slug = slugify(title);
  const uniqueId = crypto.randomUUID().slice(0, 8);
  const keyPrefix = `${slug}_${uniqueId}`;

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

  // --- Step 3: Generate spine on green screen ---
  const spinePrompt = `A flat front-facing book spine on bright solid lime green (#00FF00) background. The spine is a narrow vertical dark rectangle, centered, with green space on all sides.

Design for "${title}" by ${author}:
- Background color: ${color} (matching the book's cover)
- Style: ${style}
- LARGE, BOLD ${accent} text filling most of the spine width — must be readable at thumbnail size
- Title "${title.toUpperCase()}" running vertically in LARGE BOLD capitals
- Author "${author.toUpperCase()}" at the bottom, also reasonably large
- A small decorative motif at the top matching the cover's aesthetic
- Simple border lines on left and right edges
- Keep decoration MINIMAL — prioritize text legibility
- The rectangle should be about 1/6 the width of the total image
- Sharp edges, no shadows, no 3D effects, no page edges visible`;

  const spineBuf = await generateImage(apiKey, spinePrompt);

  // --- Step 4: Upload raw images to R2 ---
  const rawCoverKey = `raw/${keyPrefix}_cover.png`;
  const rawSpineKey = `raw/${keyPrefix}_spine.png`;

  await bucket.put(rawCoverKey, coverBuf, {
    httpMetadata: { contentType: 'image/png' },
  });
  await bucket.put(rawSpineKey, spineBuf, {
    httpMetadata: { contentType: 'image/png' },
  });

  const rawCoverUrl = `${R2_PUBLIC_BASE}/${rawCoverKey}`;
  const rawSpineUrl = `${R2_PUBLIC_BASE}/${rawSpineKey}`;

  // --- Step 5: Webhook translator service for post-processing ---
  if (translatorUrl) {
    const webhookResp = await fetch(`${translatorUrl}/process-cover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: translatorSecret,
        bookUuid,
        rawCoverUrl,
        rawSpineUrl,
        keyPrefix,
      }),
    });

    if (!webhookResp.ok) {
      console.error('Cover processing webhook failed:', await webhookResp.text());
      // Fallback: use raw images directly
      return { coverUrl: rawCoverUrl, spineUrl: rawSpineUrl };
    }
  } else {
    // No translator service — use raw images
    return { coverUrl: rawCoverUrl, spineUrl: rawSpineUrl };
  }

  // Return the final URLs (processor will upload to these keys)
  return {
    coverUrl: `${R2_PUBLIC_BASE}/${keyPrefix}_cover.png`,
    spineUrl: `${R2_PUBLIC_BASE}/${keyPrefix}_spine.png`,
  };
}
