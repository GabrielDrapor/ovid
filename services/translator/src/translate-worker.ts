/**
 * Core translation logic for Railway service.
 * Mirrors the CF Worker's handleTranslateNext but without batch limits —
 * translates an entire book in one go.
 */

import { D1Client } from './d1-client.js';

interface TranslationJob {
  id: number;
  book_id: number;
  book_uuid: string;
  source_language: string;
  target_language: string;
  total_chapters: number;
  completed_chapters: number;
  current_chapter: number;
  current_item_offset: number;
  glossary_json: string | null;
  glossary_extracted: number;
  title_translated: number;
  translated_title: string | null;
  status: string;
  error_message: string | null;
}

interface TextNode {
  xpath: string;
  text: string;
  html: string;
  orderIndex: number;
}

interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

// In-progress jobs tracked in memory for status queries
export const activeJobs = new Map<string, {
  phase: string;
  chaptersCompleted: number;
  chaptersTotal: number;
  currentChapter: number;
  detail?: string;
  startedAt: number;
}>();

/** Maximum time a translation job can run before being timed out (4 hours) */
const JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Sentinel value written when a node permanently fails translation after retry */
const TRANSLATION_FAILED_MARKER = '[Translation failed]';

/** Threshold (in characters) above which a single text node is split into chunks for translation */
const LARGE_NODE_CHAR_THRESHOLD = 3000;

/**
 * Number of LLM calls kept in flight for one book, across ALL chapters.
 * Batches, chapter titles, and per-node retries all share this pool, so the
 * pipeline no longer serializes at chapter boundaries.
 */
const TRANSLATE_CONCURRENCY = (() => {
  const n = parseInt(process.env.TRANSLATE_CONCURRENCY || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 32 ? n : 8;
})();

/** Chapters fetched per D1 REST round-trip (text_nodes_json rows are large) */
const CHAPTER_FETCH_CHUNK = 5;

/** Column list for translations_v2 batch inserts */
const TRANSLATIONS_V2_COLUMNS = ['chapter_id', 'xpath', 'original_text', 'original_html', 'translated_text', 'order_index'] as const;

/** Language code to display name mapping */
const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese', en: 'English', es: 'Spanish', fr: 'French',
  de: 'German', ja: 'Japanese', ko: 'Korean', ru: 'Russian',
};

function checkJobTimeout(bookUuid: string): void {
  const job = activeJobs.get(bookUuid);
  if (job && Date.now() - job.startedAt > JOB_TIMEOUT_MS) {
    throw new Error(`Job timed out after ${JOB_TIMEOUT_MS / 1000 / 60} minutes`);
  }
}

/**
 * Simple LLM chat call (replicates LLMClient.chat for essential use)
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
          // Respect Retry-After when the provider sends it (seconds), capped at 60s
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
        // Exponential backoff + jitter; rate limits wait at least Retry-After
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
 * Try to parse a JSON object string, repairing truncated output by trimming
 * back to the last complete `"key": "value"` entry and re-closing the brace.
 */
