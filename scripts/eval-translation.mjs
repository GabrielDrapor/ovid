/**
 * Ovid Translation Model Evaluation
 *
 * Compares multiple LLM models on the exact translation pipeline used in production.
 * Supports multiple books (one glossary per book). Results are aggregated across all books.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-v1-... node eval-translation.mjs
 *
 * Optional env vars:
 *   EVAL_CHAPTERS=2          (default: 2, chapters per book)
 *   EVAL_JUDGE_SAMPLES=10    (default: 10, segments sampled for LLM judge per model)
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const JSZip = require(join(ROOT, 'node_modules/jszip/lib/index.js'));
const { DOMParser } = require(join(ROOT, 'node_modules/@xmldom/xmldom/lib/index.js'));

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY env var is required.');
  process.exit(1);
}

const BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_CHAPTERS_PER_BOOK = parseInt(process.env.EVAL_CHAPTERS || '2', 10);
const JUDGE_SAMPLES = parseInt(process.env.EVAL_JUDGE_SAMPLES || '10', 10);
const RESULTS_DIR = join(ROOT, 'eval-results');

// Books to test — kept to a manageable set; different genres for coverage
const EPUB_CONFIGS = [
  { path: join(__dirname, 'animal_farm.epub'), label: 'Animal Farm (fiction)' },
  { path: join(__dirname, 'win_pl_fixed.epub'), label: 'How to Win the Premier League (non-fiction)' },
];

const SOURCE_LANG = 'en';
const TARGET_LANG = 'zh';

const MODELS_TO_EVAL = [
  { name: 'deepseek-v4-flash (prod)', model: 'deepseek/deepseek-v4-flash' },
  { name: 'deepseek-v3.2', model: 'deepseek/deepseek-v3.2' },
  { name: 'gemini-2.5-flash', model: 'google/gemini-2.5-flash' },
  { name: 'gpt-4o-mini', model: 'openai/gpt-4o-mini' },
  { name: 'qwen-2.5-72b', model: 'qwen/qwen-2.5-72b-instruct' },
  { name: 'deepseek-v4-pro', model: 'deepseek/deepseek-v4-pro' },
  { name: 'deepseek-r1', model: 'deepseek/deepseek-r1-0528' },
];

const JUDGE_MODEL = 'deepseek/deepseek-chat-v3-0324';

// ─── LLM Client ──────────────────────────────────────────────────────────────

const LANGUAGE_NAMES = { zh: 'Chinese', en: 'English', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese' };

async function llmChat(model, messages, options = {}) {
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://ovid.ink',
          'X-Title': 'Ovid Translation Eval',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: options.maxTokens ?? 8192,
          temperature: options.temperature ?? 0.3,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = await res.json();
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty LLM response');
      return { content, usage: json.usage };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1500;
        console.warn(`  [retry ${attempt + 1}] ${err.message.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ─── EPUB Parser (minimal, derived from book-parser.ts) ───────────────────────

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/\s+/g, ' ').trim();
}

function getFullText(node) {
  let text = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.nodeType === 3) text += c.textContent || '';
      else if (c.nodeType === 1) text += getFullText(c);
    }
  }
  return text;
}

function getNodeHtml(node) {
  return node.toString ? node.toString() : '';
}

function getXPath(node, doc) {
  const parts = [];
  let current = node;
  while (current && current !== doc) {
    let part = current.nodeName.toLowerCase();
    if (current.parentNode) {
      const siblings = Array.from(current.parentNode.childNodes || [])
        .filter(n => n.nodeName === current.nodeName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        part += `[${idx}]`;
      }
    }
    parts.unshift(part);
    current = current.parentNode;
  }
  return '/' + parts.join('/');
}

function extractTextNodes(doc) {
  const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'blockquote', 'div', 'section']);
  const nodes = [];
  let orderIndex = 0;

  function walk(node) {
    if (!node) return;
    const name = node.nodeName?.toLowerCase();
    if (BLOCK_TAGS.has(name)) {
      const text = decodeEntities(getFullText(node));
      if (text.length > 2) {
        nodes.push({ xpath: getXPath(node, doc), text, html: getNodeHtml(node), orderIndex: orderIndex++ });
      }
    } else {
      const children = node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) walk(children[i]);
      }
    }
  }

  walk(doc.documentElement);
  return nodes;
}

async function parseEpubChapters(epubPath, maxChapters) {
  const data = await readFile(epubPath);
  const zip = await JSZip.loadAsync(data);

  // Read OPF
  const containerXml = await zip.file('META-INF/container.xml').async('text');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'text/xml');
  const rootfiles = containerDoc.getElementsByTagName('rootfile');
  const opfPath = rootfiles[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('No OPF found');

  const opfContent = await zip.file(opfPath).async('text');
  const opfDoc = new DOMParser().parseFromString(opfContent, 'text/xml');

  // Get spine order
  const spineItems = opfDoc.getElementsByTagName('itemref');
  const manifestItems = opfDoc.getElementsByTagName('item');
  const manifest = {};
  for (let i = 0; i < manifestItems.length; i++) {
    const item = manifestItems[i];
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  }

  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  const chapters = [];
  for (let i = 0; i < spineItems.length && chapters.length < maxChapters; i++) {
    const idref = spineItems[i].getAttribute('idref');
    const href = manifest[idref];
    if (!href) continue;

    const fullPath = opfDir + href;
    const fileEntry = zip.file(fullPath) || zip.file(href);
    if (!fileEntry) continue;

    const html = await fileEntry.async('text');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const textNodes = extractTextNodes(doc);

    // Skip title pages, TOC, and near-empty chapters
    const totalChars = textNodes.reduce((s, n) => s + n.text.length, 0);
    if (textNodes.length < 5 || totalChars < 3000) continue;

    // Get title from first heading or first text node
    const title = textNodes.find(n => n.text.length < 80)?.text || `Chapter ${chapters.length + 1}`;
    chapters.push({ number: chapters.length + 1, title, textNodes });
  }

  return chapters;
}

// ─── Translation Functions (mirrors translate-worker.ts) ──────────────────────

function buildGlossaryStr(text, glossary) {
  const relevant = {};
  const lower = text.toLowerCase();
  for (const [k, v] of Object.entries(glossary)) {
    if (lower.includes(k.toLowerCase())) relevant[k] = v;
  }
  if (!Object.keys(relevant).length) return '';
  const entries = Object.entries(relevant)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k, v]) => `  "${k}" → "${v}"`)
    .join('\n');
  return `\n\n**GLOSSARY (MUST use these exact translations):**\n${entries}\n`;
}

function stripCitations(text) {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, ' ')
    .replace(/\b(?:[\w-]+\.)+(?:com|org|net|gov|edu|io|co|cn|jp|de|fr|uk|us|ru|au|tv|info|news|me)(?:\.[a-z]{2})?(?:\/[\w\-./?#=&%~+]*)?/gi, ' ')
    .replace(/\.(?:shtml|html?|pdf|txt|aspx?|jsp|php|csv|json|xml)\b/gi, ' ');
}

function detectEnglishResidue(text, glossary) {
  const stripped = stripCitations(text);
  const cjkCount = (stripped.match(/[　-鿿가-힯]/g) ?? []).length;
  const latinCount = (stripped.match(/[a-zA-Z]/g) ?? []).length;
  if (cjkCount > 0 && cjkCount / (cjkCount + latinCount) >= 0.6) return [];

  const englishWords = stripped.match(/[a-zA-Z]{3,}/g);
  if (!englishWords) return [];

  const allowed = new Set();
  for (const [key, val] of Object.entries(glossary)) {
    for (const w of [...key.split(/\s+/), ...val.split(/\s+/)]) {
      if (w.length >= 3) allowed.add(w.toLowerCase());
    }
  }
  const commonAllowed = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'but',
    'are', 'was', 'were', 'has', 'had', 'have', 'will', 'can', 'may',
    'app', 'web', 'api', 'url', 'http', 'https', 'www', 'html', 'css',
    'pdf', 'jpg', 'png', 'gif', 'xml', 'json', 'sql', 'seg', 'translate', 'context',
  ]);

  const residue = englishWords.filter(w => {
    const lower = w.toLowerCase();
    if (allowed.has(lower) || commonAllowed.has(lower)) return false;
    if (/^[A-Z]+$/.test(w)) return false;
    return true;
  });

  if (residue.length === 0) return [];
  if (cjkCount > 0) {
    const allTitleCase = residue.every(w => /^[A-Z][a-z]+$/.test(w));
    if (allTitleCase) return [];
  }
  return residue;
}

async function extractGlossary(model, allTexts) {
  const targetLang = LANGUAGE_NAMES[TARGET_LANG];
  const samples = allTexts.slice(0, 100);
  const combinedText = samples.join('\n\n');

  const { content, usage } = await llmChat(model, [
    {
      role: 'system',
      content: `You are a professional literary translator specializing in proper noun extraction.
Extract ALL proper nouns (people, places, organizations, brands, acronyms) from the given ${SOURCE_LANG} text and provide consistent ${targetLang} translations.
For acronyms with no standard ${targetLang} translation, keep them as-is.
Return ONLY a valid JSON object. Be concise. Example: {"Napoleon": "拿破仑", "Snowball": "雪球", "Manor Farm": "庄园农场"}`,
    },
    {
      role: 'user',
      content: `Extract all proper nouns and provide ${targetLang} translations. Return ONLY valid JSON.\n\nText:\n${combinedText}`,
    },
  ], { temperature: 0.1, maxTokens: 4096 });

  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
  try {
    return { glossary: JSON.parse(jsonStr), usage };
  } catch {
    const lastComma = jsonStr.lastIndexOf('",');
    if (lastComma > 0) {
      try { return { glossary: JSON.parse(jsonStr.slice(0, lastComma + 1) + '}'), usage }; } catch { /* */ }
    }
    return { glossary: {}, usage };
  }
}

