/**
 * Core translation logic for Railway service.
 * Mirrors the CF Worker's handleTranslateNext but without batch limits —
 * translates an entire book in one go.
 *
 * Quality pipeline (style guide, book understanding, chapter-scoped glossary
 * injection, incremental glossary, chapter-end review) adapted from wenyi
 * (https://github.com/BigDawnGhost/wenyi, MIT) — see prompts.ts,
 * book-analysis.ts, glossary.ts, review.ts for the per-piece provenance.
 * Each piece is controlled by a feature flag so the eval harness
 * (services/translator/eval/) can A/B ablate them.
 */

import { D1Client } from './d1-client.js';
import {
  LLMConfig,
  estimateTokens,
  languageName,
  llmChat,
  tierConfig,
} from './llm-client.js';
import {
  buildGlossaryStr,
  extractGlossary,
  extractIncrementalGlossary,
  mergeGlossary,
} from './glossary.js';
import {
  StaticPromptContext,
  formatStyleGuide,
  translatorBatchSystem,
  translatorBatchUser,
  translatorSingleSystem,
  translatorSingleUser,
} from './prompts.js';
import {
  BookContext,
  analyzeStyle,
  digestChapters,
  synthesizeSynopsis,
} from './book-analysis.js';
import {
  ReviewPair,
  SEVERE_ISSUE_TYPES,
  fixTranslation,
  reviewPairs,
} from './review.js';

export type { LLMConfig } from './llm-client.js';

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
  book_context_json?: string | null;
  review_summary_json?: string | null;
}

interface TextNode {
  xpath: string;
  text: string;
  html: string;
  orderIndex: number;
}

// In-progress jobs tracked in memory for status queries
export const activeJobs = new Map<
  string,
  {
    phase: string;
    chaptersCompleted: number;
    chaptersTotal: number;
    currentChapter: number;
    detail?: string;
    startedAt: number;
  }
>();

/** Maximum time a translation job can run before being timed out (4 hours) */
const JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Sentinel value written when a node permanently fails translation after retry */
const TRANSLATION_FAILED_MARKER = '[Translation failed]';

/** Threshold (in characters) above which a single text node is split into chunks for translation */
const LARGE_NODE_CHAR_THRESHOLD = 3000;

/** Column list for translations_v2 batch inserts */
const TRANSLATIONS_V2_COLUMNS = [
  'chapter_id',
  'xpath',
  'original_text',
  'original_html',
  'translated_text',
  'order_index',
] as const;

/** Cap on chapters digested during the pre-scan (evenly sampled beyond this) */
const MAX_DIGEST_CHAPTERS = 60;

/**
 * Feature flags for the wenyi-derived quality pipeline. All default ON;
 * disable individually via env (FEATURE_X=0) or wholesale via
 * TRANSLATOR_FEATURES=off. The eval harness passes these explicitly.
 */
export interface PipelineFeatures {
  /** Pre-translation style analysis injected into every call (wenyi analyzer) */
  styleGuide: boolean;
  /** Chapter digests + whole-book synopsis injected into every call (wenyi book understanding) */
  bookContext: boolean;
  /** Post-chapter glossary extraction from actual translations (wenyi extractor) */
  incrementalGlossary: boolean;
  /** Chapter-end review comparing source/translation pairs (wenyi reviewer) */
  reviewPass: boolean;
  /** Retranslate severe review findings (wenyi autofix_severe) */
  autofixSevere: boolean;
}

export const ALL_FEATURES_OFF: PipelineFeatures = {
  styleGuide: false,
  bookContext: false,
  incrementalGlossary: false,
  reviewPass: false,
  autofixSevere: false,
};

export function resolveFeaturesFromEnv(
  env: Record<string, string | undefined> = process.env
): PipelineFeatures {
  if ((env.TRANSLATOR_FEATURES || '').toLowerCase() === 'off') {
    return { ...ALL_FEATURES_OFF };
  }
  const flag = (name: string) => {
    const v = env[name];
    if (v === undefined || v === '') return true;
    return !['0', 'false', 'off', 'no'].includes(v.toLowerCase());
  };
  return {
    styleGuide: flag('FEATURE_STYLE_GUIDE'),
    bookContext: flag('FEATURE_BOOK_CONTEXT'),
    incrementalGlossary: flag('FEATURE_INCREMENTAL_GLOSSARY'),
    reviewPass: flag('FEATURE_REVIEW_PASS'),
    autofixSevere: flag('FEATURE_AUTOFIX_SEVERE'),
  };
}

