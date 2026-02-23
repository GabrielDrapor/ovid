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
}>();

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
  const targetLangMap: Record<string, string> = {
    zh: 'Chinese', en: 'English', es: 'Spanish', fr: 'French',
    de: 'German', ja: 'Japanese', ko: 'Korean', ru: 'Russian',
  };
  const targetLang = targetLangMap[targetLanguage] || targetLanguage;

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
  const targetLangMap: Record<string, string> = {
    zh: 'Chinese', en: 'English', es: 'Spanish', fr: 'French',
    de: 'German', ja: 'Japanese', ko: 'Korean', ru: 'Russian',
  };
  const targetLang = targetLangMap[targetLanguage] || targetLanguage;

  // Find relevant glossary entries
  const relevant: Record<string, string> = {};
  const textLower = text.toLowerCase();
  for (const [key, value] of Object.entries(glossary)) {
    if (textLower.includes(key.toLowerCase())) {
      relevant[key] = value;
    }
  }

  let glossaryStr = '';
  if (Object.keys(relevant).length > 0) {
    const entries = Object.entries(relevant)
      .sort((a, b) => b[0].length - a[0].length)
      .map(([k, v]) => `  "${k}" → "${v}"`)
      .join('\n');
    glossaryStr = `\n\n**GLOSSARY (MUST use these exact translations):**\n${entries}\n`;
  }

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
5. Output ONLY the translated text.${glossaryStr}`,
    },
    {
      role: 'user',
      content: `${contextStr}\n<translate>\n${text}\n</translate>`,
    },
  ]);

  return translation
    .replace(/<\/?translate>/gi, '')
    .replace(/<\/?context>/gi, '')
    .trim();
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

  const setProgress = (phase: string, chaptersCompleted: number, detail?: string) => {
    activeJobs.set(bookUuid, {
      phase,
      chaptersCompleted,
      chaptersTotal: job.total_chapters,
      currentChapter: job.current_chapter,
      detail,
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

      // Translate text nodes
      for (let i = startOffset; i < textNodes.length; i++) {
        const node = textNodes[i];
        try {
          const translated = await translateText(
            llmConfig, node.text, glossary,
            job.source_language, job.target_language
          );

          await db.run(
            `INSERT OR REPLACE INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index) VALUES (?, ?, ?, ?, ?, ?)`,
            [chapterRow.id, node.xpath, node.text, node.html, translated, node.orderIndex]
          );
        } catch (err) {
          console.warn(`[${bookUuid}] Node ${node.xpath} failed:`, err);
          await db.run(
            `INSERT OR REPLACE INTO translations_v2 (chapter_id, xpath, original_text, original_html, translated_text, order_index) VALUES (?, ?, ?, ?, ?, ?)`,
            [chapterRow.id, node.xpath, node.text, node.html, '[Translation pending]', node.orderIndex]
          );
        }

        // Update offset every 10 items for resume capability
        if (i % 10 === 0) {
          await db.run(
            'UPDATE translation_jobs SET current_item_offset = ?, updated_at = CURRENT_TIMESTAMP WHERE book_uuid = ?',
            [i, bookUuid]
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
