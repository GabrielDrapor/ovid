/**
 * Cover preview debug tool.
 * Generates cover + spine via Gemini, processes spine (crop + despill + resize),
 * returns final images for preview.
 */

import { processSpine, processCover } from './image-processor.js';

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface PreviewResult {
  cover: string;       // data URI
  spine: string;       // data URI (processed)
  spineRaw: string;    // data URI (green screen original)
  description: { color: string; style: string; accent: string };
}

async function callGemini(apiKey: string, parts: any[], responseModalities: string[] = ['TEXT', 'IMAGE']): Promise<any> {
  const resp = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  return resp.json();
}

async function generateImageB64(apiKey: string, prompt: string): Promise<string> {
  const data = await callGemini(apiKey, [{ text: prompt }]);
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) return part.inlineData.data;
    }
  }
  throw new Error('No image in Gemini response');
}

async function describeCover(apiKey: string, coverB64: string): Promise<{ color: string; style: string; accent: string }> {
  const data = await callGemini(apiKey, [
    { inlineData: { mimeType: 'image/png', data: coverB64 } },
    {
      text: `Describe this book cover in exactly 3 lines:
Line 1: The primary background color (e.g. "deep midnight blue", "burnt orange")
Line 2: The overall design style in a few words (e.g. "Art Deco geometric", "gothic ornamental")
Line 3: The accent/text color (e.g. "gold", "cream", "silver")
Respond with ONLY these 3 lines, nothing else.`,
    },
  ], ['TEXT']);

  const defaults = { color: 'a distinctive thematic color', style: 'elegant', accent: 'gold' };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const lines = text.trim().split('\n').filter((l: string) => l.trim());

  return {
    color: lines[0]?.trim() || defaults.color,
    style: lines[1]?.trim() || defaults.style,
    accent: lines[2]?.trim() || defaults.accent,
  };
}

export async function generatePreview(apiKey: string, title: string, author: string): Promise<PreviewResult> {
  // Step 1: Generate cover
  const coverPrompt = `Book cover for "${title}" by ${author}. Portrait orientation, approximately 3:4 ratio.

Design a visually striking, elegant book cover with a style that fits the book's themes and era. Be creative — Art Deco, gothic, minimalist, impressionist, or any style that suits the book.

Requirements:
- Title "${title.toUpperCase()}" prominently displayed in elegant typography
- Author "${author.toUpperCase()}" at the bottom in smaller text
- The design must fill the ENTIRE image edge to edge with NO white borders
- Rich, atmospheric, visually compelling`;

  const coverB64 = await generateImageB64(apiKey, coverPrompt);

  // Step 2: Describe cover
  const description = await describeCover(apiKey, coverB64);

  // Step 3: Generate spine on green screen
  const spinePrompt = `A flat front-facing book spine on bright solid lime green (#00FF00) background. The spine is a narrow vertical dark rectangle, centered, with green space on all sides.

Design for "${title}" by ${author}:
- Background color: ${description.color} (matching the book's cover)
- Style: ${description.style}
- LARGE, BOLD ${description.accent} text filling most of the spine width — must be readable at thumbnail size
- Title "${title.toUpperCase()}" running vertically in LARGE BOLD capitals
- Author "${author.toUpperCase()}" at the bottom, also reasonably large
- A small decorative motif at the top matching the cover's aesthetic
- Simple border lines on left and right edges
- Keep decoration MINIMAL — prioritize text legibility
- The rectangle should be about 1/6 the width of the total image
- Sharp edges, no shadows, no 3D effects, no page edges visible`;

  const spineB64 = await generateImageB64(apiKey, spinePrompt);

  // Step 4: Process images with sharp
  const coverBuf = Buffer.from(coverB64, 'base64');
  const spineBuf = Buffer.from(spineB64, 'base64');

  const [finalCover, finalSpine] = await Promise.all([
    processCover(coverBuf),
    processSpine(spineBuf),
  ]);

  return {
    cover: `data:image/png;base64,${finalCover.toString('base64')}`,
    spine: `data:image/png;base64,${finalSpine.toString('base64')}`,
    spineRaw: `data:image/png;base64,${spineB64}`,
    description,
  };
}