function checkJobTimeout(bookUuid: string): void {
  const job = activeJobs.get(bookUuid);
  if (job && Date.now() - job.startedAt > JOB_TIMEOUT_MS) {
    throw new Error(
      `Job timed out after ${JOB_TIMEOUT_MS / 1000 / 60} minutes`
    );
  }
}

/**
 * Translate a single text segment.
 * The static context (style guide / synopsis / chapter digest) is injected
 * user-side in static→dynamic order; the glossary subset is built per text.
 */
export async function translateText(
  config: LLMConfig,
  text: string,
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
  context?: string[],
  staticCtx?: Omit<StaticPromptContext, 'glossaryStr'>
): Promise<string> {
  const srcLang = sourceLanguage;
  const targetLang = languageName(targetLanguage);
  const ctx: StaticPromptContext = {
    ...staticCtx,
    glossaryStr: buildGlossaryStr(text, glossary),
  };

  const translation = await llmChat(config, [
    { role: 'system', content: translatorSingleSystem(srcLang, targetLang) },
    { role: 'user', content: translatorSingleUser(ctx, text, context) },
  ]);

  let result = translation
    .replace(/<\/?translate>/gi, '')
    .replace(/<\/?context>/gi, '')
    .trim();

  // Step 2: Detect English residue and retry once with stronger prompt
  const residue = detectEnglishResidue(result, glossary);
  if (residue.length > 0) {
    console.warn(
      `[translation] English residue detected: [${residue.join(', ')}] — retrying with stronger prompt`
    );

    const retryTranslation = await llmChat(
      config,
      [
        {
          role: 'system',
          content: `You are a professional literary translator. Translate the following ${srcLang} text to ${targetLang}.

**ABSOLUTE REQUIREMENT:** The output must be ENTIRELY in ${targetLang}. Do NOT leave ANY English words in the translation. The previous attempt incorrectly left these English words untranslated: ${residue.join(', ')}. You MUST translate every single word.`,
        },
        { role: 'user', content: translatorSingleUser(ctx, text, context) },
      ],
      { temperature: 0.1 }
    );

    const retryResult = retryTranslation
      .replace(/<\/?translate>/gi, '')
      .replace(/<\/?context>/gi, '')
      .trim();

    const retryResidue = detectEnglishResidue(retryResult, glossary);
    if (retryResidue.length < residue.length) {
      result = retryResult;
    }
    if (retryResidue.length > 0) {
      console.warn(
        `[translation] Retry still has residue: [${retryResidue.join(', ')}] — using ${retryResidue.length < residue.length ? 'retry' : 'original'}`
      );
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
  bookUuid: string,
  staticCtx?: Omit<StaticPromptContext, 'glossaryStr'>
): Promise<string> {
  // Split on double-newline (paragraph breaks)
  const chunks = text.split(/\n\n+/).filter((c) => c.trim().length > 0);

  if (chunks.length <= 1) {
    // No paragraph breaks found — try splitting on single newlines if text is very large
    const fallbackChunks = text.split(/\n/).filter((c) => c.trim().length > 0);
    if (fallbackChunks.length <= 1) {
      // Can't split — just translate as-is (will be truncated but nothing we can do)
      console.warn(
        `[${bookUuid}] Large node (${text.length} chars) has no splittable boundaries`
      );
      return translateText(
        config,
        text,
        glossary,
        sourceLanguage,
        targetLanguage,
        undefined,
        staticCtx
      );
    }
    return translateChunkedParagraphs(
      config,
      fallbackChunks,
      glossary,
      sourceLanguage,
      targetLanguage,
      bookUuid,
      staticCtx
    );
  }

  return translateChunkedParagraphs(
    config,
    chunks,
    glossary,
    sourceLanguage,
    targetLanguage,
    bookUuid,
    staticCtx
  );
}

/** Translate an array of paragraph chunks with concurrency, return joined result */
async function translateChunkedParagraphs(
  config: LLMConfig,
  chunks: string[],
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string,
  bookUuid: string,
  staticCtx?: Omit<StaticPromptContext, 'glossaryStr'>
): Promise<string> {
  console.log(
    `[${bookUuid}] Splitting large node into ${chunks.length} chunks for translation`
  );

  // Group chunks into batches of ~2000 chars to avoid too many LLM calls
  const CHUNK_BATCH_SIZE = 2000;
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentLen = 0;

  for (const chunk of chunks) {
    if (
      currentBatch.length > 0 &&
      currentLen + chunk.length > CHUNK_BATCH_SIZE
    ) {
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
      concurrent.map((batch) => {
        const batchText = batch.join('\n\n');
        return translateText(
          config,
          batchText,
          glossary,
          sourceLanguage,
          targetLanguage,
          undefined,
          staticCtx
        );
      })
    );
    translatedBatches.push(...results);
  }

  return translatedBatches.join('\n\n');
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
      ' '
    )
    .replace(/\.(?:shtml|html?|pdf|txt|aspx?|jsp|php|csv|json|xml)\b/gi, ' ');
}

/**
 * Detect non-proper-noun English words left in a translation.
 * Returns the offending words, or an empty array if clean.
 */
export function detectEnglishResidue(
  text: string,
  glossary: Record<string, string>
): string[] {
  // Strip URLs/emails/file extensions first — citations and reference URLs
  // legitimately remain verbatim and must not count as untranslated text.
  const stripped = stripCitations(text);

  // For CJK targets, if the translation is already mostly target-language, trust it
  // and skip residue scanning. Threshold: ≥60% CJK chars among letter-or-CJK chars
  // means the model produced a real translation; sparse English is almost always
  // legitimate proper nouns the model couldn't transliterate.
  const cjkCount = (stripped.match(/[　-鿿가-힯]/g) ?? []).length;
  const latinCount = (stripped.match(/[a-zA-Z]/g) ?? []).length;
  if (cjkCount > 0 && cjkCount / (cjkCount + latinCount) >= 0.6) {
    return [];
  }

  // Match sequences of 3+ ASCII letters (skip short ones like "OK", "vs")
  const englishWords = stripped.match(/[a-zA-Z]{3,}/g);
  if (!englishWords) return [];

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

  // Common acceptable English tokens in translated text
  const commonAllowed = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'that',
    'this',
    'not',
    'but',
    'are',
    'was',
    'were',
    'has',
    'had',
    'have',
    'will',
    'can',
    'may',
    'app',
    'web',
    'api',
    'url',
    'http',
    'https',
    'www',
    'html',
    'css',
    'pdf',
    'jpg',
    'png',
    'gif',
    'xml',
    'json',
    'sql',
    'seg',
    'translate',
    'context', // XML tag residue from prompt
  ]);

  const residue = englishWords.filter((w) => {
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
    const allTitleCase = residue.every((w) => /^[A-Z][a-z]+$/.test(w));
    const looksLikePinyin =
      residue.length >= 2 &&
      residue.some((w) => /^[A-Z][a-z]+$/.test(w)) &&
      residue.every((w) => /^[A-Z][a-z]+$/.test(w) || /^[a-z]{1,5}$/.test(w));
    if (allTitleCase || looksLikePinyin) return [];
  }

  return residue;
}