async function translateText(model, text, glossary) {
  const targetLang = LANGUAGE_NAMES[TARGET_LANG];
  const glossaryStr = buildGlossaryStr(text, glossary);

  const { content, usage } = await llmChat(model, [
    {
      role: 'system',
      content: `You are a professional literary translator. Translate the following ${SOURCE_LANG} text to ${targetLang}.

**CRITICAL RULES:**
1. Return ONLY the translation of the text inside <translate> tags.
2. Do NOT wrap in quotes unless the source has them.
3. Maintain style, tone, and formatting.
4. For proper nouns, use exact translations from the Glossary.
5. Output ONLY the translated text.
6. NEVER leave English words in the output, except for proper nouns with no standard ${targetLang} translation.${glossaryStr}`,
    },
    {
      role: 'user',
      content: `<translate>\n${text}\n</translate>`,
    },
  ]);

  const result = content.replace(/<\/?translate>/gi, '').replace(/<\/?context>/gi, '').trim();
  return { translated: result, usage };
}

async function translateBatch(model, segments, glossary) {
  const targetLang = LANGUAGE_NAMES[TARGET_LANG];
  const allText = segments.map(s => s.text).join(' ');
  const glossaryStr = buildGlossaryStr(allText, glossary);
  const taggedInput = segments.map(s => `<seg id="${s.index}">${s.text}</seg>`).join('\n');

  const { content, usage } = await llmChat(model, [
    {
      role: 'system',
      content: `You are a professional literary translator. Translate the following ${SOURCE_LANG} text segments to ${targetLang}.

**CRITICAL RULES:**
1. Each segment is wrapped in <seg id="N">...</seg> tags.
2. Return each translation wrapped in the SAME <seg id="N">...</seg> tags with matching IDs.
3. Translate EVERY segment. Do not skip or merge segments.
4. Maintain style, tone, and formatting within each segment.
5. Do NOT wrap in quotes unless the source has them.
6. For proper nouns, use exact translations from the Glossary.
7. Output ONLY the translated segments with their tags, nothing else.
8. NEVER leave English words in the output, except for proper nouns with no standard ${targetLang} translation.${glossaryStr}`,
    },
    { role: 'user', content: taggedInput },
  ], { maxTokens: 16384 });

  const resultMap = new Map();
  const segRegex = /<seg\s+id="(\d+)">([\s\S]*?)<\/seg>/g;
  let match;
  while ((match = segRegex.exec(content)) !== null) {
    resultMap.set(parseInt(match[1], 10), match[2].trim());
  }

  // Mark missing segments as null
  for (const seg of segments) {
    if (!resultMap.has(seg.index)) resultMap.set(seg.index, null);
  }

  return { resultMap, usage, rawResponse: content };
}