function parseGlossaryJson(raw: string): Record<string, string> {
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Repair truncated JSON: trim back to the last `",` (complete entry boundary)
    // and close the object. Handles truncation mid-key or mid-value.
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
 * Extract proper nouns glossary from book text
 */
async function extractGlossary(
  config: LLMConfig,
  allTexts: string[],
  sourceLanguage: string,
  targetLanguage: string
): Promise<Record<string, string>> {
  const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
  const total = allTexts.length;

  // Two attempts with progressively smaller samples to keep output within token budget
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
 * Translate a single text segment with glossary context
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

  // Step 2: Detect English residue and retry once with stronger prompt
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
 * Translate a large text node by splitting on paragraph boundaries (\n\n),
 * translating each chunk independently, then joining the results.
 * This prevents LLM output truncation for very long single nodes.
 */
async function translateLargeNode(
  config: LLMConfig,
  text: string,
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
  bookUuid: string
): Promise<string> {
  // Split on double-newline (paragraph breaks)
  const chunks = text.split(/\n\n+/).filter(c => c.trim().length > 0);

  if (chunks.length <= 1) {
    // No paragraph breaks found — try splitting on single newlines if text is very large
    const fallbackChunks = text.split(/\n/).filter(c => c.trim().length > 0);
    if (fallbackChunks.length <= 1) {
      // Can't split — just translate as-is (will be truncated but nothing we can do)
      console.warn(`[${bookUuid}] Large node (${text.length} chars) has no splittable boundaries`);
      return translateText(config, text, glossary, sourceLanguage, targetLanguage);
    }
    return translateChunkedParagraphs(config, fallbackChunks, glossary, sourceLanguage, targetLanguage, bookUuid);
  }

  return translateChunkedParagraphs(config, chunks, glossary, sourceLanguage, targetLanguage, bookUuid);
}

/** Translate an array of paragraph chunks with concurrency, return joined result */
async function translateChunkedParagraphs(
  config: LLMConfig,
  chunks: string[],
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
  bookUuid: string
): Promise<string> {
  console.log(`[${bookUuid}] Splitting large node into ${chunks.length} chunks for translation`);

  // Group chunks into batches of ~2000 chars to avoid too many LLM calls
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

  // Translate batches with concurrency of 3
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

/** Build glossary string for relevant terms found in text */
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

/**
 * Strip URL-like content (full URLs, bare domains with optional paths,
 * email addresses, and stray file extensions) so they don't pollute the
 * residue analysis. Bibliography-heavy chapters were triggering retries
 * because URL fragments like "nytimes.com/world/asia" pulled the CJK
 * ratio below the threshold and seeded "english residue" tokens.
 */
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
 * Common English words that should never survive untranslated in mostly-CJK
 * output. Used by the high-CJK branch of detectEnglishResidue: a bare
 * lowercase "simply" or "thus" mid-sentence is residue even when 99% of the
 * segment is Chinese. Deliberately curated to avoid pinyin collisions
 * (no "long", "sang", "tong", ... and the ≥3-char rule excludes "he"/"me").
 */
const COMMON_ENGLISH_WORDS = new Set((
  'about above across after again against almost along already also although always among another anyone anything ' +
  'anywhere around because become becomes been before behind being below between both business came cannot certain ' +
  'certainly change children coming completely could course does doing done during each early either enough even ' +
  'every everyone everything exactly example except finally first following found four from further gave general ' +
  'getting give given goes going gone good great group hand having head help here herself high himself history home ' +
  'house however hundred idea important indeed instead into itself just keep kind knew know known large last later ' +
  'least leave left less life like likely little longer look looked looking made make making many matter maybe mean ' +
  'meant might more most much must myself near need never next nothing nowhere number often once only order other ' +
  'others ought over own part people perhaps place point possible probably problem public put quite rather real ' +
  'really right room said same saw says second see seem seemed seems seen several shall should side simply since ' +
  'small some someone something sometimes soon still such sure taken tell than that their them themselves then there ' +
  'these they thing things think third this those though thought three through thus time today together told took ' +
  'toward turn under until upon used using very want water week well went were what when where whether which while ' +
  'whole whom whose will with within without word work world would year years your yourself'
).split(/\s+/));

/**
 * Strip quoted and parenthesized spans. Quoted English in a Chinese
 * translation is deliberate — word discussions, cited phrases, signage,
 * bracketed glosses like 泰勒（tell）— not residue. Span length is bounded
 * so an unbalanced quote can't swallow the whole segment.
 */
function stripQuotedSpans(text: string): string {
  return text
    .replace(/“[^”]{0,120}”/g, ' ')
    .replace(/‘[^’]{0,120}’/g, ' ')
    .replace(/"[^"]{0,120}"/g, ' ')
    .replace(/'[^']{0,80}'/g, ' ')
    .replace(/（[^）]{0,120}）/g, ' ')
    .replace(/\([^)]{0,120}\)/g, ' ');
}

/** Common acceptable English tokens in translated text */
const TECH_ALLOWED = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'but',
  'are', 'was', 'were', 'has', 'had', 'have', 'will', 'can', 'may',
  'app', 'web', 'api', 'url', 'http', 'https', 'www', 'html', 'css',
  'pdf', 'jpg', 'png', 'gif', 'xml', 'json', 'sql',
  'seg', 'translate', 'context',  // XML tag residue from prompt
]);

