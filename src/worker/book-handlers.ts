/**
 * Book upload, estimate, and chunked translation handlers
 */

import { Env } from './types';
import { getCurrentUser } from './auth';
import { getUserCredits, deductCredits } from './credits';
import {
  insertBookShellV2,
  updateBookStatus,
  createTranslationJob,
  getTranslationJob,
  updateTranslationJob,
  storeChapterTextNodes,
  getChapterTextNodes,
  getChapterIdByNumber,
  insertTranslationRow,
  updateChapterTitle,
  clearTextNodesJson,
  deleteTranslationJob,
} from './db';
import { calculateBookCredits, TOKENS_PER_CREDIT } from '../utils/token-counter';
import { Translator, SimpleKVStore } from '../utils/translator';

/** Max paragraphs to translate per /translate-next call (well under 50 subrequest limit) */
const BATCH_SIZE = 25;

/**
 * Handle book upload. Parses EPUB, inserts book shell + text nodes,
 * creates a translation job. No LLM calls — translation is driven
 * by the frontend via /translate-next.
 */
export async function handleBookUpload(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const targetLanguage = formData.get('targetLanguage') as string || 'zh';
    const sourceLanguage = formData.get('sourceLanguage') as string || 'en';

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!file.name.endsWith('.epub')) {
      return new Response(
        JSON.stringify({ error: 'Only EPUB files are supported' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const buffer = await file.arrayBuffer();

    const { BookProcessor } = await import('../utils/book-processor');
    const processor = new BookProcessor(1, {
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_API_BASE_URL,
      model: env.OPENAI_MODEL,
    });

    // Parse EPUB
    const bookData = await processor.parseEPUBV2(buffer);

    const allTexts: string[] = [];
    for (const chapter of bookData.chapters) {
      for (const node of chapter.textNodes) {
        allTexts.push(node.text);
      }
    }

    const model = env.OPENAI_MODEL || 'gpt-4o-mini';
    const requiredCredits = calculateBookCredits(allTexts, targetLanguage, model);
    const userCredits = await getUserCredits(env.DB, user.id);

    if (userCredits < requiredCredits) {
      return new Response(
        JSON.stringify({
          error: 'Insufficient credits',
          required: requiredCredits,
          available: userCredits,
          message: `This book requires ${requiredCredits.toLocaleString()} credits to translate, but you only have ${userCredits.toLocaleString()} credits.`,
        }),
        { status: 402, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Deduct credits upfront
    const bookUuid = crypto.randomUUID();
    await deductCredits(
      env.DB,
      user.id,
      requiredCredits,
      bookUuid,
      `Translation: ${bookData.title || 'Book'}`
    );

    // Insert book shell (metadata + chapters with raw HTML, no translations)
    const bookId = await insertBookShellV2(
      env.DB,
      {
        title: bookData.title,
        originalTitle: bookData.title,
        author: bookData.author,
        languagePair: `${sourceLanguage}-${targetLanguage}`,
        styles: bookData.styles || '',
        chapters: bookData.chapters.map(ch => ({
          number: ch.number,
          title: ch.originalTitle,
          originalTitle: ch.originalTitle,
          rawHtml: ch.rawHtml,
        })),
      },
      bookUuid,
      user.id
    );

    // Store text nodes on each chapter for the translate-next endpoint
    for (const chapter of bookData.chapters) {
      await storeChapterTextNodes(
        env.DB,
        bookId,
        chapter.number,
        JSON.stringify(chapter.textNodes)
      );
    }

    // Create translation job
    await createTranslationJob(
      env.DB,
      bookId,
      bookUuid,
      sourceLanguage,
      targetLanguage,
      bookData.chapters.length
    );

    // Notify Railway translator service (non-blocking)
    if (env.TRANSLATOR_SERVICE_URL && env.TRANSLATOR_SECRET) {
      const translatorUrl = env.TRANSLATOR_SERVICE_URL;
      const translatorSecret = env.TRANSLATOR_SECRET;
      ctx.waitUntil(
        fetch(`${translatorUrl}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookUuid, secret: translatorSecret }),
        }).catch((err) => {
          console.warn(`Failed to notify translator service for ${bookUuid}:`, err);
        })
      );
    }

    // Generate cover images in background (non-blocking)
    if (env.GEMINI_API_KEY && env.ASSETS_BUCKET) {
      ctx.waitUntil(
        (async () => {
          try {
            const { generateBookCovers } = await import('./cover-generator');
            const covers = await generateBookCovers(
              env.GEMINI_API_KEY!,
              env.ASSETS_BUCKET,
              bookData.title,
              bookData.author,
              bookUuid,
              env.COVER_PROCESSOR_URL || '',
              env.COVER_PROCESSOR_SECRET || '',
            );
            // If processor is configured, it updates DB itself.
            // Otherwise fall back to raw images.
            if (!env.COVER_PROCESSOR_URL) {
              await env.DB.prepare(
                'UPDATE books_v2 SET book_cover_img_url = ?, book_spine_img_url = ? WHERE uuid = ?'
              ).bind(covers.coverUrl, covers.spineUrl, bookUuid).run();
            }
            console.log(`Cover generated for ${bookUuid}: ${covers.coverUrl}`);
          } catch (err) {
            console.warn(`Cover generation failed for ${bookUuid}:`, err);
          }
        })()
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        bookUuid,
        creditsUsed: requiredCredits,
        status: 'processing',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Book upload error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    return new Response(
      JSON.stringify({
        error: 'Failed to process book',
        details: errorMessage,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle a single chunk of translation work.
 * Each call translates up to BATCH_SIZE paragraphs, staying within
 * the Cloudflare Workers 50 subrequest limit.
 */
export async function handleTranslateNext(
  request: Request,
  env: Env,
  bookUuid: string
): Promise<Response> {
  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const job = await getTranslationJob(env.DB, bookUuid);
    if (!job) {
      return json({ done: true });
    }

    if (job.status === 'completed') {
      return json({ done: true });
    }

    if (job.status === 'error') {
      return json({ done: true, error: job.error_message });
    }

    // If Railway translator service is configured, just return progress instead of translating here
    if (env.TRANSLATOR_SERVICE_URL) {
      return json({
        done: false,
        progress: {
          phase: job.status === 'extracting_glossary' ? 'glossary' : 'translating',
          chaptersCompleted: job.completed_chapters,
          chaptersTotal: job.total_chapters,
          currentChapter: job.current_chapter,
          railway: true,
        },
      });
    }

    // Build a translator with glossary from the job
    const kvStore = new SimpleKVStore();
    if (job.glossary_json) {
      const glossary = JSON.parse(job.glossary_json) as Record<string, string>;
      for (const [key, value] of Object.entries(glossary)) {
        kvStore.set(key, value);
      }
    }

    const translator = new Translator({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_API_BASE_URL,
      model: env.OPENAI_MODEL,
      concurrency: 1,
      kvStore,
    });

    // Phase 1: Extract glossary
    if (job.status === 'pending' || (job.status === 'extracting_glossary' && !job.glossary_extracted)) {
      await updateTranslationJob(env.DB, bookUuid, { status: 'extracting_glossary' });

      // Gather all text for glossary extraction
      const allTexts: string[] = [];
      for (let ch = 1; ch <= job.total_chapters; ch++) {
        const nodes = await getChapterTextNodes(env.DB, job.book_id, ch);
        if (nodes) {
          for (const node of nodes) {
            allTexts.push(node.text);
          }
        }
      }

      const glossary = await translator.extractProperNouns(allTexts, {
        sourceLanguage: job.source_language,
        targetLanguage: job.target_language,
      });

      await updateTranslationJob(env.DB, bookUuid, {
        glossary_json: JSON.stringify(glossary),
        glossary_extracted: 1,
        status: 'translating',
        current_chapter: 1,
        current_item_offset: 0,
      });

      return json({
        done: false,
        progress: {
          phase: 'glossary',
          chaptersCompleted: 0,
          chaptersTotal: job.total_chapters,
        },
      });
    }

    // Phase 2: Translate
    if (job.status === 'translating') {
      // Translate book title first
      if (!job.title_translated) {
        const bookRow = await env.DB.prepare('SELECT original_title FROM books_v2 WHERE uuid = ?')
          .bind(bookUuid).first();
        const originalTitle = (bookRow?.original_title as string) || 'Untitled';

        const translatedTitle = await translator.translateText(originalTitle, {
          sourceLanguage: job.source_language,
          targetLanguage: job.target_language,
        });

        await env.DB.prepare('UPDATE books_v2 SET title = ? WHERE uuid = ?')
          .bind(translatedTitle, bookUuid).run();

        await updateTranslationJob(env.DB, bookUuid, {
          title_translated: 1,
          translated_title: translatedTitle,
        });

        return json({
          done: false,
          progress: {
            phase: 'translating',
            chaptersCompleted: 0,
            chaptersTotal: job.total_chapters,
            detail: 'Translated book title',
          },
        });
      }

      // Translate chapter content
      const chapterNum = job.current_chapter;
      if (chapterNum > job.total_chapters) {
        // All chapters done
        await updateBookStatus(env.DB, bookUuid, 'ready');
        await clearTextNodesJson(env.DB, job.book_id);
        await updateTranslationJob(env.DB, bookUuid, { status: 'completed' });

        return json({ done: true });
      }

      const textNodes = await getChapterTextNodes(env.DB, job.book_id, chapterNum);
      if (!textNodes || textNodes.length === 0) {
        // Empty chapter, skip to next
        await updateTranslationJob(env.DB, bookUuid, {
          current_chapter: chapterNum + 1,
          current_item_offset: 0,
          completed_chapters: job.completed_chapters + 1,
        });

        return json({
          done: false,
          progress: {
            phase: 'translating',
            chaptersCompleted: job.completed_chapters + 1,
            chaptersTotal: job.total_chapters,
            currentChapter: chapterNum + 1,
          },
        });
      }

      const chapterId = await getChapterIdByNumber(env.DB, job.book_id, chapterNum);
      if (!chapterId) {
        // Chapter not found, skip
        await updateTranslationJob(env.DB, bookUuid, {
          current_chapter: chapterNum + 1,
          current_item_offset: 0,
          completed_chapters: job.completed_chapters + 1,
        });
        return json({
          done: false,
          progress: {
            phase: 'translating',
            chaptersCompleted: job.completed_chapters + 1,
            chaptersTotal: job.total_chapters,
          },
        });
      }

      const offset = job.current_item_offset;
      const batch = textNodes.slice(offset, offset + BATCH_SIZE);

      // Translate batch items
      let translated = 0;
      for (const node of batch) {
        try {
          const translatedText = await translator.translateText(node.text, {
            sourceLanguage: job.source_language,
            targetLanguage: job.target_language,
          });

          await insertTranslationRow(
            env.DB,
            chapterId,
            node.xpath,
            node.text,
            node.html,
            translatedText,
            node.orderIndex
          );
          translated++;
        } catch (err) {
          console.warn(`Translation failed for xpath ${node.xpath}:`, err);
          // Insert placeholder so we don't get stuck
          await insertTranslationRow(
            env.DB,
            chapterId,
            node.xpath,
            node.text,
            node.html,
            `[Translation pending]`,
            node.orderIndex
          );
          translated++;
        }
      }

      const newOffset = offset + translated;
      const chapterDone = newOffset >= textNodes.length;

      if (chapterDone) {
        // Translate chapter title
        const chapterRow = await env.DB.prepare(
          'SELECT original_title FROM chapters_v2 WHERE book_id = ? AND chapter_number = ?'
        ).bind(job.book_id, chapterNum).first();

        if (chapterRow?.original_title) {
          try {
            const translatedChTitle = await translator.translateText(
              chapterRow.original_title as string,
              { sourceLanguage: job.source_language, targetLanguage: job.target_language }
            );
            await updateChapterTitle(env.DB, job.book_id, chapterNum, translatedChTitle);
          } catch {
            // Keep original title on failure
          }
        }

        const newCompleted = job.completed_chapters + 1;
        const nextChapter = chapterNum + 1;

        if (nextChapter > job.total_chapters) {
          // Book complete
          await updateBookStatus(env.DB, bookUuid, 'ready');
          await clearTextNodesJson(env.DB, job.book_id);
          await updateTranslationJob(env.DB, bookUuid, {
            status: 'completed',
            completed_chapters: newCompleted,
            current_chapter: nextChapter,
            current_item_offset: 0,
          });
          return json({ done: true });
        }

        await updateTranslationJob(env.DB, bookUuid, {
          current_chapter: nextChapter,
          current_item_offset: 0,
          completed_chapters: newCompleted,
        });

        return json({
          done: false,
          progress: {
            phase: 'translating',
            chaptersCompleted: newCompleted,
            chaptersTotal: job.total_chapters,
            currentChapter: nextChapter,
          },
        });
      } else {
        // More items in current chapter
        await updateTranslationJob(env.DB, bookUuid, {
          current_item_offset: newOffset,
        });

        return json({
          done: false,
          progress: {
            phase: 'translating',
            chaptersCompleted: job.completed_chapters,
            chaptersTotal: job.total_chapters,
            currentChapter: chapterNum,
            itemsCompleted: newOffset,
            itemsTotal: textNodes.length,
          },
        });
      }
    }

    // Unknown status
    return json({ done: true, error: `Unknown job status: ${job.status}` });
  } catch (error) {
    console.error(`translate-next error for ${bookUuid}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Mark job as error
    try {
      await updateTranslationJob(env.DB, bookUuid, {
        status: 'error',
        error_message: errorMessage,
      });
      await updateBookStatus(env.DB, bookUuid, 'error');
    } catch { /* ignore cleanup errors */ }

    return new Response(
      JSON.stringify({ error: 'Translation chunk failed', details: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle book estimate (calculate credits before upload)
 */
export async function handleBookEstimate(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getCurrentUser(env.DB, request);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const targetLanguage = (formData.get('targetLanguage') as string) || 'zh';

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!file.name.endsWith('.epub')) {
      return new Response(
        JSON.stringify({ error: 'Only EPUB files are supported' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const buffer = await file.arrayBuffer();

    const { BookProcessor } = await import('../utils/book-processor');
    const processor = new BookProcessor(1, {
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_API_BASE_URL,
      model: env.OPENAI_MODEL,
    });

    // Use V2 XPath-based parsing
    const bookData = await processor.parseEPUBV2(buffer);

    const allTexts: string[] = [];
    let chapterCount = 0;
    for (const chapter of bookData.chapters) {
      chapterCount++;
      for (const node of chapter.textNodes) {
        allTexts.push(node.text);
      }
    }

    const model = env.OPENAI_MODEL || 'gpt-4o-mini';
    const requiredCredits = calculateBookCredits(allTexts, targetLanguage, model);
    const userCredits = await getUserCredits(env.DB, user.id);
    const totalCharacters = allTexts.reduce((sum, text) => sum + text.length, 0);

    return new Response(
      JSON.stringify({
        title: bookData.title || file.name.replace('.epub', ''),
        author: bookData.author || 'Unknown',
        chapters: chapterCount,
        characters: totalCharacters,
        estimatedTokens: requiredCredits * TOKENS_PER_CREDIT,
        requiredCredits,
        availableCredits: userCredits,
        canAfford: userCredits >= requiredCredits,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Book estimate error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    return new Response(
      JSON.stringify({
        error: 'Failed to estimate book',
        details: errorMessage,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