// ─── Metrics Calculation ──────────────────────────────────────────────────────

function calcAutomatedMetrics(originals, translations, glossary, batchParseResults) {
  const total = originals.length;
  let translated = 0, failed = 0, residueCount = 0;
  const residueExamples = [];

  for (let i = 0; i < total; i++) {
    const t = translations[i];
    if (!t || t === '[Translation failed]') {
      failed++;
    } else {
      translated++;
      const residue = detectEnglishResidue(t, glossary);
      if (residue.length > 0) {
        residueCount++;
        if (residueExamples.length < 3) residueExamples.push({ segment: i, residue });
      }
    }
  }

  // Glossary adherence: for each glossary term found in original, check if translation uses the expected term
  let glossaryChecks = 0, glossaryHits = 0;
  for (let i = 0; i < total; i++) {
    const orig = originals[i].toLowerCase();
    const trans = translations[i] || '';
    for (const [key, val] of Object.entries(glossary)) {
      if (orig.includes(key.toLowerCase()) && val) {
        glossaryChecks++;
        if (trans.includes(val)) glossaryHits++;
      }
    }
  }

  // Batch parse rate: % of segments that were parsed from batch response (not null)
  const batchTotal = batchParseResults.total;
  const batchParsed = batchParseResults.parsed;

  return {
    completeness: total > 0 ? translated / total : 0,
    failedCount: failed,
    englishResidueRate: total > 0 ? residueCount / total : 0,
    residueExamples,
    glossaryAdherenceRate: glossaryChecks > 0 ? glossaryHits / glossaryChecks : null,
    glossaryChecks,
    batchParseRate: batchTotal > 0 ? batchParsed / batchTotal : 1.0,
    batchTotal,
  };
}

