/**
 * Admin cover preview page — debug tool for testing cover/spine generation.
 */

import { Env } from './types';

/** Serve the admin cover preview HTML page. */
export function serveAdminCoversPage(): Response {
  return new Response(ADMIN_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Generate cover + spine preview (no DB update, no R2 upload). */
export async function handleCoverPreview(request: Request, env: Env): Promise<Response> {
  const { title, author } = await request.json<{ title: string; author: string }>();

  if (!title || !author) {
    return Response.json({ error: 'Missing title or author' }, { status: 400 });
  }

  if (!env.GEMINI_API_KEY) {
    return Response.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent';

  async function generateImage(prompt: string): Promise<string> {
    const resp = await fetch(`${GEMINI_API_URL}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as any;
    for (const candidate of data.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.inlineData?.data) {
          return part.inlineData.data; // base64
        }
      }
    }
    throw new Error('No image in Gemini response');
  }

  async function describeCover(b64: string): Promise<{ color: string; style: string; accent: string }> {
    const resp = await fetch(`${GEMINI_API_URL}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: 'image/png', data: b64 } },
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

  try {
    // Generate cover
    const coverPrompt = `Book cover for "${title}" by ${author}. Portrait orientation, approximately 3:4 ratio.

Design a visually striking, elegant book cover with a style that fits the book's themes and era. Be creative — Art Deco, gothic, minimalist, impressionist, or any style that suits the book.

Requirements:
- Title "${title.toUpperCase()}" prominently displayed in elegant typography
- Author "${author.toUpperCase()}" at the bottom in smaller text
- The design must fill the ENTIRE image edge to edge with NO white borders
- Rich, atmospheric, visually compelling`;

    const coverB64 = await generateImage(coverPrompt);

    // Describe cover
    const { color, style, accent } = await describeCover(coverB64);

    // Generate spine on green screen
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

    const spineB64 = await generateImage(spinePrompt);

    return Response.json({
      cover: `data:image/png;base64,${coverB64}`,
      spine: `data:image/png;base64,${spineB64}`,
      description: { color, style, accent },
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

const ADMIN_HTML = `<!DOCTYPE html>
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
  .results {
    display: flex; gap: 2rem; flex-wrap: wrap; align-items: flex-start;
  }
  .card {
    background: #16213e; border-radius: 12px; padding: 1rem;
    display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
  }
  .card h3 { font-size: 0.9rem; color: #999; text-transform: uppercase; letter-spacing: 0.05em; }
  .card img { border-radius: 4px; }
  .cover-img { max-width: 300px; }
  .spine-img { max-height: 400px; }
  .status {
    padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem;
    font-size: 0.9rem;
  }
  .status.loading { background: #1a3a5c; color: #7ec8e3; }
  .status.error { background: #3c1418; color: #e94560; }
  .status.success { background: #1a3c2a; color: #4ecca3; }
  .meta { font-size: 0.8rem; color: #666; margin-top: 0.5rem; }
  .description {
    background: #0f3460; padding: 0.75rem 1rem; border-radius: 8px;
    font-size: 0.85rem; margin-bottom: 1rem; line-height: 1.5;
  }
  .description span { color: #7ec8e3; }
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
  status.textContent = '⏳ Generating cover and spine... (this takes 20-40s)';
  results.innerHTML = '';
  desc.innerHTML = '';

  const start = Date.now();

  try {
    const resp = await fetch('/api/admin/cover-preview', {
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

    results.innerHTML = \`
      <div class="card">
        <h3>Cover</h3>
        <img class="cover-img" src="\${data.cover}" alt="Cover">
      </div>
      <div class="card">
        <h3>Spine (raw green screen)</h3>
        <img class="spine-img" src="\${data.spine}" alt="Spine">
      </div>
    \`;
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
