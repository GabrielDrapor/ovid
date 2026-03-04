/**
 * Cover preview debug tool.
 * Generates cover + spine via Gemini, processes spine (crop + despill + resize),
 * returns final images for preview.
 */

import sharp from 'sharp';
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

interface ImageResult {
  data: string;      // base64
  mimeType: string;  // e.g. 'image/png', 'image/jpeg'
}

async function generateImageB64(apiKey: string, prompt: string, maxRetries = 2): Promise<ImageResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await callGemini(apiKey, [{ text: prompt }]);
      for (const candidate of data.candidates || []) {
        for (const part of candidate.content?.parts || []) {
          if (part.inlineData?.data) {
            const b64 = part.inlineData.data;
            const mimeType = part.inlineData.mimeType || 'image/png';

            // Validate: decode and check it's a non-trivial buffer
            const buf = Buffer.from(b64, 'base64');
            if (buf.length < 1000) {
              throw new Error(`Image too small (${buf.length} bytes), likely invalid`);
            }

            // Check magic bytes to identify actual format
            const magic = buf.slice(0, 4).toString('hex');
            console.log(`[cover-preview] attempt=${attempt} mimeType=${mimeType} bufSize=${buf.length} magic=${magic}`);

            // Validate with sharp
            const meta = await sharp(buf).metadata();
            if (!meta.width || !meta.height) {
              throw new Error('Sharp cannot read image dimensions');
            }
            console.log(`[cover-preview] validated format=${meta.format} ${meta.width}x${meta.height}`);

            return { data: b64, mimeType };
          }
        }
      }
      throw new Error('No image in Gemini response');
    } catch (err) {
      console.error(`[cover-preview] attempt=${attempt} error:`, (err as Error).message);
      lastError = err as Error;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
      }
    }
  }
  throw lastError || new Error('Image generation failed');
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

  const coverResult = await generateImageB64(apiKey, coverPrompt);
  const coverB64 = coverResult.data;

  // Step 2: Describe cover
  const description = await describeCover(apiKey, coverB64);

  // Step 3: Generate spine using reference images
  const refSpineUrls = [
    'https://assets.ovid.jrd.pub/ref/spine_stud.png',
    'https://assets.ovid.jrd.pub/ref/spine_advs_02.png',
    'https://assets.ovid.jrd.pub/ref/spine_stranger_v2_spine.png',
  ];

  // Fetch reference spines and encode as base64
  const refSpines = await Promise.all(
    refSpineUrls.map(async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      return buf.toString('base64');
    }),
  );
  const validRefs = refSpines.filter((r): r is string => r !== null);

  const spinePrompt = `Generate a book spine image for "${title}" by ${author}.

I'm showing you ${validRefs.length} reference book spines. Study their format carefully:
- They are NARROW VERTICAL rectangles (approximately 114px wide × 607px tall)
- Text runs VERTICALLY from top to bottom
- Title in LARGE BOLD serif capitals, rotated 90° (reading bottom-to-top)
- Author name at the bottom, smaller
- A small thematic icon/motif at the very top
- Solid colored background, clean and minimal
- NO borders, NO 3D effects, just a flat colored rectangle

Now generate a NEW spine for "${title}" by ${author}:
- Background: ${description.color}
- Style: ${description.style}
- Text color: ${description.accent}
- Must be the SAME narrow vertical format as the references
- Title: "${title.toUpperCase()}"
- Author: "${author.toUpperCase()}"
- Choose a small icon that represents the book's themes
- The output should be a narrow vertical rectangle, NOT a square`;

  // Build parts: reference images + text prompt
  const spineParts: any[] = [];
  for (const ref of validRefs) {
    spineParts.push({ inlineData: { mimeType: 'image/png', data: ref } });
  }
  spineParts.push({ text: spinePrompt });

  const spineData = await callGemini(apiKey, spineParts);
  let spineB64 = '';
  for (const candidate of spineData.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        spineB64 = part.inlineData.data;
        break;
      }
    }
    if (spineB64) break;
  }
  if (!spineB64) throw new Error('No spine image in Gemini response');

  // Step 4: Process images with sharp
  const coverBuf = await sharp(Buffer.from(coverB64, 'base64')).png().toBuffer();
  const spineBuf = await sharp(Buffer.from(spineB64, 'base64')).png().toBuffer();

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

export const LOGIN_HTML = `<!DOCTYPE html>
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
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .login {
    background: #16213e; padding: 2rem; border-radius: 12px;
    display: flex; flex-direction: column; gap: 1rem; width: 320px;
  }
  h1 { font-size: 1.2rem; color: #fff; text-align: center; }
  input {
    padding: 0.6rem 1rem; border-radius: 8px; border: 1px solid #333;
    background: #0f3460; color: #fff; font-size: 1rem;
  }
  button {
    padding: 0.6rem; border-radius: 8px; border: none;
    background: #e94560; color: #fff; font-size: 1rem; cursor: pointer; font-weight: 600;
  }
  .err { color: #e94560; font-size: 0.85rem; text-align: center; display: none; }
</style>
</head>
<body>
<div class="login">
  <h1>🔒 Cover Preview</h1>
  <input id="pw" type="password" placeholder="Password" autofocus
    onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Enter</button>
  <div id="err" class="err">Wrong password</div>
</div>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  const resp = await fetch('/preview/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (resp.ok) {
    window.location.reload();
  } else {
    document.getElementById('err').style.display = 'block';
  }
}
</script>
</body>
</html>`;

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