// ─── LLM Judge ────────────────────────────────────────────────────────────────

async function runJudgeEvaluation(sampleSegments, modelResults) {
  // sampleSegments: [{original, chapterTitle}]
  // modelResults: { modelName: [translation, ...] }

  const scores = {};
  for (const modelName of Object.keys(modelResults)) scores[modelName] = [];

  console.log(`\n  Running LLM judge on ${sampleSegments.length} sampled segments...`);

  for (let i = 0; i < sampleSegments.length; i++) {
    const { original, chapterTitle } = sampleSegments[i];
    const translations = Object.fromEntries(
      Object.entries(modelResults).map(([name, translations]) => [name, translations[i]])
    );

    // Build the judge prompt
    const translationBlock = Object.entries(translations)
      .map(([name, t]) => `**Model: ${name}**\n${t || '(failed)'}`)
      .join('\n\n---\n\n');

    const { content } = await llmChat(JUDGE_MODEL, [
      {
        role: 'system',
        content: `You are an expert Chinese literary translator and translation evaluator. You will be given an English source segment from a novel and several Chinese translations. Score each translation on 4 dimensions, 1-5 scale:

- **accuracy** (1-5): Is the core meaning faithfully conveyed? (5=perfect, 1=major meaning errors)
- **fluency** (1-5): Does it read naturally as literary Chinese? (5=very fluent, 1=awkward/unnatural)
- **completeness** (1-5): Is every part of the source translated with no omissions? (5=complete, 1=major omissions)
- **style** (1-5): Does it preserve the author's tone, voice, and literary style? (5=excellent match, 1=tone lost)

Return ONLY valid JSON in this format (no extra text):
{
  "modelName1": {"accuracy": N, "fluency": N, "completeness": N, "style": N},
  "modelName2": {"accuracy": N, "fluency": N, "completeness": N, "style": N}
}`,
      },
      {
        role: 'user',
        content: `Source text (from "${chapterTitle}"):\n"${original}"\n\n${translationBlock}`,
      },
    ], { temperature: 0.1, maxTokens: 1024 });

    try {
      let jsonStr = content.trim();
      if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      for (const [name, score] of Object.entries(parsed)) {
        if (scores[name]) scores[name].push(score);
      }
      process.stdout.write('.');
    } catch (err) {
      process.stdout.write('x');
    }
  }
  console.log('');

  // Average the scores
  const averaged = {};
  for (const [name, scoreList] of Object.entries(scores)) {
    if (scoreList.length === 0) { averaged[name] = null; continue; }
    averaged[name] = {
      accuracy: scoreList.reduce((s, x) => s + (x.accuracy || 0), 0) / scoreList.length,
      fluency: scoreList.reduce((s, x) => s + (x.fluency || 0), 0) / scoreList.length,
      completeness: scoreList.reduce((s, x) => s + (x.completeness || 0), 0) / scoreList.length,
      style: scoreList.reduce((s, x) => s + (x.style || 0), 0) / scoreList.length,
      sampleCount: scoreList.length,
    };
    averaged[name].overall = (averaged[name].accuracy + averaged[name].fluency + averaged[name].completeness + averaged[name].style) / 4;
  }
  return averaged;
}