/**
 * Detect non-proper-noun English words left in a translation.
 * Returns the offending words, or an empty array if clean.
 */
export function detectEnglishResidue(text: string, glossary: Record<string, string>): string[] {
  // Strip URLs/emails/file extensions first — citations and reference URLs
  // legitimately remain verbatim and must not count as untranslated text.
  const stripped = stripCitations(text);

  // Build set of allowed English words from glossary keys + values
  const allowed = new Set<string>();
  for (const [key, val] of Object.entries(glossary)) {
    for (const word of key.split(/\s+/)) {
      if (word.length >= 3) allowed.add(word.toLowerCase());
    }
    // Also allow English in glossary values (e.g. transliterated names)
    for (const word of val.split(/\s+/)) {
      if (/^[a-zA-Z]{3,}$/.test(word)) allowed.add(word.toLowerCase());
    }
  }

  const cjkCount = (stripped.match(/[　-鿿가-힯]/g) ?? []).length;
  const latinCount = (stripped.match(/[a-zA-Z]/g) ?? []).length;
  if (cjkCount > 0 && cjkCount / (cjkCount + latinCount) >= 0.6) {
    // Mostly target-language: sparse English is usually legitimate (proper
    // nouns, quoted phrases) — but a bare lowercase common-English word
    // mid-sentence ("这 simply 让他的战术任务更容易") is residue. Corpus scan
    // over 173k production segments: this flags 0.03% with ~88% precision.
    const bare = stripQuotedSpans(stripped);
    const tokens = bare.match(/[a-zA-Z]{3,}/g) ?? [];
    return tokens.filter(w =>
      /^[a-z]+$/.test(w) &&
      COMMON_ENGLISH_WORDS.has(w) &&
      !TECH_ALLOWED.has(w) &&
      !allowed.has(w)
    );
  }

  // Match sequences of 3+ ASCII letters (skip short ones like "OK", "vs")
  const englishWords = stripped.match(/[a-zA-Z]{3,}/g);
  if (!englishWords) return [];

  const commonAllowed = TECH_ALLOWED;

  const residue = englishWords.filter(w => {
    const lower = w.toLowerCase();
    if (allowed.has(lower) || commonAllowed.has(lower)) return false;
    // All-uppercase tokens are almost always acronyms (NBA, BBC, MTK, CBF, FIFA, GDP)
    // — keep them as-is rather than flagging them as untranslated residue.
    if (/^[A-Z]+$/.test(w)) return false;
    return true;
  });

  if (residue.length === 0) return [];

  // If the segment has CJK content and every residue token looks proper-noun-ish
  // (Title Case, e.g. "Hessler", or a Title-Case head followed by short lowercase
  // pinyin syllables like "Feng", "tong", "xing"), it's a names list / pinyin
  // transliteration the model legitimately preserved. Retrying won't change it
  // and just costs another LLM call.
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

/** Rough token estimate: ~4 chars per token for English, ~2 for CJK */
function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3000-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  return Math.ceil(cjk / 2 + (text.length - cjk) / 4);
}

/**
 * Translate multiple text segments in a single LLM call using tagged segments.
 * Returns a Map from segment index to translated text.
 * Segments that fail parsing are returned as null so the caller can retry individually.
 */
