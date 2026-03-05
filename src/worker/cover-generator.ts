/**
 * Generate book cover and spine images using Gemini 2.5 Flash Image.
 * Designed to run inside a Cloudflare Worker (uses fetch, R2).
 *
 * v3: Style diversity — each book gets a randomly assigned visual style
 * from a curated pool to prevent Art Deco/gold convergence.
 * Spine uses green-screen (#00FF00) background; post-processing
 * (crop + despill + resize) is done by the Railway cover-processor service.
 */

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const R2_PUBLIC_BASE = 'https://assets.ovid.jrd.pub';

/**
 * Curated style pool — each entry defines a distinct visual direction.
 * The generator picks one at random per book to ensure diversity.
 */
const STYLE_POOL = [
  {
    name: 'Woodblock Print',
    cover: 'Japanese ukiyo-e woodblock print style. Bold outlines, flat color areas, traditional compositions. Limited palette of 4-5 colors.',
    palette: 'muted indigo, vermillion, cream, and sage green',
    textStyle: 'bold serif capitals in cream or white',
  },
  {
    name: 'Swiss Modernist',
    cover: 'Swiss International Typographic Style. Strong grid layout, bold sans-serif type as the main visual element, geometric shapes. Clean and austere.',
    palette: 'white background with black, one bold accent color (red or yellow)',
    textStyle: 'large Helvetica-style sans-serif in black or the accent color',
  },
  {
    name: 'Risograph Illustration',
    cover: 'Risograph-style illustration with visible grain, limited ink colors, slight misregistration. Playful, indie, tactile feel.',
    palette: 'two-tone risograph inks — e.g. fluorescent pink and teal, or orange and blue',
    textStyle: 'hand-drawn or chunky sans-serif lettering in one of the ink colors',
  },
  {
    name: 'Vintage Penguin',
    cover: 'Classic Penguin paperback design: horizontal color bands, clean typography, minimal illustration. Simple and iconic.',
    palette: 'three horizontal bands — a signature color (orange, green, or blue) with white/cream center band',
    textStyle: 'clean serif type centered on the white band',
  },
  {
    name: 'Watercolor Botanical',
    cover: 'Soft watercolor botanical illustration. Delicate plant/flower motifs framing the title. Airy, light, organic.',
    palette: 'soft greens, dusty rose, warm cream, touches of gold',
    textStyle: 'elegant thin serif in dark green or brown',
  },
  {
    name: 'Soviet Constructivist',
    cover: 'Soviet Constructivist poster style. Bold diagonal compositions, photomontage feel, strong geometric shapes, propaganda-poster energy.',
    palette: 'red, black, cream/off-white',
    textStyle: 'bold angular sans-serif in red or black, tilted at dynamic angles',
  },
  {
    name: 'Psychedelic 60s',
    cover: 'Late 1960s psychedelic poster art. Flowing organic lettering, vibrant saturated colors, swirling patterns, op-art influences.',
    palette: 'electric purple, hot pink, acid green, orange',
    textStyle: 'flowing Art Nouveau-inspired hand lettering that melts into the illustration',
  },
  {
    name: 'Minimal Geometric',
    cover: 'Ultra-minimal design. One or two geometric shapes as metaphor for the book\'s theme. Maximum negative space. Conceptual.',
    palette: 'monochrome with one accent — e.g. all black with a single red circle',
    textStyle: 'small, understated sans-serif in a corner or along an edge',
  },
  {
    name: 'Noir Paperback',
    cover: 'Pulp noir paperback style from the 1940s-50s. Dramatic shadows, venetian blind lighting, moody atmospheric scene.',
    palette: 'deep shadows, muted yellows and blues, smoky grays',
    textStyle: 'bold condensed type in yellow or white, slightly distressed',
  },
  {
    name: 'Folk Art Pattern',
    cover: 'Eastern European or Scandinavian folk art. Symmetrical decorative patterns, stylized animals or flowers, naive flat perspective.',
    palette: 'rich folk colors — deep red, forest green, cobalt blue, gold accents on dark background',
    textStyle: 'decorative serif or slab-serif centered in a clear cartouche',
  },
  {
    name: 'Collage Mixed Media',
    cover: 'Cut-paper collage style. Torn edges, layered textures, mixed found imagery. Handmade, editorial, contemporary.',
    palette: 'varied paper textures — newsprint, colored paper, kraft brown, pops of bright color',
    textStyle: 'ransom-note style mixed typefaces or clean modern type contrasting with the collage',
  },
  {
    name: 'Line Drawing',
    cover: 'Single continuous line drawing or fine pen illustration. White or light background, intricate detail, intellectual feel.',
    palette: 'white background with black or dark ink lines, optional one spot color',
    textStyle: 'refined serif type, well-spaced, in black',
  },
];

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
 * 1. Pick random style from curated pool
 * 2. Generate cover with that style
 * 3. Generate spine on green-screen with same style
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

  // --- Step 1: Pick a random style ---
  const style = STYLE_POOL[Math.floor(Math.random() * STYLE_POOL.length)];

  // --- Step 2: Generate cover ---
  const coverPrompt = `Book cover for "${title}" by ${author}. Portrait orientation, approximately 3:4 ratio.

Visual style: ${style.name} — ${style.cover}
Color palette: ${style.palette}
Typography: ${style.textStyle}

Requirements:
- Title "${title.toUpperCase()}" prominently displayed
- Author "${author.toUpperCase()}" at the bottom in smaller text
- The design must fill the ENTIRE image edge to edge with NO white borders
- Commit fully to the ${style.name} aesthetic — do NOT default to Art Deco or dark blue/gold`;

  const coverBuf = await generateImage(apiKey, coverPrompt);

  // --- Step 3: Generate spine on green screen (reuse style info directly) ---
  const spinePrompt = `A flat front-facing book spine on bright solid lime green (#00FF00) background. The spine is a narrow vertical rectangle, centered, with green space on all sides.

Design for "${title}" by ${author}:
- Visual style: ${style.name}
- Color palette: ${style.palette}
- Typography: ${style.textStyle}
- Title "${title.toUpperCase()}" running vertically in LARGE BOLD capitals — must be readable at thumbnail size
- Author "${author.toUpperCase()}" at the bottom, also reasonably large
- A small decorative motif at the top
- Keep decoration MINIMAL — prioritize text legibility
- The rectangle should be about 1/6 the width of the total image
- Sharp edges, no shadows, no 3D effects, no page edges visible
- CRITICAL: All text must be FULLY CONTAINED within the spine rectangle with generous margins on ALL sides. Leave at least 10% padding on left and right sides.`;

  const spineBuf = await generateImage(apiKey, spinePrompt);

  // --- Step 4: Upload raw images to R2 ---
  console.log(`Cover style for ${bookUuid}: ${style.name}`);
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
