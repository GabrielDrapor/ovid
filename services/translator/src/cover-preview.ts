/**
 * Cover preview debug tool.
 *
 * Upload an EPUB → the page shows the extracted embedded cover, the cover's
 * dominant colour, how each blank cloth template ranks against it (方案1:
 * dominant colour → nearest template cloth), and the final composed cover +
 * spine produced by the same pure-Sharp pipeline production uses.
 *
 * The HTML below is served by index.ts (`GET /preview`); the matching API is
 * `POST /preview` (multipart, field `file`). Note: the preview skips the LLM
 * title sanitizer (it needs an OpenAI round-trip), so a book whose title gets
 * sanitized at upload time may typeset slightly differently in production.
 */

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
  <h1>Cover Preview</h1>
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
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #fff; }
  .sub { font-size: 0.85rem; color: #888; margin-bottom: 1.5rem; }
  .form { display: flex; gap: 0.75rem; margin-bottom: 2rem; flex-wrap: wrap; align-items: center; }
  input[type=file] {
    padding: 0.5rem; border-radius: 8px; border: 1px dashed #445;
    background: #16213e; color: #ccc; font-size: 0.9rem; flex: 1; min-width: 260px;
  }
  button {
    padding: 0.6rem 1.5rem; border-radius: 8px; border: none;
    background: #e94560; color: #fff; font-size: 1rem; cursor: pointer;
    font-weight: 600; transition: opacity 0.2s;
  }
  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .status { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
  .status.loading { background: #1a3a5c; color: #7ec8e3; }
  .status.error { background: #3c1418; color: #e94560; }
  .status.success { background: #1a3c2a; color: #4ecca3; }
  .meta {
    background: #0f3460; padding: 0.75rem 1rem; border-radius: 8px;
    font-size: 0.85rem; margin-bottom: 1rem; line-height: 1.6;
  }
  .meta span { color: #7ec8e3; }
  .swatch {
    display: inline-block; width: 14px; height: 14px; border-radius: 3px;
    vertical-align: -2px; margin-right: 4px; border: 1px solid rgba(255,255,255,0.25);
  }
  table { border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.85rem; }
  th, td { padding: 0.35rem 0.9rem; text-align: left; border-bottom: 1px solid #223; }
  th { color: #889; font-weight: 600; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.05em; }
  tr.chosen td { color: #4ecca3; font-weight: 600; }
  .results { display: flex; gap: 2rem; flex-wrap: wrap; align-items: flex-start; }
  .card {
    background: #16213e; border-radius: 12px; padding: 1rem;
    display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
  }
  .card h3 { font-size: 0.9rem; color: #999; text-transform: uppercase; letter-spacing: 0.05em; }
  .card img { border-radius: 4px; }
  .card .none { color: #667; font-size: 0.85rem; padding: 2rem 1rem; }
  .cover-img { max-height: 320px; max-width: 300px; }
  .spine-img { height: 320px; }
</style>
</head>
<body>
<h1>Cover Preview</h1>
<div class="sub">Upload an EPUB — extracts its embedded cover, matches the nearest cloth template by dominant colour, and composes the cover + spine exactly as production would (title is NOT LLM-sanitized here).</div>

<div class="form">
  <input id="file" type="file" accept=".epub,application/epub+zip">
  <button id="btn" onclick="generate()">Compose</button>
</div>

<div id="status"></div>
<div id="meta"></div>
<div id="candidates"></div>
<div id="results" class="results"></div>

<script>
function rgbCss(c) { return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }
function swatch(c) { return '<span class="swatch" style="background:' + rgbCss(c) + '"></span>'; }

async function generate() {
  const fileInput = document.getElementById('file');
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  const meta = document.getElementById('meta');
  const candidates = document.getElementById('candidates');
  const results = document.getElementById('results');

  btn.disabled = true;
  btn.textContent = 'Composing...';
  status.className = 'status loading';
  status.textContent = 'Parsing EPUB and composing images...';
  meta.innerHTML = '';
  candidates.innerHTML = '';
  results.innerHTML = '';

  const start = Date.now();

  try {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/preview', { method: 'POST', body: fd });
    const data = await resp.json();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (data.error) {
      status.className = 'status error';
      status.textContent = data.error;
      return;
    }

    status.className = 'status success';
    status.textContent = 'Composed in ' + elapsed + 's';

    let m = '<b>' + data.title + '</b> — ' + (data.author || 'unknown author') +
      ' · spine title: <span>' + data.spineTitle + '</span>' +
      ' · thickness: <span>' + data.spineThickness.toFixed(2) + '×</span>';
    if (data.dominant) {
      m += '<br>Cover dominant: ' + swatch(data.dominant) +
        '<span>rgb(' + data.dominant.r + ',' + data.dominant.g + ',' + data.dominant.b + ')</span>' +
        ' → matched template: <span>' + data.chosenColor + '</span>';
    } else {
      m += '<br>No embedded cover — template chosen at random: <span>' + data.chosenColor + '</span>';
    }
    meta.className = 'meta';
    meta.innerHTML = m;

    if (data.candidates && data.candidates.length) {
      let rows = '';
      data.candidates.forEach(function (c) {
        rows += '<tr class="' + (c.key === data.chosenColor ? 'chosen' : '') + '">' +
          '<td>' + swatch(c.rgb) + c.key + '</td>' +
          '<td>rgb(' + c.rgb.r + ',' + c.rgb.g + ',' + c.rgb.b + ')</td>' +
          '<td>' + c.distance.toFixed(1) + '</td></tr>';
      });
      candidates.innerHTML =
        '<table><tr><th>Template</th><th>Cloth colour</th><th>Distance</th></tr>' + rows + '</table>';
    }

    results.innerHTML =
      '<div class="card"><h3>Extracted cover</h3>' +
        (data.originalCover
          ? '<img class="cover-img" src="' + data.originalCover + '">'
          : '<div class="none">No embedded cover in this EPUB</div>') +
      '</div>' +
      '<div class="card"><h3>Composed cover</h3>' +
        '<img class="cover-img" src="' + data.cover + '"></div>' +
      '<div class="card"><h3>Composed spine</h3>' +
        '<img class="spine-img" src="' + data.spine + '"></div>';
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compose';
  }
}
</script>
</body>
</html>`;