// ─── Main Evaluation Loop ─────────────────────────────────────────────────────

function estimateTokens(text) {
  const cjk = (text.match(/[　-鿿가-힯]/g) ?? []).length;
  return Math.ceil(cjk / 2 + (text.length - cjk) / 4);
}

async function translateChapters(model, chapters, glossary) {
  const MAX_BATCH_TOKENS = 2000;
  const CONCURRENCY = 3;
  const allTranslations = [];
  let batchParsedTotal = 0, batchTotal = 0, totalTokensUsed = 0;
  const chapterLatencies = [];

  for (const chapter of chapters) {
    const chStart = Date.now();
    const { textNodes } = chapter;
    console.log(`        "${chapter.title.slice(0, 45)}" — ${textNodes.length} segs`);

    const batches = [];
    let currentBatch = [], currentTokens = 0;
    for (let i = 0; i < textNodes.length; i++) {
      const tokens = estimateTokens(textNodes[i].text);
      if (currentBatch.length > 0 && currentTokens + tokens > MAX_BATCH_TOKENS) {
        batches.push(currentBatch); currentBatch = []; currentTokens = 0;
      }
      currentBatch.push({ index: i, text: textNodes[i].text });
      currentTokens += tokens;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    const chapterTranslations = new Array(textNodes.length).fill(null);

    for (let b = 0; b < batches.length; b += CONCURRENCY) {
      const concurrent = batches.slice(b, b + CONCURRENCY);
      const results = await Promise.allSettled(
        concurrent.map(async batch => {
          if (batch.length === 1) {
            const { translated, usage } = await translateText(model, batch[0].text, glossary);
            totalTokensUsed += (usage?.total_tokens || 0);
            return new Map([[batch[0].index, translated]]);
          }
          const { resultMap, usage } = await translateBatch(model, batch, glossary);
          totalTokensUsed += (usage?.total_tokens || 0);
          return resultMap;
        })
      );

      for (let r = 0; r < results.length; r++) {
        const batch = concurrent[r];
        if (results[r].status === 'fulfilled') {
          for (const item of batch) {
            const t = results[r].value.get(item.index);
            if (batch.length > 1) { batchTotal++; if (t !== null) batchParsedTotal++; }
            chapterTranslations[item.index] = t || '[Translation failed]';
          }
        } else {
          console.warn(`        Batch failed: ${results[r].reason?.message?.slice(0, 60)}`);
          for (const item of batch) {
            chapterTranslations[item.index] = '[Translation failed]';
            if (batch.length > 1) batchTotal++;
          }
        }
      }
    }

    allTranslations.push(...chapterTranslations);
    const chMs = Date.now() - chStart;
    chapterLatencies.push(chMs);
    console.log(`        → ${(chMs/1000).toFixed(1)}s`);
  }

  return { allTranslations, batchParsedTotal, batchTotal, totalTokensUsed, chapterLatencies };
}

async function evalModel(modelConfig, bookDatasets) {
  const { name, model } = modelConfig;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Evaluating: ${name} (${model})`);
  console.log('─'.repeat(60));

  let totalTokensUsed = 0;
  let combinedOriginals = [];
  let combinedTranslations = [];
  let combinedGlossary = {};
  let batchParsedTotal = 0, batchTotal = 0;
  const allChapterLatencies = [];

  // Process each book with its own glossary
  for (const { label, chapters } of bookDatasets) {
    console.log(`\n  [Book] ${label}`);
    const bookOriginals = chapters.flatMap(ch => ch.textNodes.map(n => n.text));

    // Extract glossary for this book
    console.log('    Glossary...');
    const { glossary, usage: gUsage } = await extractGlossary(model, bookOriginals);
    totalTokensUsed += (gUsage?.total_tokens || 0);
    console.log(`    → ${Object.keys(glossary).length} terms: ${Object.entries(glossary).slice(0,4).map(([k,v])=>`${k}→${v}`).join(', ')}`);

    // Translate
    console.log('    Translating...');
    const { allTranslations, batchParsedTotal: bp, batchTotal: bt, totalTokensUsed: tu, chapterLatencies } =
      await translateChapters(model, chapters, glossary);

    totalTokensUsed += tu;
    batchParsedTotal += bp;
    batchTotal += bt;
    allChapterLatencies.push(...chapterLatencies);

    combinedOriginals.push(...bookOriginals);
    combinedTranslations.push(...allTranslations);
    Object.assign(combinedGlossary, glossary);
  }

  // Compute metrics across all books
  const metrics = calcAutomatedMetrics(
    combinedOriginals,
    combinedTranslations,
    combinedGlossary,
    { total: batchTotal, parsed: batchParsedTotal }
  );

  return {
    name,
    model,
    glossary: combinedGlossary,
    allTranslations: combinedTranslations,
    allOriginalTexts: combinedOriginals,
    metrics: {
      ...metrics,
      totalLatencyMs: allChapterLatencies.reduce((a, b) => a + b, 0),
      totalTokensUsed,
      totalSegments: combinedOriginals.length,
    },
  };
}

function printResultsTable(results, judgeScores) {
  const fmt = (n, digits = 1) => n != null ? (n * 100).toFixed(digits) + '%' : 'N/A';
  const fmtMs = ms => ms > 60000 ? `${(ms/60000).toFixed(1)}m` : `${(ms/1000).toFixed(0)}s`;
  const fmtScore = s => s != null ? s.toFixed(2) : 'N/A';

  console.log('\n' + '═'.repeat(100));
  console.log('OVID TRANSLATION MODEL EVALUATION RESULTS');
  console.log('═'.repeat(100));

  const header = [
    'Model'.padEnd(28),
    'Complete'.padStart(9),
    'BatchParse'.padStart(11),
    'NoResidue'.padStart(10),
    'Glossary%'.padStart(10),
    'Latency'.padStart(8),
    'Accuracy'.padStart(9),
    'Fluency'.padStart(8),
    'Complete*'.padStart(10),
    'Style'.padStart(6),
    'Overall'.padStart(8),
  ].join(' ');
  console.log(header);
  console.log('─'.repeat(100));

  for (const r of results) {
    const js = judgeScores?.[r.name];
    const row = [
      r.name.padEnd(28),
      fmt(r.metrics.completeness).padStart(9),
      fmt(r.metrics.batchParseRate).padStart(11),
      fmt(1 - r.metrics.englishResidueRate).padStart(10),
      (r.metrics.glossaryAdherenceRate != null ? fmt(r.metrics.glossaryAdherenceRate) : 'N/A').padStart(10),
      fmtMs(r.metrics.totalLatencyMs).padStart(8),
      (js ? fmtScore(js.accuracy) : 'N/A').padStart(9),
      (js ? fmtScore(js.fluency) : 'N/A').padStart(8),
      (js ? fmtScore(js.completeness) : 'N/A').padStart(10),
      (js ? fmtScore(js.style) : 'N/A').padStart(6),
      (js ? fmtScore(js.overall) : 'N/A').padStart(8),
    ].join(' ');
    console.log(row);
  }

  console.log('─'.repeat(100));
  console.log('* Judge "Complete" = completeness dimension, not same as automated Completeness');
  console.log('  Complete = all segments translated | BatchParse = <seg> tag parse rate');
  console.log('  NoResidue = % segs with no untranslated English | Glossary% = proper noun adherence');
  console.log('  Judge scores: Accuracy/Fluency/Completeness/Style on 1-5 scale');

  if (results.length > 0) {
    const bestOverall = results
      .filter(r => judgeScores?.[r.name]?.overall != null)
      .sort((a, b) => (judgeScores[b.name]?.overall || 0) - (judgeScores[a.name]?.overall || 0))[0];
    if (bestOverall) {
      console.log(`\n★ Best overall (by judge): ${bestOverall.name} (${fmtScore(judgeScores[bestOverall.name]?.overall)})`);
    }
  }
  console.log('═'.repeat(100));
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('Ovid Translation Model Evaluation');
  console.log(`Books: ${EPUB_CONFIGS.map(b => b.label).join(', ')}`);
  console.log(`Chapters per book: ${MAX_CHAPTERS_PER_BOOK} | Judge samples: ${JUDGE_SAMPLES}`);
  console.log(`Models: ${MODELS_TO_EVAL.map(m => m.name).join(', ')}`);
  console.log(`Judge: ${JUDGE_MODEL}\n`);

  // Parse all EPUBs
  console.log('Parsing books...');
  const bookDatasets = [];
  const allChapterTitles = [];
  let globalOffset = 0;
  const segmentBookLabels = [];

  for (const cfg of EPUB_CONFIGS) {
    const chapters = await parseEpubChapters(cfg.path, MAX_CHAPTERS_PER_BOOK);
    console.log(`  ${cfg.label}: ${chapters.length} chapters, ${chapters.reduce((s,c)=>s+c.textNodes.length,0)} nodes`);
    for (const ch of chapters) {
      allChapterTitles.push({ start: globalOffset, title: `${ch.title} [${cfg.label}]` });
      for (let i = 0; i < ch.textNodes.length; i++) {
        segmentBookLabels.push(`${ch.title} [${cfg.label}]`);
      }
      globalOffset += ch.textNodes.length;
    }
    bookDatasets.push({ label: cfg.label, chapters });
  }

  const getChapterTitle = idx => segmentBookLabels[idx] || 'Unknown';

  // Run each model
  const results = [];
  for (const modelConfig of MODELS_TO_EVAL) {
    try {
      const result = await evalModel(modelConfig, bookDatasets);
      results.push(result);
    } catch (err) {
      console.error(`\nFATAL: Model ${modelConfig.name} failed: ${err.message}`);
      results.push({
        name: modelConfig.name,
        model: modelConfig.model,
        glossary: {},
        allTranslations: [],
        allOriginalTexts: [],
        metrics: {
          completeness: 0, failedCount: -1, englishResidueRate: 0,
          glossaryAdherenceRate: null, batchParseRate: 0,
          totalLatencyMs: 0, totalTokensUsed: 0, totalSegments: 0,
        },
        error: err.message,
      });
    }
  }

  // Prepare judge eval
  const allOriginals = results.find(r => r.allOriginalTexts.length > 0)?.allOriginalTexts || [];
  const totalSegments = allOriginals.length;

  // Sample segments for judge: spread across all content
  const sampleIndices = [];
  const step = Math.max(1, Math.floor(totalSegments / JUDGE_SAMPLES));
  for (let i = 0; i < totalSegments && sampleIndices.length < JUDGE_SAMPLES; i += step) {
    sampleIndices.push(i);
  }

  const sampleSegments = sampleIndices.map(i => ({
    original: allOriginals[i],
    chapterTitle: getChapterTitle(i),
    globalIndex: i,
  })).filter(s => s.original?.length > 20);

  // Build per-model translation arrays for sampled indices
  const judgeModelResults = {};
  for (const r of results) {
    if (!r.error && r.allTranslations.length > 0) {
      judgeModelResults[r.name] = sampleSegments.map(s => r.allTranslations[s.globalIndex] || '(failed)');
    }
  }

  // Run judge
  let judgeScores = null;
  if (Object.keys(judgeModelResults).length > 0 && sampleSegments.length > 0) {
    console.log('\nRunning LLM judge evaluation...');
    try {
      judgeScores = await runJudgeEvaluation(sampleSegments, judgeModelResults);
    } catch (err) {
      console.error(`Judge evaluation failed: ${err.message}`);
    }
  }

  // Print results
  printResultsTable(results, judgeScores);

  // Save results JSON
  if (!existsSync(RESULTS_DIR)) await mkdir(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = join(RESULTS_DIR, `eval-${timestamp}.json`);
  const output = {
    timestamp: new Date().toISOString(),
    config: { maxChaptersPerBook: MAX_CHAPTERS_PER_BOOK, books: EPUB_CONFIGS.map(b=>b.label), judgeSamples: JUDGE_SAMPLES, judgeModel: JUDGE_MODEL },
    models: MODELS_TO_EVAL,
    results: results.map(r => ({
      name: r.name,
      model: r.model,
      metrics: r.metrics,
      glossarySize: Object.keys(r.glossary || {}).length,
      glossary: r.glossary,
      judgeScores: judgeScores?.[r.name] || null,
      residueExamples: r.metrics.residueExamples,
      error: r.error || null,
    })),
    sampleTranslations: sampleSegments.slice(0, 5).map(s => ({
      original: s.original,
      chapterTitle: s.chapterTitle,
      translations: Object.fromEntries(
        results.filter(r => !r.error).map(r => [r.name, r.allTranslations[s.globalIndex] || null])
      ),
    })),
  };
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`\nDetailed results saved to: ${outPath}`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
