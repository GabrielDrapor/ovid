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
        throw new Error(`LLM API ${res.status}: ${text}`);
      }

      const json = await res.json() as any;
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty LLM response');
      return content;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`LLM retry ${attempt + 1}: ${(err as Error).message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
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
  // Sample strategically
  const samples: string[] = [];
  const total = allTexts.length;
  samples.push(...allTexts.slice(0, Math.min(100, total)));
  if (total > 200) {
    const mid = Math.floor(total / 2) - 25;
    samples.push(...allTexts.slice(mid, mid + 50));
  }
  if (total > 150) {
    samples.push(...allTexts.slice(-50));
  }

  const combinedText = samples.join('\n\n');
  const targetLang = LANGUAGE_NAMES[targetLanguage] || targetLanguage;

  try {
    const response = await llmChat(config, [
      {
        role: 'system',
        content: `You are a professional literary translator specializing in proper noun extraction.
Extract ALL proper nouns from the given ${sourceLanguage} text and provide consistent ${targetLang} translations.
Return ONLY a valid JSON object. Example: {"Whymper": "温珀", "Mr. Whymper": "温珀先生"}`,
      },
      {
        role: 'user',
        content: `Extract all proper nouns and provide ${targetLang} translations. Return ONLY valid JSON.\n\nText:\n${combinedText}`,
      },
    ], { temperature: 0.1 });

    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '');
    }
    return JSON.parse(jsonStr);
  } catch (err) {
    console.warn('Glossary extraction failed:', err);
    return {};
  }
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
 * Detect non-proper-noun English words left in a translation.
 * Returns the offending words, or an empty array if clean.
 */
function detectEnglishResidue(text: string, glossary: Record<string, string>): string[] {
  // Match sequences of 3+ ASCII letters (skip short ones like "OK", "vs")
  const englishWords = text.match(/[a-zA-Z]{3,}/g);
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
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'but',
    'are', 'was', 'were', 'has', 'had', 'have', 'will', 'can', 'may',
    'app', 'web', 'api', 'url', 'http', 'https', 'www', 'html', 'css',
    'pdf', 'jpg', 'png', 'gif', 'xml', 'json', 'sql',
    'seg', 'translate', 'context',  // XML tag residue from prompt
  ]);

  return englishWords.filter(w => {
    const lower = w.toLowerCase();
    return !allowed.has(lower) && !commonAllowed.has(lower);
  });
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

/**
 * Main translation orchestrator — translates an entire book
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
  const setProgress = (phase: string, chaptersCompleted: number, detail?: string) => {
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

      glossary = await extractGlossary(llmConfig, allTexts, job.source_language, job.target_language);
      console.log(`[${bookUuid}] Glossary: ${Object.keys(glossary).length} terms`);

      await db.run(
        "UPDATE translation_jobs SET glossary_json = ?, glossary_extracted = 1, status = 'translating', current_chapter = 1, current_item_offset = 0, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?",
        [JSON.stringify(glossary), bookUuid]
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
      const translatedTitle = await translateText(llmConfig, originalTitle, glossary, job.source_language, job.target_language);

      await db.run('UPDATE books_v2 SET title = ? WHERE uuid = ?', [translatedTitle, bookUuid]);
      await db.run(
        'UPDATE translation_jobs SET title_translated = 1, translated_title = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
        [translatedTitle, bookUuid]
      );
      console.log(`[${bookUuid}] Title: "${originalTitle}" → "${translatedTitle}"`);
    }

    // Phase 3: Translate chapters
    const startChapter = job.glossary_extracted ? (job.current_chapter || 1) : 1;
    let completedChapters = job.completed_chapters || 0;

    for (let chNum = startChapter; chNum <= job.total_chapters; chNum++) {
      checkJobTimeout(bookUuid);
      setProgress('translating', completedChapters, `Chapter ${chNum}/${job.total_chapters}`);

      const row = await db.first<{ text_nodes_json: string }>(
        'SELECT text_nodes_json FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?',
        [job.book_id, chNum]
      );
      const textNodes: TextNode[] = row?.text_nodes_json ? JSON.parse(row.text_nodes_json) : [];

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

      // Resume from offset if partially done
      const startOffset = (chNum === startChapter && job.current_item_offset > 0) ? job.current_item_offset : 0;

      // Group text nodes into LLM-sized batches (~2000 tokens each), then run batches concurrently
      const MAX_BATCH_TOKENS = 2000;
      const CONCURRENCY = 5;

      // Build batches based on token budget
      const llmBatches: { index: number; text: string; node: TextNode }[][] = [];
      let currentBatch: { index: number; text: string; node: TextNode }[] = [];
      let currentTokens = 0;

      for (let i = startOffset; i < textNodes.length; i++) {
        const node = textNodes[i];
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

      console.log(`[${bookUuid}] Chapter ${chNum}: ${textNodes.length - startOffset} nodes → ${llmBatches.length} batched LLM calls (concurrency ${CONCURRENCY})`);

      const failedNodes: TextNode[] = [];

      for (let b = 0; b < llmBatches.length; b += CONCURRENCY) {
        const concurrentBatches = llmBatches.slice(b, b + CONCURRENCY);
        const batchResults = await Promise.allSettled(
          concurrentBatches.map(async (batch) => {
            if (batch.length === 1) {
              // Single node — use simple translateText (more reliable for short text)
              const { node } = batch[0];
              const translated = await translateText(
                llmConfig, node.text, glossary,
                job.source_language, job.target_language
              );
              return new Map([[batch[0].index, { node, translated }]]);
            }

            // Multi-node batch translation
            const segments = batch.map(b => ({ index: b.index, text: b.text }));
            const resultMap = await translateBatch(
              llmConfig, segments, glossary,
              job.source_language, job.target_language
            );
            const out = new Map<number, { node: TextNode; translated: string | null }>();
            for (const item of batch) {
              const translated = resultMap.get(item.index) ?? null;
              // Check for English residue — if found, mark as null to trigger individual retry with stronger prompt
              if (translated !== null) {
                const residue = detectEnglishResidue(translated, glossary);
                if (residue.length > 0) {
                  console.warn(`[${bookUuid}] Batch seg ${item.index} has English residue: [${residue.join(', ')}] — will retry individually`);
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
            failedNodes.push(...concurrentBatches[r].map(b => b.node));
            continue;
          }
          for (const [, { node, translated }] of result.value) {
            if (translated === null) {
              failedNodes.push(node);
            } else {
              successRows.push([chapterRow.id, node.xpath, node.text, node.html, translated, node.orderIndex]);
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
        console.log(`[${bookUuid}] Retrying ${failedNodes.length} failed node(s) in chapter ${chNum}`);
        const retryRows: unknown[][] = [];
        for (const node of failedNodes) {
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
          retryRows.push([chapterRow.id, node.xpath, node.text, node.html, translated, node.orderIndex]);
        }
        if (retryRows.length > 0) {
          await db.batchInsert(
            'translations_v2',
            [...TRANSLATIONS_V2_COLUMNS],
            retryRows
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
            llmConfig, chTitleRow.original_title, glossary,
            job.source_language, job.target_language
          );
          await db.run(
            'UPDATE chapters_v2 SET title = ? WHERE book_id = ? AND chapter_number = ?',
            [translatedChTitle, job.book_id, chNum]
          );
        } catch { /* keep original */ }
      }

      completedChapters++;
      await db.run(
        'UPDATE translation_jobs SET current_chapter = ?, completed_chapters = ?, current_item_offset = 0, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
        [chNum + 1, completedChapters, bookUuid]
      );
      console.log(`[${bookUuid}] Chapter ${chNum}/${job.total_chapters} done`);
    }

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
