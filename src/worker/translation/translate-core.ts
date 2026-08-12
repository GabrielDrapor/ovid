/**
 * Translation core for the Cloudflare Workflows backend.
 *
 * The LLM-facing functions (prompts, batch construction, glossary handling,
 * residue detection, retry ladder) are ported verbatim from
 * services/translator/src/translate-worker.ts — translation quality must be
 * identical across backends. Keep the two in sync.
 *
 * The orchestration differs: instead of one long-running in-process pool,
 * work is exposed as idempotent per-chapter steps so Cloudflare Workflows
 * can retry/resume any step safely. A chapter step re-checks completion on
 * entry (row count == node count) and wipes partial rows before redoing —
 * translations_v2 has no UNIQUE(chapter_id, xpath), so the wipe is what
 * keeps retries duplicate-free.
 */

import type { DbClient } from './d1-binding-client';

export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export interface TranslationJobRow {
  id: number;
  book_id: number;
  book_uuid: string;
  source_language: string;
  target_language: string;
  total_chapters: number;
  completed_chapters: number;
  current_chapter: number;
  glossary_json: string | null;
  glossary_extracted: number;
  title_translated: number;
  status: string;
  backend?: string;
}

interface TextNode {
  xpath: string;
  text: string;
  html: string;
  orderIndex: number;
}

/** Sentinel value written when a node permanently fails translation after retry */
export const TRANSLATION_FAILED_MARKER = '[Translation failed]';

/** Threshold (in characters) above which a single text node is split into chunks for translation */
const LARGE_NODE_CHAR_THRESHOLD = 3000;

/** Token budget per batched LLM call — must match the Railway pipeline */
const MAX_BATCH_TOKENS = 2000;

/** Column list for translations_v2 batch inserts */
const TRANSLATIONS_V2_COLUMNS = ['chapter_id', 'xpath', 'original_text', 'original_html', 'translated_text', 'order_index'] as const;

/** Language code to display name mapping */
const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese', en: 'English', es: 'Spanish', fr: 'French',
  de: 'German', ja: 'Japanese', ko: 'Korean', ru: 'Russian',
};

/**
 * Simple LLM chat call — ported verbatim (429-aware retry with jitter)
 */