/**
 * Translate multiple text segments in a single LLM call using tagged segments.
 * Returns a Map from segment index to translated text.
 * Segments that fail parsing are returned as null so the caller can retry individually.
 *
 * The system prompt is static (no glossary) and the user prompt is ordered
 * static → dynamic, so all batches of a chapter share a cacheable prefix
 * (wenyi's prompt-cache discipline — see prompts.ts).
 */
export async function translateBatch(
  config: LLMConfig,
  segments: { index: number; text: string }[],
  staticCtx: StaticPromptContext,
  sourceLanguage: string,
  targetLanguage: string
): Promise<Map<number, string | null>> {
  const targetLang = languageName(targetLanguage);

  // Build tagged input
  const taggedInput = segments
    .map((s) => `<seg id="${s.index}">${s.text}</seg>`)
    .join('\n');

  const response = await llmChat(
    config,
    [
      {
        role: 'system',
        content: translatorBatchSystem(sourceLanguage, targetLang),
      },
      { role: 'user', content: translatorBatchUser(staticCtx, taggedInput) },
    ],
    { maxTokens: 16384 }
  );

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

/** Load chapter texts (joined text nodes) for pre-scan phases. */
async function loadChapterTexts(
  db: D1Client,
  bookId: number,
  totalChapters: number
): Promise<Array<{ number: number; text: string }>> {
  const chapters: Array<{ number: number; text: string }> = [];
  for (let ch = 1; ch <= totalChapters; ch++) {
    const row = await db.first<{ text_nodes_json: string }>(
      'SELECT text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?',
      [bookId, ch]
    );
    if (row?.text_nodes_json) {
      const nodes: TextNode[] = JSON.parse(row.text_nodes_json);
      chapters.push({ number: ch, text: nodes.map((n) => n.text).join('\n') });
    } else {
      chapters.push({ number: ch, text: '' });
    }
  }
  return chapters;
}

/** Evenly sample chapters for digesting when the book is very long. */
function sampleChaptersForDigest(
  chapters: Array<{ number: number; text: string }>
): Array<{ number: number; text: string }> {
  const nonEmpty = chapters.filter((c) => c.text.trim().length > 0);
  if (nonEmpty.length <= MAX_DIGEST_CHAPTERS) return nonEmpty;
  const step = nonEmpty.length / MAX_DIGEST_CHAPTERS;
  const sampled: Array<{ number: number; text: string }> = [];
  for (let i = 0; i < MAX_DIGEST_CHAPTERS; i++) {
    sampled.push(nonEmpty[Math.floor(i * step)]);
  }
  return sampled;
}

/**
 * Main translation orchestrator — translates an entire book
 */
export async function translateBook(
  db: D1Client,
  llmConfig: LLMConfig,
  bookUuid: string,
  featuresOverride?: PipelineFeatures
): Promise<void> {
  console.log(`[${bookUuid}] Starting translation`);
  const features = featuresOverride ?? resolveFeaturesFromEnv();

  const job = await db.first<TranslationJob>(
    'SELECT * FROM translation_jobs WHERE book_uuid = ? LIMIT 1',
    [bookUuid]
  );
  if (!job) throw new Error(`No job found for ${bookUuid}`);
  if (job.status === 'completed') return;

  const jobStartedAt = Date.now();
  const setProgress = (
    phase: string,
    chaptersCompleted: number,
    detail?: string
  ) => {
    activeJobs.set(bookUuid, {
      phase,
      chaptersCompleted,
      chaptersTotal: job.total_chapters,
      currentChapter: job.current_chapter,
      detail,
      startedAt: jobStartedAt,
    });
  };

  try {
    // Phase 0: Book understanding pre-scan (style guide + digests + synopsis).
    // Adapted from wenyi's analyzer/book_understanding phases. Best-effort:
    // any failure degrades to translating without the corresponding context.
    let bookContext: BookContext | null = null;
    if (job.book_context_json) {
      try {
        bookContext = JSON.parse(job.book_context_json);
      } catch {
        bookContext = null;
      }
    }
    if ((features.styleGuide || features.bookContext) && !bookContext) {
      setProgress('analyzing', 0, 'Analyzing book style and structure...');
      await db.run(
        "UPDATE translation_jobs SET status = 'extracting_glossary', updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
        [bookUuid]
      );
      const chapters = await loadChapterTexts(
        db,
        job.book_id,
        job.total_chapters
      );

      let styleGuide = null;
      if (features.styleGuide) {
        // Style analysis is a one-off judgment call — strong tier (wenyi: 全局分析 strong)
        styleGuide = await analyzeStyle(
          llmConfig,
          chapters.map((c) => c.text),
          job.source_language,
          job.target_language
        );
        console.log(
          `[${bookUuid}] Style analysis ${styleGuide ? 'done' : 'failed (continuing without)'}`
        );
      }

      let digests: Record<string, string> = {};
      let synopsis: string | null = null;
      if (features.bookContext) {
        const fastConfig = tierConfig(llmConfig, 'fast');
        digests = await digestChapters(
          fastConfig,
          sampleChaptersForDigest(chapters),
          job.source_language,
          job.target_language
        );
        synopsis = await synthesizeSynopsis(
          fastConfig,
          digests,
          job.target_language
        );
        console.log(
          `[${bookUuid}] Pre-scan: ${Object.keys(digests).length} digests, synopsis ${synopsis ? 'ok' : 'failed'}`
        );
      }

      bookContext = { styleGuide, synopsis, digests };
      try {
        await db.run(
          'UPDATE translation_jobs SET book_context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
          [JSON.stringify(bookContext), bookUuid]
        );
      } catch (err) {
        // Column may not exist yet (worker migration pending) — keep in memory
        console.warn(
          `[${bookUuid}] Could not persist book context:`,
          (err as Error).message
        );
      }
    }

    const bookStatic: Omit<StaticPromptContext, 'glossaryStr' | 'digestText'> =
      {
        styleGuideText:
          features.styleGuide && bookContext?.styleGuide
            ? formatStyleGuide(bookContext.styleGuide)
            : undefined,
        synopsisText:
          features.bookContext && bookContext?.synopsis
            ? bookContext.synopsis
            : undefined,
      };

    // Phase 1: Glossary extraction
    let glossary: Record<string, string> = {};
    if (!job.glossary_extracted) {
      setProgress('glossary', 0, 'Extracting proper nouns...');
      await db.run(
        "UPDATE translation_jobs SET status = 'extracting_glossary', updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
        [bookUuid]
      );

      const allTexts: string[] = [];
      for (let ch = 1; ch <= job.total_chapters; ch++) {
        const row = await db.first<{ text_nodes_json: string }>(
          'SELECT text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?',
          [job.book_id, ch]
        );
        if (row?.text_nodes_json) {
          const nodes: TextNode[] = JSON.parse(row.text_nodes_json);
          for (const n of nodes) allTexts.push(n.text);
        }
      }

      let glossaryWarning: string | null = null;
      try {
        glossary = await extractGlossary(
          llmConfig,
          allTexts,
          job.source_language,
          job.target_language
        );
        console.log(
          `[${bookUuid}] Glossary: ${Object.keys(glossary).length} terms`
        );
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
      setProgress('translating', 0, 'Translating book title...');
      const bookRow = await db.first<{ original_title: string }>(
        'SELECT original_title FROM books_v2 WHERE uuid = ?',
        [bookUuid]
      );
      const originalTitle = bookRow?.original_title || 'Untitled';
      const translatedTitle = await translateText(
        llmConfig,
        originalTitle,
        glossary,
        job.source_language,
        job.target_language
      );

      await db.run('UPDATE books_v2 SET title = ? WHERE uuid = ?', [
        translatedTitle,
        bookUuid,
      ]);
      await db.run(
        'UPDATE translation_jobs SET title_translated = 1, translated_title = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
        [translatedTitle, bookUuid]
      );
      console.log(
        `[${bookUuid}] Title: "${originalTitle}" → "${translatedTitle}"`
      );
    }

    // Phase 3: Translate chapters
    const startChapter = job.glossary_extracted ? job.current_chapter || 1 : 1;
    let completedChapters = job.completed_chapters || 0;

    // Per-chapter review stats, persisted to translation_jobs.review_summary_json
    let reviewSummary: Record<string, { issues: number; fixed: number }> = {};
    if (job.review_summary_json) {
      try {
        reviewSummary = JSON.parse(job.review_summary_json);
      } catch {
        /* keep empty */
      }
    }

    for (let chNum = startChapter; chNum <= job.total_chapters; chNum++) {
      checkJobTimeout(bookUuid);
      setProgress(
        'translating',
        completedChapters,
        `Chapter ${chNum}/${job.total_chapters}`
      );

      const row = await db.first<{ text_nodes_json: string }>(
        'SELECT text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?',
        [job.book_id, chNum]
      );
      const textNodes: TextNode[] = row?.text_nodes_json
        ? JSON.parse(row.text_nodes_json)
        : [];

      if (textNodes.length === 0) {
        completedChapters++;
        await db.run(
          'UPDATE translation_jobs SET current_chapter = ?, completed_chapters = ?, current_item_offset = 0, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
          [chNum + 1, completedChapters, bookUuid]
        );
        continue;
      }

      // Get chapter ID
      const chapterRow = await db.first<{ id: number }>(
        'SELECT id FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?',
        [job.book_id, chNum]
      );
      if (!chapterRow) {
        completedChapters++;
        continue;
      }

      // Chapter-scoped static context: the glossary subset is computed once
      // over the whole chapter (wenyi glossary_scope: chapter) so every batch
      // in the chapter shares the same cacheable user-prompt prefix.
      const chapterText = textNodes.map((n) => n.text).join('\n');
      const staticCtx: StaticPromptContext = {
        ...bookStatic,
        glossaryStr: buildGlossaryStr(chapterText, glossary),
        digestText: features.bookContext
          ? bookContext?.digests?.[String(chNum)]
          : undefined,
      };

      // Resume from offset if partially done
      const startOffset =
        chNum === startChapter && job.current_item_offset > 0
          ? job.current_item_offset
          : 0;

      // Group text nodes into LLM-sized batches (~2000 tokens each), then run batches concurrently
      const MAX_BATCH_TOKENS = 2000;
      const CONCURRENCY = 5;

      // Build batches based on token budget
      const llmBatches: { index: number; text: string; node: TextNode }[][] =
        [];
      let currentBatch: { index: number; text: string; node: TextNode }[] = [];
      let currentTokens = 0;

      for (let i = startOffset; i < textNodes.length; i++) {
        const node = textNodes[i];
        const tokens = estimateTokens(node.text);
        if (
          currentBatch.length > 0 &&
          currentTokens + tokens > MAX_BATCH_TOKENS
        ) {
          llmBatches.push(currentBatch);
          currentBatch = [];
          currentTokens = 0;
        }
        currentBatch.push({ index: i, text: node.text, node });
        currentTokens += tokens;
      }
      if (currentBatch.length > 0) llmBatches.push(currentBatch);

      console.log(
        `[${bookUuid}] Chapter ${chNum}: ${textNodes.length - startOffset} nodes → ${llmBatches.length} batched LLM calls (concurrency ${CONCURRENCY})`
      );

      const failedNodes: TextNode[] = [];
      // Everything translated in this run of the chapter, for the review pass
      // and incremental glossary extraction (node index → pair).
      const chapterPairs = new Map<
        number,
        { node: TextNode; translated: string }
      >();
      const nodeIndex = new Map<TextNode, number>();
      textNodes.forEach((n, i) => nodeIndex.set(n, i));

      for (let b = 0; b < llmBatches.length; b += CONCURRENCY) {
        const concurrentBatches = llmBatches.slice(b, b + CONCURRENCY);
        const batchResults = await Promise.allSettled(
          concurrentBatches.map(async (batch) => {
            if (batch.length === 1) {
              // Single node — use simple translateText (more reliable for short text)
              const { node } = batch[0];
              const translated =
                node.text.length > LARGE_NODE_CHAR_THRESHOLD
                  ? await translateLargeNode(
                      llmConfig,
                      node.text,
                      glossary,
                      job.source_language,
                      job.target_language,
                      bookUuid,
                      bookStatic
                    )
                  : await translateText(
                      llmConfig,
                      node.text,
                      glossary,
                      job.source_language,
                      job.target_language,
                      undefined,
                      bookStatic
                    );
              return new Map([[batch[0].index, { node, translated }]]);
            }

            // Multi-node batch translation
            const segments = batch.map((b) => ({
              index: b.index,
              text: b.text,
            }));
            const resultMap = await translateBatch(
              llmConfig,
              segments,
              staticCtx,
              job.source_language,
              job.target_language
            );
            const out = new Map<
              number,
              { node: TextNode; translated: string | null }
            >();
            for (const item of batch) {
              const translated = resultMap.get(item.index) ?? null;
              // Check for English residue — if found, mark as null to trigger individual retry with stronger prompt
              if (translated !== null) {
                const residue = detectEnglishResidue(translated, glossary);
                if (residue.length > 0) {
                  console.warn(
                    `[${bookUuid}] Batch seg ${item.index} has English residue: [${residue.join(', ')}] — will retry individually`
                  );
                  out.set(item.index, { node: item.node, translated: null });
                  continue;
                }
              }
              out.set(item.index, { node: item.node, translated });
            }
            return out;
          })
        );

        // Collect results and failures
        const successRows: unknown[][] = [];
        for (let r = 0; r < batchResults.length; r++) {
          const result = batchResults[r];
          if (result.status === 'rejected') {
            // Entire batch failed — collect all nodes for individual retry
            failedNodes.push(...concurrentBatches[r].map((b) => b.node));
            continue;
          }
          for (const [idx, { node, translated }] of result.value) {
            if (translated === null) {
              failedNodes.push(node);
            } else {
              successRows.push([
                chapterRow.id,
                node.xpath,
                node.text,
                node.html,
                translated,
                node.orderIndex,
              ]);
              chapterPairs.set(idx, { node, translated });
            }
          }
        }

        if (successRows.length > 0) {
          await db.batchInsert(
            'translations_v2',
            [...TRANSLATIONS_V2_COLUMNS],
            successRows
          );
        }

        // Update offset for resume capability
        const lastBatch = concurrentBatches[concurrentBatches.length - 1];
        const lastIndex = lastBatch[lastBatch.length - 1].index;
        await db.run(
          'UPDATE translation_jobs SET current_item_offset = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
          [lastIndex + 1, bookUuid]
        );
      }

      // Retry failed nodes one at a time
      if (failedNodes.length > 0) {
        console.log(
          `[${bookUuid}] Retrying ${failedNodes.length} failed node(s) in chapter ${chNum}`
        );
        const retryRows: unknown[][] = [];
        for (const node of failedNodes) {
          let translated: string;
          try {
            translated = await translateText(
              llmConfig,
              node.text,
              glossary,
              job.source_language,
              job.target_language,
              undefined,
              bookStatic
            );
            const idx = nodeIndex.get(node);
            if (idx !== undefined) chapterPairs.set(idx, { node, translated });
          } catch (retryErr) {
            console.warn(
              `[${bookUuid}] Retry failed for ${node.xpath}:`,
              retryErr
            );
            translated = TRANSLATION_FAILED_MARKER;
          }
          retryRows.push([
            chapterRow.id,
            node.xpath,
            node.text,
            node.html,
            translated,
            node.orderIndex,
          ]);
        }
        if (retryRows.length > 0) {
          await db.batchInsert(
            'translations_v2',
            [...TRANSLATIONS_V2_COLUMNS],
            retryRows
          );
        }
      }

      // Post-chapter: incremental glossary extraction (wenyi extractor).
      // New terms from this chapter's actual translations become available
      // to all following chapters. Best-effort — never fails the chapter.
      if (features.incrementalGlossary && chapterPairs.size > 0) {
        const pairs = [...chapterPairs.values()].map((p) => ({
          source: p.node.text,
          translated: p.translated,
        }));
        const extracted = await extractIncrementalGlossary(
          tierConfig(llmConfig, 'fast'),
          pairs,
          glossary,
          job.source_language,
          job.target_language
        );
        const { merged, added } = mergeGlossary(glossary, extracted);
        if (added.length > 0) {
          glossary = merged;
          console.log(
            `[${bookUuid}] Chapter ${chNum}: +${added.length} glossary terms (${added.slice(0, 5).join(', ')}${added.length > 5 ? ', …' : ''})`
          );
          try {
            await db.run(
              'UPDATE translation_jobs SET glossary_json = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
              [JSON.stringify(glossary), bookUuid]
            );
          } catch (err) {
            console.warn(
              `[${bookUuid}] Could not persist glossary update:`,
              (err as Error).message
            );
          }
        }
      }

      // Post-chapter: review pass + severe-issue autofix (wenyi reviewer).
      // Best-effort — review problems are logged; only validated fixes are adopted.
      if (features.reviewPass && chapterPairs.size > 0) {
        setProgress(
          'reviewing',
          completedChapters,
          `Reviewing chapter ${chNum}/${job.total_chapters}`
        );
        try {
          const pairs: ReviewPair[] = [...chapterPairs.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, p]) => ({
              index,
              source: p.node.text,
              translated: p.translated,
            }));
          const issues = await reviewPairs(
            tierConfig(llmConfig, 'cheap'),
            pairs,
            staticCtx.glossaryStr ?? '',
            job.source_language,
            job.target_language
          );

          let fixedCount = 0;
          if (features.autofixSevere) {
            const severe = issues.filter((i) => SEVERE_ISSUE_TYPES.has(i.type));
            for (const issue of severe) {
              const entry = chapterPairs.get(issue.index);
              if (!entry) continue;
              const feedback = `${issue.type}: ${issue.detail}${issue.suggestion ? ` | suggestion: ${issue.suggestion}` : ''}`;
              const fixed = await fixTranslation(
                llmConfig,
                staticCtx,
                {
                  index: issue.index,
                  source: entry.node.text,
                  translated: entry.translated,
                },
                feedback,
                job.source_language,
                job.target_language
              );
              if (fixed && fixed !== entry.translated) {
                await db.run(
                  'UPDATE translations_v2 SET translated_text = ? WHERE chapter_id = ? AND xpath = ? AND order_index = ?',
                  [
                    fixed,
                    chapterRow.id,
                    entry.node.xpath,
                    entry.node.orderIndex,
                  ]
                );
                chapterPairs.set(issue.index, {
                  node: entry.node,
                  translated: fixed,
                });
                fixedCount++;
              }
            }
          }

          if (issues.length > 0) {
            console.log(
              `[${bookUuid}] Chapter ${chNum} review: ${issues.length} issue(s), ${fixedCount} fixed`
            );
          }
          reviewSummary[String(chNum)] = {
            issues: issues.length,
            fixed: fixedCount,
          };
          try {
            await db.run(
              'UPDATE translation_jobs SET review_summary_json = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
              [JSON.stringify(reviewSummary), bookUuid]
            );
          } catch (err) {
            console.warn(
              `[${bookUuid}] Could not persist review summary:`,
              (err as Error).message
            );
          }
        } catch (err) {
          console.warn(
            `[${bookUuid}] Review pass failed for chapter ${chNum}:`,
            (err as Error).message
          );
        }
      }

      // Translate chapter title
      const chTitleRow = await db.first<{ original_title: string }>(
        'SELECT original_title FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?',
        [job.book_id, chNum]
      );
      if (chTitleRow?.original_title) {
        try {
          const translatedChTitle = await translateText(
            llmConfig,
            chTitleRow.original_title,
            glossary,
            job.source_language,
            job.target_language
          );
          await db.run(
            'UPDATE chapters_v2 SET title = ? WHERE book_id = ? AND chapter_number = ?',
            [translatedChTitle, job.book_id, chNum]
          );
        } catch {
          /* keep original */
        }
      }

      completedChapters++;
      await db.run(
        'UPDATE translation_jobs SET current_chapter = ?, completed_chapters = ?, current_item_offset = 0, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
        [chNum + 1, completedChapters, bookUuid]
      );
      console.log(`[${bookUuid}] Chapter ${chNum}/${job.total_chapters} done`);
    }

    // Done — mark completed
    await db.run("UPDATE books_v2 SET status = 'ready' WHERE uuid = ?", [
      bookUuid,
    ]);
    await db.run(
      'UPDATE chapters_v2 SET text_nodes_json = NULL WHERE book_id = ?',
      [job.book_id]
    );
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
      await db.run("UPDATE books_v2 SET status = 'error' WHERE uuid = ?", [
        bookUuid,
      ]);
    } catch {
      /* ignore cleanup errors */
    }

    throw err;
  }
}