export const PREVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ovid — Cover Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e; color: #e0e0e0;
    min-height: 100vh; padding: 2rem;
  }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; color: #fff; }
  .form { display: flex; gap: 0.75rem; margin-bottom: 2rem; flex-wrap: wrap; }
  input {
    padding: 0.6rem 1rem; border-radius: 8px; border: 1px solid #333;
    background: #16213e; color: #fff; font-size: 1rem; flex: 1; min-width: 200px;
  }
  input::placeholder { color: #666; }
  button {
    padding: 0.6rem 1.5rem; border-radius: 8px; border: none;
    background: #e94560; color: #fff; font-size: 1rem; cursor: pointer;
    font-weight: 600; transition: opacity 0.2s;
  }
  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .results { display: flex; gap: 2rem; flex-wrap: wrap; align-items: flex-start; }
  .card {
    background: #16213e; border-radius: 12px; padding: 1rem;
    display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
  }
  .card h3 { font-size: 0.9rem; color: #999; text-transform: uppercase; letter-spacing: 0.05em; }
  .card img { border-radius: 4px; }
  .cover-img { max-width: 300px; }
  .spine-raw { max-height: 300px; }
  .spine-final { height: 300px; image-rendering: auto; }
  .status { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
  .status.loading { background: #1a3a5c; color: #7ec8e3; }
  .status.error { background: #3c1418; color: #e94560; }
  .status.success { background: #1a3c2a; color: #4ecca3; }
  .description {
    background: #0f3460; padding: 0.75rem 1rem; border-radius: 8px;
    font-size: 0.85rem; margin-bottom: 1rem; line-height: 1.5;
  }
  .description span { color: #7ec8e3; }
  .size { font-size: 0.75rem; color: #555; }
</style>
</head>
<body>
<h1>📚 Cover Preview</h1>

<div class="form">
  <input id="title" placeholder="Book title" value="The Great Gatsby">
  <input id="author" placeholder="Author" value="F. Scott Fitzgerald">
  <button id="btn" onclick="generate()">Generate</button>
</div>

<div id="status"></div>
<div id="desc"></div>
<div id="results" class="results"></div>

<script>
async function generate() {
  const title = document.getElementById('title').value.trim();
  const author = document.getElementById('author').value.trim();
  if (!title || !author) return;

  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  const results = document.getElementById('results');
  const desc = document.getElementById('desc');

  btn.disabled = true;
  btn.textContent = 'Generating...';
  status.className = 'status loading';
  status.textContent = '⏳ Generating cover and spine... (this takes 30-60s)';
  results.innerHTML = '';
  desc.innerHTML = '';

  const start = Date.now();

  try {
    const resp = await fetch('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author }),
    });

    const data = await resp.json();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (data.error) {
      status.className = 'status error';
      status.textContent = '❌ ' + data.error;
      return;
    }

    status.className = 'status success';
    status.textContent = '✅ Generated in ' + elapsed + 's';

    if (data.description) {
      desc.className = 'description';
      desc.innerHTML = 'Cover style → <span>' + data.description.color +
        '</span> · <span>' + data.description.style +
        '</span> · <span>' + data.description.accent + '</span>';
    }

    results.innerHTML =
      '<div class="card">' +
        '<h3>Cover (437×606)</h3>' +
        '<img class="cover-img" src="' + data.cover + '">' +
      '</div>' +
      '<div class="card">' +
        '<h3>Spine processed (114×607)</h3>' +
        '<img class="spine-final" src="' + data.spine + '">' +
      '</div>' +
      '<div class="card">' +
        '<h3>Spine raw (green screen)</h3>' +
        '<img class="spine-raw" src="' + data.spineRaw + '">' +
      '</div>';
  } catch (err) {
    status.className = 'status error';
    status.textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}
</script>
</body>
</html>`;