async function translateBatch(
  config: LLMConfig,
  segments: { index: number; text: string }[],
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<Map<number, string | null>> {
  const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

  // Build combined glossary from all segments
  const allText = segments.map(s => s.text).join(' ');
  const glossaryStr = buildGlossaryStr(allText, glossary);

  // Build tagged input
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

  // Parse tagged response
  const resultMap = new Map<number, string | null>();
  const segRegex = /<seg\s+id="(\d+)">([\s\S]*?)<\/seg>/g;
  let match;
  while ((match = segRegex.exec(response)) !== null) {
    const id = parseInt(match[1], 10);
    resultMap.set(id, match[2].trim());
  }

  // Mark missing segments as null
  for (const seg of segments) {
    if (!resultMap.has(seg.index)) {
      resultMap.set(seg.index, null);
    }
  }

  return resultMap;
}

/** Loaded chapter data for the translate phase */
interface ChapterData {
  id: number;
  chapterNumber: number;
  originalTitle: string | null;
  nodes: TextNode[];
}

/**
 * Load all chapters for a book in chunked queries (text_nodes_json rows are
 * large, so fetching the whole book in one round-trip risks oversized
 * responses; per-chapter fetching wastes N sequential HTTP round-trips).
 */
async function loadChapters(db: D1Client, bookId: number, totalChapters: number): Promise<ChapterData[]> {
  const chapters: ChapterData[] = [];
  for (let start = 1; start <= totalChapters; start += CHAPTER_FETCH_CHUNK) {
    const end = Math.min(start + CHAPTER_FETCH_CHUNK - 1, totalChapters);
    const rows = await db.all<{ id: number; chapter_number: number; original_title: string | null; text_nodes_json: string | null }>(
      'SELECT id, chapter_number, original_title, text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number BETWEEN ? AND ? ORDER BY chapter_number',
      [bookId, start, end]
    );
    for (const row of rows) {
      chapters.push({
        id: row.id,
        chapterNumber: row.chapter_number,
        originalTitle: row.original_title ?? null,
        nodes: row.text_nodes_json ? JSON.parse(row.text_nodes_json) : [],
      });
    }
  }
  return chapters;
}

/**
 * Count existing translation rows per chapter. A chapter is complete iff its
 * row count equals its node count (failed nodes still get a marker row, so
 * counts match). translations_v2 has no UNIQUE(chapter_id, xpath) constraint,
 * so any other count means a partial/duplicated chapter that must be wiped
 * and redone to stay idempotent.
 */
async function countExistingTranslations(db: D1Client, chapterIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  const CHUNK = 90; // D1 REST API: 100 bound params per query
  for (let i = 0; i < chapterIds.length; i += CHUNK) {
    const ids = chapterIds.slice(i, i + CHUNK);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await db.all<{ chapter_id: number; cnt: number }>(
      `SELECT chapter_id, COUNT(*) AS cnt FROM translations_v2 WHERE chapter_id IN (${placeholders}) GROUP BY chapter_id`,
      ids
    );
    for (const row of rows) counts.set(row.chapter_id, row.cnt);
  }
  return counts;
}

/**
 * Main translation orchestrator — translates an entire book.
 *
 * All LLM work (paragraph batches, chapter titles, per-node retries) flows
 * through one global worker pool of TRANSLATE_CONCURRENCY, so chapters no
 * longer serialize at their boundaries. Prompts, batch sizes, and the
 * residue-retry ladder are identical to the sequential pipeline — only the
 * scheduling changed.
 *
 * Checkpointing is chapter-level: a chapter counts as done only when every
 * node has a row in translations_v2 (translation or failure marker). On
 * resume, chapters with a mismatched row count are wiped and redone, which
 * also closes the old crash window where the item offset could advance past
 * nodes whose rows were never written.
 */
export async function translateBook(
  db: D1Client,
  llmConfig: LLMConfig,
  bookUuid: string
): Promise<void> {
  console.log(`[${bookUuid}] Starting translation`);

  const job = await db.first<TranslationJob>(
    'SELECT * FROM translation_jobs WHERE book_uuid = ? LIMIT 1',
    [bookUuid]
  );
  if (!job) throw new Error(`No job found for ${bookUuid}`);
  if (job.status === 'completed') return;

  const jobStartedAt = Date.now();
  const setProgress = (phase: string, chaptersCompleted: number, currentChapter: number, detail?: string) => {
    activeJobs.set(bookUuid, {
      phase,
      chaptersCompleted,
      chaptersTotal: job.total_chapters,
      currentChapter,
      detail,
      startedAt: jobStartedAt,
    });
  };

  try {
    checkJobTimeout(bookUuid);

    // Load all chapter data upfront (shared by glossary sampling + translation)
    const chapters = await loadChapters(db, job.book_id, job.total_chapters);

    // Phase 1: Glossary extraction
    let glossary: Record<string, string> = {};
    if (!job.glossary_extracted) {
      setProgress('glossary', 0, job.current_chapter, 'Extracting proper nouns...');
      await db.run(
        "UPDATE translation_jobs SET status = 'extracting_glossary', updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
        [bookUuid]
      );

      const allTexts: string[] = [];
      for (const ch of chapters) {
        for (const n of ch.nodes) allTexts.push(n.text);
      }

      let glossaryWarning: string | null = null;
      try {
        glossary = await extractGlossary(llmConfig, allTexts, job.source_language, job.target_language);
        console.log(`[${bookUuid}] Glossary: ${Object.keys(glossary).length} terms`);
      } catch (err) {
        glossaryWarning = `Glossary extraction failed: ${(err as Error).message}. Proceeding without glossary.`;
        console.warn(`[${bookUuid}] ${glossaryWarning}`);
        glossary = {};
      }

      await db.run(
        "UPDATE translation_jobs SET glossary_json = ?, glossary_extracted = 1, status = 'translating', current_chapter = 1, current_item_offset = 0, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
        [JSON.stringify(glossary), glossaryWarning, bookUuid]
      );
    } else if (job.glossary_json) {
      glossary = JSON.parse(job.glossary_json);
    }

    // Phase 2: Translate book title
    if (!job.title_translated) {
      setProgress('translating', 0, job.current_chapter, 'Translating book title...');
      const bookRow = await db.first<{ original_title: string }>(
        'SELECT original_title FROM books_v2 WHERE uuid = ?',
        [bookUuid]
      );
      const originalTitle = bookRow?.original_title || 'Untitled';
      const translatedTitle = await translateText(llmConfig, originalTitle, glossary, job.source_language, job.target_language);

      await db.run('UPDATE books_v2 SET title = ? WHERE uuid = ?', [translatedTitle, bookUuid]);
      await db.run(
        'UPDATE translation_jobs SET title_translated = 1, translated_title = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
        [translatedTitle, bookUuid]
      );
      console.log(`[${bookUuid}] Title: "${originalTitle}" → "${translatedTitle}"`);
    }

    // Phase 3: Figure out which chapters still need work (chapter-level,
    // row-count-based resume; the legacy current_item_offset is superseded)
    const nonEmptyChapters = chapters.filter(ch => ch.nodes.length > 0);
    const existingCounts = await countExistingTranslations(db, nonEmptyChapters.map(ch => ch.id));

    const pendingChapters: ChapterData[] = [];
    const partialChapterIds: number[] = [];
    for (const ch of nonEmptyChapters) {
      const cnt = existingCounts.get(ch.id) ?? 0;
      if (cnt === ch.nodes.length) continue; // fully translated
      if (cnt > 0) partialChapterIds.push(ch.id);
      pendingChapters.push(ch);
    }

    if (partialChapterIds.length > 0) {
      // Wipe partial chapters so redoing them can't leave duplicate rows
      console.log(`[${bookUuid}] Resume: wiping ${partialChapterIds.length} partially translated chapter(s)`);
      const placeholders = partialChapterIds.map(() => '?').join(', ');
      await db.run(
        `DELETE FROM translations_v2 WHERE chapter_id IN (${placeholders})`,
        partialChapterIds
      );
    }

    // Chapters that are empty, missing, or already fully translated count as done
    let completedChapters = job.total_chapters - pendingChapters.length;
    const pendingChapterNumbers = new Set(pendingChapters.map(ch => ch.chapterNumber));
    const lowestPending = () => {
      let min = job.total_chapters + 1;
      for (const n of pendingChapterNumbers) min = Math.min(min, n);
      return Math.min(min, job.total_chapters);
    };

    // Serialize job-progress writes so completion updates never interleave
    let progressChain: Promise<void> = Promise.resolve();
    const recordChapterComplete = (ch: ChapterData): Promise<void> => {
      pendingChapterNumbers.delete(ch.chapterNumber);
      completedChapters++;
      const completedSnapshot = completedChapters;
      const nextChapter = lowestPending();
      setProgress('translating', completedSnapshot, nextChapter, `Chapter ${nextChapter}/${job.total_chapters}`);
      console.log(`[${bookUuid}] Chapter ${ch.chapterNumber}/${job.total_chapters} done`);
      progressChain = progressChain.then(() =>
        db.run(
          'UPDATE translation_jobs SET current_chapter = ?, completed_chapters = ?, current_item_offset = 0, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
          [nextChapter, completedSnapshot, bookUuid]
        )
      );
      return progressChain;
    };

    setProgress('translating', completedChapters, lowestPending(), `Chapter ${lowestPending()}/${job.total_chapters}`);

    // Phase 4: One global work queue across all chapters — paragraph batches,
    // chapter titles, and individual retries all share the same pool.
    const MAX_BATCH_TOKENS = 2000;

    interface ChapterState {
      ch: ChapterData;
      pending: number; // outstanding work items (batches + title + retries)
    }

    type WorkItem = () => Promise<void>;
    const queue: WorkItem[] = [];
    let fatalError: Error | null = null;

    const finishItem = async (state: ChapterState) => {
      state.pending--;
      if (state.pending === 0) {
        await recordChapterComplete(state.ch);
      }
    };

    const makeRetryItem = (state: ChapterState, node: TextNode): WorkItem => async () => {
      let translated: string;
      try {
        translated = await translateText(
          llmConfig, node.text, glossary,
          job.source_language, job.target_language
        );
      } catch (retryErr) {
        console.warn(`[${bookUuid}] Retry failed for ${node.xpath}:`, retryErr);
        translated = TRANSLATION_FAILED_MARKER;
      }
      await db.batchInsert(
        'translations_v2',
        [...TRANSLATIONS_V2_COLUMNS],
        [[state.ch.id, node.xpath, node.text, node.html, translated, node.orderIndex]]
      );
      await finishItem(state);
    };

    const makeTitleItem = (state: ChapterState): WorkItem => async () => {
      try {
        const translatedChTitle = await translateText(
          llmConfig, state.ch.originalTitle!, glossary,
          job.source_language, job.target_language
        );
        await db.run(
          'UPDATE chapters_v2 SET title = ? WHERE book_id = ? AND chapter_number = ?',
          [translatedChTitle, job.book_id, state.ch.chapterNumber]
        );
      } catch { /* keep original title */ }
      await finishItem(state);
    };

    const makeBatchItem = (
      state: ChapterState,
      batch: { index: number; text: string; node: TextNode }[]
    ): WorkItem => async () => {
      const failedNodes: TextNode[] = [];
      const successRows: unknown[][] = [];

      try {
        if (batch.length === 1) {
          // Single node — use simple translateText (more reliable for short text)
          const { node } = batch[0];
          const translated = node.text.length > LARGE_NODE_CHAR_THRESHOLD
            ? await translateLargeNode(llmConfig, node.text, glossary, job.source_language, job.target_language, bookUuid)
            : await translateText(llmConfig, node.text, glossary, job.source_language, job.target_language);
          successRows.push([state.ch.id, node.xpath, node.text, node.html, translated, node.orderIndex]);
        } else {
          // Multi-node batch translation
          const segments = batch.map(b => ({ index: b.index, text: b.text }));
          const resultMap = await translateBatch(
            llmConfig, segments, glossary,
            job.source_language, job.target_language
          );
          for (const item of batch) {
            const translated = resultMap.get(item.index) ?? null;
            // Check for English residue — if found, retry individually with stronger prompt
            if (translated !== null) {
              const residue = detectEnglishResidue(translated, glossary);
              if (residue.length > 0) {
                console.warn(`[${bookUuid}] Batch seg ${item.index} has English residue: [${residue.join(', ')}] — will retry individually`);
                failedNodes.push(item.node);
                continue;
              }
              successRows.push([state.ch.id, item.node.xpath, item.node.text, item.node.html, translated, item.node.orderIndex]);
            } else {
              failedNodes.push(item.node);
            }
          }
        }
      } catch {
        // Entire batch failed — every node goes to individual retry
        successRows.length = 0;
        failedNodes.length = 0;
        failedNodes.push(...batch.map(b => b.node));
      }

      if (successRows.length > 0) {
        await db.batchInsert('translations_v2', [...TRANSLATIONS_V2_COLUMNS], successRows);
      }

      if (failedNodes.length > 0) {
        console.log(`[${bookUuid}] Retrying ${failedNodes.length} failed node(s) in chapter ${state.ch.chapterNumber}`);
        // Register retries before finishing this item so the chapter can't
        // be marked complete while retries are still outstanding
        state.pending += failedNodes.length;
        for (const node of failedNodes) {
          queue.push(makeRetryItem(state, node));
        }
      }

      await finishItem(state);
    };

    // Enqueue chapters in reading order so early chapters finish first
    for (const ch of pendingChapters) {
      // Group text nodes into LLM-sized batches (~2000 tokens each)
      const llmBatches: { index: number; text: string; node: TextNode }[][] = [];
      let currentBatch: { index: number; text: string; node: TextNode }[] = [];
      let currentTokens = 0;

      for (let i = 0; i < ch.nodes.length; i++) {
        const node = ch.nodes[i];
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

      const state: ChapterState = {
        ch,
        pending: llmBatches.length + (ch.originalTitle ? 1 : 0),
      };

      console.log(`[${bookUuid}] Chapter ${ch.chapterNumber}: ${ch.nodes.length} nodes → ${llmBatches.length} batched LLM calls`);

      for (const batch of llmBatches) {
        queue.push(makeBatchItem(state, batch));
      }
      if (ch.originalTitle) {
        queue.push(makeTitleItem(state));
      }
    }

    // Run the pool: N workers drain the shared queue. Workers that find the
    // queue empty exit; a worker that enqueues retries keeps looping, so
    // dynamically added items always get processed.
    const worker = async () => {
      while (queue.length > 0) {
        if (fatalError) return;
        const item = queue.shift()!;
        try {
          checkJobTimeout(bookUuid);
          await item();
        } catch (err) {
          fatalError = fatalError ?? (err as Error);
          return;
        }
      }
    };

    console.log(`[${bookUuid}] ${pendingChapters.length} chapter(s) to translate, pool size ${TRANSLATE_CONCURRENCY}`);
    await Promise.all(Array.from({ length: TRANSLATE_CONCURRENCY }, () => worker()));
    await progressChain.catch((err) => {
      fatalError = fatalError ?? (err as Error);
    });
    if (fatalError) throw fatalError;

    // Done — mark completed
    await db.run("UPDATE books_v2 SET status = 'ready' WHERE uuid = ?", [bookUuid]);
    await db.run('UPDATE chapters_v2 SET text_nodes_json = NULL WHERE book_id = ?', [job.book_id]);
    await db.run(
      "UPDATE translation_jobs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
      [bookUuid]
    );
    activeJobs.delete(bookUuid);
    console.log(`[${bookUuid}] Translation complete!`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${bookUuid}] Translation error:`, msg);
    activeJobs.delete(bookUuid);

    try {
      await db.run(
        "UPDATE translation_jobs SET status = 'error', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
        [msg, bookUuid]
      );
      await db.run("UPDATE books_v2 SET status = 'error' WHERE uuid = ?", [bookUuid]);
    } catch { /* ignore cleanup errors */ }

    throw err;
  }
}