async function llmChat(config: LLMConfig, messages: Array<{ role: string; content: string }>, options?: { maxTokens?: number; temperature?: number }): Promise<string> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      const res = await fetch(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: options?.maxTokens ?? 8192,
          temperature: options?.temperature ?? 0.3,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        const text = await res.text();
        const httpErr = new Error(`LLM API ${res.status}: ${text}`) as Error & { retryAfterMs?: number };
        if (res.status === 429) {
          const retryAfter = parseFloat(res.headers?.get?.('retry-after') ?? '');
          httpErr.retryAfterMs = Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1000, 60000)
            : 5000;
        }
        throw httpErr;
      }

      const json = await res.json() as any;
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty LLM response');
      return content;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        let delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        const retryAfterMs = (err as Error & { retryAfterMs?: number }).retryAfterMs;
        if (retryAfterMs) delay = Math.max(delay, retryAfterMs);
        console.warn(`LLM retry ${attempt + 1}: ${(err as Error).message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

/**
 * Try to parse a JSON object string, repairing truncated output — ported verbatim
 */
function parseGlossaryJson(raw: string): Record<string, string> {
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    const lastComma = jsonStr.lastIndexOf('",');
    if (lastComma > 0) {
      const repaired = jsonStr.slice(0, lastComma + 1) + '}';
      try {
        return JSON.parse(repaired);
      } catch { /* fall through */ }
    }
    throw new Error('Unrepairable glossary JSON');
  }
}

/**
 * Extract proper nouns glossary from book text — ported verbatim
 */
async function extractGlossary(
  config: LLMConfig,
  allTexts: string[],
  sourceLanguage: string,
  targetLanguage: string
): Promise<Record<string, string>> {
  const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
  const total = allTexts.length;

  const sampleSizes: Array<[number, number, number]> = [
    [100, 50, 50],
    [50, 25, 25],
  ];

  for (let attempt = 0; attempt < sampleSizes.length; attempt++) {
    const [head, mid, tail] = sampleSizes[attempt];
    const samples: string[] = [];
    samples.push(...allTexts.slice(0, Math.min(head, total)));
    if (total > head * 2) {
      const midStart = Math.floor(total / 2) - Math.floor(mid / 2);
      samples.push(...allTexts.slice(midStart, midStart + mid));
    }
    if (total > head + tail) {
      samples.push(...allTexts.slice(-tail));
    }
    const combinedText = samples.join('\n\n');

    try {
      const response = await llmChat(config, [
        {
          role: 'system',
          content: `You are a professional literary translator specializing in proper noun extraction.
Extract ALL proper nouns (people, places, organizations, brands, acronyms) from the given ${sourceLanguage} text and provide consistent ${targetLang} translations.
For acronyms with no standard ${targetLang} translation, keep them as-is in the value (e.g. {"NBA": "NBA"}).
Return ONLY a valid JSON object. Be concise — short values, no commentary. Example: {"Whymper": "温珀", "NBA": "NBA"}`,
        },
        {
          role: 'user',
          content: `Extract all proper nouns and provide ${targetLang} translations. Return ONLY valid JSON.\n\nText:\n${combinedText}`,
        },
      ], { temperature: 0.1, maxTokens: 16384 });

      const parsed = parseGlossaryJson(response);
      const count = Object.keys(parsed).length;
      console.log(`[glossary] Extracted ${count} terms (attempt ${attempt + 1}, sample size ${samples.length})`);
      return parsed;
    } catch (err) {
      console.warn(`[glossary] Attempt ${attempt + 1} failed:`, (err as Error).message);
    }
  }

  throw new Error('All glossary extraction attempts failed (empty LLM response)');
}

/**
 * Translate a single text segment with glossary context — ported verbatim
 */
async function translateText(
  config: LLMConfig,
  text: string,
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
  context?: string[]
): Promise<string> {
  const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
  const glossaryStr = buildGlossaryStr(text, glossary);

  const contextStr = context?.length
    ? `\n\n<context>\n${context.join('\n')}\n</context>\n`
    : '';

  const translation = await llmChat(config, [
    {
      role: 'system',
      content: `You are a professional literary translator. Translate the following ${sourceLanguage} text to ${targetLang}.

**CRITICAL RULES:**
1. Return ONLY the translation of the text inside <translate> tags.
2. Do NOT wrap in quotes unless the source has them.
3. Maintain style, tone, and formatting.
4. For proper nouns, use exact translations from the Glossary.
5. Output ONLY the translated text.
6. NEVER leave English words in the output, except for proper nouns with no standard ${targetLang} translation. If a word is difficult to translate, find the closest natural expression.${glossaryStr}`,
    },
    {
      role: 'user',
      content: `${contextStr}\n<translate>\n${text}\n</translate>`,
    },
  ]);

  let result = translation
    .replace(/<\/?translate>/gi, '')
    .replace(/<\/?context>/gi, '')
    .trim();

  const residue = detectEnglishResidue(result, glossary);
  if (residue.length > 0) {
    console.warn(`[translation] English residue detected: [${residue.join(', ')}] — retrying with stronger prompt`);

    const retryTranslation = await llmChat(config, [
      {
        role: 'system',
        content: `You are a professional literary translator. Translate the following ${sourceLanguage} text to ${targetLang}.

**ABSOLUTE REQUIREMENT:** The output must be ENTIRELY in ${targetLang}. Do NOT leave ANY English words in the translation. The previous attempt incorrectly left these English words untranslated: ${residue.join(', ')}. You MUST translate every single word.

${glossaryStr}`,
      },
      {
        role: 'user',
        content: `${contextStr}\n<translate>\n${text}\n</translate>`,
      },
    ], { temperature: 0.1 });

    const retryResult = retryTranslation
      .replace(/<\/?translate>/gi, '')
      .replace(/<\/?context>/gi, '')
      .trim();

    const retryResidue = detectEnglishResidue(retryResult, glossary);
    if (retryResidue.length < residue.length) {
      result = retryResult;
    }
    if (retryResidue.length > 0) {
      console.warn(`[translation] Retry still has residue: [${retryResidue.join(', ')}] — using ${retryResidue.length < residue.length ? 'retry' : 'original'}`);
    }
  }

  return result;
}

/**
 * Translate a large text node by splitting on paragraph boundaries — ported verbatim
 */
async function translateLargeNode(
  config: LLMConfig,
  text: string,
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
  bookUuid: string
): Promise<string> {
  const chunks = text.split(/\n\n+/).filter(c => c.trim().length > 0);

  if (chunks.length <= 1) {
    const fallbackChunks = text.split(/\n/).filter(c => c.trim().length > 0);
    if (fallbackChunks.length <= 1) {
      console.warn(`[${bookUuid}] Large node (${text.length} chars) has no splittable boundaries`);
      return translateText(config, text, glossary, sourceLanguage, targetLanguage);
    }
    return translateChunkedParagraphs(config, fallbackChunks, glossary, sourceLanguage, targetLanguage, bookUuid);
  }

  return translateChunkedParagraphs(config, chunks, glossary, sourceLanguage, targetLanguage, bookUuid);
}

/** Translate an array of paragraph chunks with concurrency — ported verbatim */
async function translateChunkedParagraphs(
  config: LLMConfig,
  chunks: string[],
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
  bookUuid: string
): Promise<string> {
  console.log(`[${bookUuid}] Splitting large node into ${chunks.length} chunks for translation`);

  const CHUNK_BATCH_SIZE = 2000;
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentLen = 0;

  for (const chunk of chunks) {
    if (currentBatch.length > 0 && currentLen + chunk.length > CHUNK_BATCH_SIZE) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLen = 0;
    }
    currentBatch.push(chunk);
    currentLen += chunk.length;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const CONCURRENCY = 3;
  const translatedBatches: string[] = [];

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const concurrent = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      concurrent.map(batch => {
        const batchText = batch.join('\n\n');
        return translateText(config, batchText, glossary, sourceLanguage, targetLanguage);
      })
    );
    translatedBatches.push(...results);
  }

  return translatedBatches.join('\n\n');
}

/** Build glossary string for relevant terms found in text — ported verbatim */
function buildGlossaryStr(text: string, glossary: Record<string, string>): string {
  const relevant: Record<string, string> = {};
  const textLower = text.toLowerCase();
  for (const [key, value] of Object.entries(glossary)) {
    if (textLower.includes(key.toLowerCase())) {
      relevant[key] = value;
    }
  }
  if (Object.keys(relevant).length === 0) return '';
  const entries = Object.entries(relevant)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k, v]) => `  "${k}" → "${v}"`)
    .join('\n');
  return `\n\n**GLOSSARY (MUST use these exact translations):**\n${entries}\n`;
}

/** Strip URL-like content before residue analysis — ported verbatim */
function stripCitations(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, ' ')
    .replace(
      /\b(?:[\w-]+\.)+(?:com|org|net|gov|edu|io|co|cn|jp|de|fr|uk|us|ru|au|tv|info|news|me)(?:\.[a-z]{2})?(?:\/[\w\-./?#=&%~+]*)?/gi,
      ' ',
    )
    .replace(/\.(?:shtml|html?|pdf|txt|aspx?|jsp|php|csv|json|xml)\b/gi, ' ');
}

/**
 * Detect non-proper-noun English words left in a translation — ported verbatim
 */
export function detectEnglishResidue(text: string, glossary: Record<string, string>): string[] {
  const stripped = stripCitations(text);

  const cjkCount = (stripped.match(/[　-鿿가-힯]/g) ?? []).length;
  const latinCount = (stripped.match(/[a-zA-Z]/g) ?? []).length;
  if (cjkCount > 0 && cjkCount / (cjkCount + latinCount) >= 0.6) {
    return [];
  }

  const englishWords = stripped.match(/[a-zA-Z]{3,}/g);
  if (!englishWords) return [];

  const allowed = new Set<string>();
  for (const [key, val] of Object.entries(glossary)) {
    for (const word of key.split(/\s+/)) {
      if (word.length >= 3) allowed.add(word.toLowerCase());
    }
    for (const word of val.split(/\s+/)) {
      if (/^[a-zA-Z]{3,}$/.test(word)) allowed.add(word.toLowerCase());
    }
  }

  const commonAllowed = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'but',
    'are', 'was', 'were', 'has', 'had', 'have', 'will', 'can', 'may',
    'app', 'web', 'api', 'url', 'http', 'https', 'www', 'html', 'css',
    'pdf', 'jpg', 'png', 'gif', 'xml', 'json', 'sql',
    'seg', 'translate', 'context',
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
    const looksLikePinyin =
      residue.length >= 2 &&
      residue.some(w => /^[A-Z][a-z]+$/.test(w)) &&
      residue.every(w => /^[A-Z][a-z]+$/.test(w) || /^[a-z]{1,5}$/.test(w));
    if (allTitleCase || looksLikePinyin) return [];
  }

  return residue;
}

/** Rough token estimate — ported verbatim */
function estimateTokens(text: string): number {
  const cjk = text.match(/[　-鿿가-힯]/g)?.length ?? 0;
  return Math.ceil(cjk / 2 + (text.length - cjk) / 4);
}

/**
 * Translate multiple text segments in a single LLM call — ported verbatim
 */
async function translateBatch(
  config: LLMConfig,
  segments: { index: number; text: string }[],
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<Map<number, string | null>> {
  const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

  const allText = segments.map(s => s.text).join(' ');
  const glossaryStr = buildGlossaryStr(allText, glossary);

  const taggedInput = segments
    .map(s => `<seg id="${s.index}">${s.text}</seg>`)
    .join('\n');

  const response = await llmChat(config, [
    {
      role: 'system',
      content: `You are a professional literary translator. Translate the following ${sourceLanguage} text segments to ${targetLang}.

**CRITICAL RULES:**
1. Each segment is wrapped in <seg id="N">...</seg> tags.
2. Return each translation wrapped in the SAME <seg id="N">...</seg> tags with matching IDs.
3. Translate EVERY segment. Do not skip or merge segments.
4. Maintain style, tone, and formatting within each segment.
5. Do NOT wrap in quotes unless the source has them.
6. For proper nouns, use exact translations from the Glossary.
7. Output ONLY the translated segments with their tags, nothing else.
8. NEVER leave English words in the output, except for proper nouns with no standard ${targetLang} translation. Translate every word into ${targetLang}.${glossaryStr}`,
    },
    {
      role: 'user',
      content: taggedInput,
    },
  ], { maxTokens: 16384 });

  const resultMap = new Map<number, string | null>();
  const segRegex = /<seg\s+id="(\d+)">([\s\S]*?)<\/seg>/g;
  let match;
  while ((match = segRegex.exec(response)) !== null) {
    const id = parseInt(match[1], 10);
    resultMap.set(id, match[2].trim());
  }

  for (const seg of segments) {
    if (!resultMap.has(seg.index)) {
      resultMap.set(seg.index, null);
    }
  }

  return resultMap;
}

// ---------------------------------------------------------------------------
// Workflow step functions — each is idempotent and safe to retry
// ---------------------------------------------------------------------------

async function loadJob(db: DbClient, bookUuid: string): Promise<TranslationJobRow> {
  const job = await db.first<TranslationJobRow>(
    'SELECT * FROM translation_jobs WHERE book_uuid = ? LIMIT 1',
    [bookUuid]
  );
  if (!job) throw new Error(`No job found for ${bookUuid}`);
  return job;
}

function loadGlossary(job: TranslationJobRow): Record<string, string> {
  try {
    return job.glossary_json ? JSON.parse(job.glossary_json) : {};
  } catch {
    return {};
  }
}

/**
 * Plan the run: which chapters still need translation. Uses
 * json_array_length() so chapter text payloads never leave the database,
 * and wipes partially-written chapters so redoing them is duplicate-free.
 * Returns a payload small enough for Workflow step state.
 */
export async function planTranslation(
  db: DbClient,
  bookUuid: string
): Promise<{ alreadyCompleted: boolean; pendingChapters: number[]; totalChapters: number }> {
  const job = await loadJob(db, bookUuid);
  if (job.status === 'completed') {
    return { alreadyCompleted: true, pendingChapters: [], totalChapters: job.total_chapters };
  }

  const chapters = await db.all<{ id: number; chapter_number: number; node_count: number }>(
    'SELECT id, chapter_number, COALESCE(json_array_length(text_nodes_json), 0) AS node_count FROM chapters_v2 WHERE book_id = ? ORDER BY chapter_number',
    [job.book_id]
  );

  const nonEmpty = chapters.filter(ch => ch.node_count > 0);
  const counts = new Map<number, number>();
  const CHUNK = 90;
  for (let i = 0; i < nonEmpty.length; i += CHUNK) {
    const ids = nonEmpty.slice(i, i + CHUNK).map(ch => ch.id);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await db.all<{ chapter_id: number; cnt: number }>(
      `SELECT chapter_id, COUNT(*) AS cnt FROM translations_v2 WHERE chapter_id IN (${placeholders}) GROUP BY chapter_id`,
      ids
    );
    for (const row of rows) counts.set(row.chapter_id, row.cnt);
  }

  const pending: number[] = [];
  const partialIds: number[] = [];
  for (const ch of nonEmpty) {
    const cnt = counts.get(ch.id) ?? 0;
    if (cnt === ch.node_count) continue;
    if (cnt > 0) partialIds.push(ch.id);
    pending.push(ch.chapter_number);
  }

  if (partialIds.length > 0) {
    console.log(`[${bookUuid}] Plan: wiping ${partialIds.length} partially translated chapter(s)`);
    const placeholders = partialIds.map(() => '?').join(', ');
    await db.run(`DELETE FROM translations_v2 WHERE chapter_id IN (${placeholders})`, partialIds);
  }

  await db.run(
    "UPDATE translation_jobs SET status = 'translating', updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ? AND status != 'translating'",
    [bookUuid]
  );

  return { alreadyCompleted: false, pendingChapters: pending, totalChapters: job.total_chapters };
}

/** Extract the glossary once per book (no-op when already extracted) */
export async function glossaryStep(db: DbClient, llm: LLMConfig, bookUuid: string): Promise<void> {
  const job = await loadJob(db, bookUuid);
  if (job.glossary_extracted) return;

  const CHAPTER_FETCH_CHUNK = 5;
  const allTexts: string[] = [];
  for (let start = 1; start <= job.total_chapters; start += CHAPTER_FETCH_CHUNK) {
    const end = Math.min(start + CHAPTER_FETCH_CHUNK - 1, job.total_chapters);
    const rows = await db.all<{ text_nodes_json: string | null }>(
      'SELECT text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number BETWEEN ? AND ? ORDER BY chapter_number',
      [job.book_id, start, end]
    );
    for (const row of rows) {
      if (!row.text_nodes_json) continue;
      const nodes: TextNode[] = JSON.parse(row.text_nodes_json);
      for (const n of nodes) allTexts.push(n.text);
    }
  }

  let glossary: Record<string, string> = {};
  let glossaryWarning: string | null = null;
  try {
    glossary = await extractGlossary(llm, allTexts, job.source_language, job.target_language);
    console.log(`[${bookUuid}] Glossary: ${Object.keys(glossary).length} terms`);
  } catch (err) {
    glossaryWarning = `Glossary extraction failed: ${(err as Error).message}. Proceeding without glossary.`;
    console.warn(`[${bookUuid}] ${glossaryWarning}`);
  }

  await db.run(
    "UPDATE translation_jobs SET glossary_json = ?, glossary_extracted = 1, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
    [JSON.stringify(glossary), glossaryWarning, bookUuid]
  );
}

/** Translate the book title once (no-op when already translated) */
export async function bookTitleStep(db: DbClient, llm: LLMConfig, bookUuid: string): Promise<void> {
  const job = await loadJob(db, bookUuid);
  if (job.title_translated) return;

  const glossary = loadGlossary(job);
  const bookRow = await db.first<{ original_title: string }>(
    'SELECT original_title FROM books_v2 WHERE uuid = ?',
    [bookUuid]
  );
  const originalTitle = bookRow?.original_title || 'Untitled';
  const translatedTitle = await translateText(llm, originalTitle, glossary, job.source_language, job.target_language);

  await db.run('UPDATE books_v2 SET title = ? WHERE uuid = ?', [translatedTitle, bookUuid]);
  await db.run(
    'UPDATE translation_jobs SET title_translated = 1, translated_title = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
    [translatedTitle, bookUuid]
  );
  console.log(`[${bookUuid}] Title: "${originalTitle}" → "${translatedTitle}"`);
}

/**
 * Translate one chapter completely: batches, residue-triggered individual
 * retries, chapter title, then derived progress bookkeeping. Idempotent —
 * safe for Workflow step retries.
 */
export async function translateChapterStep(
  db: DbClient,
  llm: LLMConfig,
  bookUuid: string,
  chapterNumber: number,
  batchConcurrency = 3
): Promise<void> {
  const job = await loadJob(db, bookUuid);
  const glossary = loadGlossary(job);

  const chapter = await db.first<{ id: number; original_title: string | null; text_nodes_json: string | null }>(
    'SELECT id, original_title, text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?',
    [job.book_id, chapterNumber]
  );
  if (!chapter || !chapter.text_nodes_json) return;
  const nodes: TextNode[] = JSON.parse(chapter.text_nodes_json);
  if (nodes.length === 0) return;

  // Idempotency: complete chapter → done; partial rows (crashed attempt) → wipe
  const countRow = await db.first<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM translations_v2 WHERE chapter_id = ?',
    [chapter.id]
  );
  const existing = countRow?.cnt ?? 0;
  if (existing === nodes.length) return;
  if (existing > 0) {
    console.log(`[${bookUuid}] Chapter ${chapterNumber}: wiping ${existing} partial row(s) before redo`);
    await db.run('DELETE FROM translations_v2 WHERE chapter_id = ?', [chapter.id]);
  }

  // Batch construction — identical to the Railway pipeline
  const llmBatches: { index: number; text: string; node: TextNode }[][] = [];
  let currentBatch: { index: number; text: string; node: TextNode }[] = [];
  let currentTokens = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const tokens = estimateTokens(node.text);
    if (currentBatch.length > 0 && currentTokens + tokens > MAX_BATCH_TOKENS) {
      llmBatches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push({ index: i, text: node.text, node });
    currentTokens += tokens;
  }
  if (currentBatch.length > 0) llmBatches.push(currentBatch);

  console.log(`[${bookUuid}] Chapter ${chapterNumber}: ${nodes.length} nodes → ${llmBatches.length} batched LLM calls`);

  const failedNodes: TextNode[] = [];

  const processBatch = async (batch: { index: number; text: string; node: TextNode }[]) => {
    const successRows: unknown[][] = [];
    try {
      if (batch.length === 1) {
        const { node } = batch[0];
        const translated = node.text.length > LARGE_NODE_CHAR_THRESHOLD
          ? await translateLargeNode(llm, node.text, glossary, job.source_language, job.target_language, bookUuid)
          : await translateText(llm, node.text, glossary, job.source_language, job.target_language);
        successRows.push([chapter.id, node.xpath, node.text, node.html, translated, node.orderIndex]);
      } else {
        const segments = batch.map(b => ({ index: b.index, text: b.text }));
        const resultMap = await translateBatch(llm, segments, glossary, job.source_language, job.target_language);
        for (const item of batch) {
          const translated = resultMap.get(item.index) ?? null;
          if (translated !== null) {
            const residue = detectEnglishResidue(translated, glossary);
            if (residue.length > 0) {
              console.warn(`[${bookUuid}] Batch seg ${item.index} has English residue: [${residue.join(', ')}] — will retry individually`);
              failedNodes.push(item.node);
              continue;
            }
            successRows.push([chapter.id, item.node.xpath, item.node.text, item.node.html, translated, item.node.orderIndex]);
          } else {
            failedNodes.push(item.node);
          }
        }
      }
    } catch {
      successRows.length = 0;
      failedNodes.push(...batch.map(b => b.node));
    }
    if (successRows.length > 0) {
      await db.batchInsert('translations_v2', [...TRANSLATIONS_V2_COLUMNS], successRows);
    }
  };

  for (let i = 0; i < llmBatches.length; i += batchConcurrency) {
    await Promise.all(llmBatches.slice(i, i + batchConcurrency).map(processBatch));
  }

  // Individual retries for failed/residue nodes
  if (failedNodes.length > 0) {
    console.log(`[${bookUuid}] Retrying ${failedNodes.length} failed node(s) in chapter ${chapterNumber}`);
    for (let i = 0; i < failedNodes.length; i += batchConcurrency) {
      await Promise.all(
        failedNodes.slice(i, i + batchConcurrency).map(async (node) => {
          let translated: string;
          try {
            translated = await translateText(llm, node.text, glossary, job.source_language, job.target_language);
          } catch (retryErr) {
            console.warn(`[${bookUuid}] Retry failed for ${node.xpath}:`, retryErr);
            translated = TRANSLATION_FAILED_MARKER;
          }
          await db.batchInsert(
            'translations_v2',
            [...TRANSLATIONS_V2_COLUMNS],
            [[chapter.id, node.xpath, node.text, node.html, translated, node.orderIndex]]
          );
        })
      );
    }
  }

  // Chapter title
  if (chapter.original_title) {
    try {
      const translatedChTitle = await translateText(
        llm, chapter.original_title, glossary,
        job.source_language, job.target_language
      );
      await db.run(
        'UPDATE chapters_v2 SET title = ? WHERE book_id = ? AND chapter_number = ?',
        [translatedChTitle, job.book_id, chapterNumber]
      );
    } catch { /* keep original title */ }
  }

  // Derived progress: recompute completed_chapters from data so concurrent
  // chapter steps and step retries can never drift the counter
  await db.run(
    `UPDATE translation_jobs SET
       completed_chapters = (
         SELECT COUNT(*) FROM chapters_v2 ch
         WHERE ch.book_id = translation_jobs.book_id
           AND (
             COALESCE(json_array_length(ch.text_nodes_json), 0) = 0
             OR (SELECT COUNT(*) FROM translations_v2 t WHERE t.chapter_id = ch.id)
                = COALESCE(json_array_length(ch.text_nodes_json), 0)
           )
       ),
       current_chapter = ?,
       current_item_offset = 0,
       updated_at = CURRENT_TIMESTAMP
     WHERE book_uuid = ?`,
    [chapterNumber, bookUuid]
  );
  console.log(`[${bookUuid}] Chapter ${chapterNumber} done`);
}

/** Mark the book ready once every chapter is complete */
export async function finalizeStep(db: DbClient, bookUuid: string): Promise<void> {
  const job = await loadJob(db, bookUuid);
  if (job.status === 'completed') return;

  const incomplete = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM chapters_v2 ch
     WHERE ch.book_id = ?
       AND COALESCE(json_array_length(ch.text_nodes_json), 0) > 0
       AND (SELECT COUNT(*) FROM translations_v2 t WHERE t.chapter_id = ch.id)
           != COALESCE(json_array_length(ch.text_nodes_json), 0)`,
    [job.book_id]
  );
  if ((incomplete?.n ?? 0) > 0) {
    throw new Error(`finalize: ${incomplete!.n} chapter(s) still incomplete for ${bookUuid}`);
  }

  // A job with chapters but neither text nodes nor translations means the
  // source state was corrupted (e.g. text_nodes_json cleared while the job
  // was incomplete). Marking that "ready" would publish an empty book.
  if (job.total_chapters > 0) {
    const translated = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM translations_v2 t
       JOIN chapters_v2 ch ON ch.id = t.chapter_id
       WHERE ch.book_id = ?`,
      [job.book_id]
    );
    const withNodes = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chapters_v2
       WHERE book_id = ? AND COALESCE(json_array_length(text_nodes_json), 0) > 0`,
      [job.book_id]
    );
    if ((translated?.n ?? 0) === 0 && (withNodes?.n ?? 0) === 0) {
      throw new Error(
        `finalize: book has ${job.total_chapters} chapter(s) but no text nodes and no translations — refusing to mark ready`
      );
    }
  }

  await db.run("UPDATE books_v2 SET status = 'ready' WHERE uuid = ?", [bookUuid]);
  await db.run('UPDATE chapters_v2 SET text_nodes_json = NULL WHERE book_id = ?', [job.book_id]);
  await db.run(
    "UPDATE translation_jobs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
    [bookUuid]
  );
  console.log(`[${bookUuid}] Translation complete!`);
}

/** Record a workflow-level failure on the job so the UI can surface it */
export async function markJobError(db: DbClient, bookUuid: string, message: string): Promise<void> {
  await db.run(
    "UPDATE translation_jobs SET status = 'error', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
    [message.slice(0, 500), bookUuid]
  );
  await db.run("UPDATE books_v2 SET status = 'error' WHERE uuid = ?", [bookUuid]);
}
