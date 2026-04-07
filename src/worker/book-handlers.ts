/**
 * Book upload, estimate, and chunked translation handlers
 *
 * Upload & estimate are thin relays — the heavy EPUB/MOBI parsing
 * happens on the Railway translator service to avoid CF Worker CPU limits.
 */

import { Env } from './types';
import { getCurrentUser } from './auth';
import {
  updateBookStatus,
  getTranslationJob,
  updateTranslationJob,
  getChapterTextNodes,
  getChapterIdByNumber,
  insertTranslationRow,
  updateChapterTitle,
  clearTextNodesJson,
} from './db';
import { Translator, SimpleKVStore } from '../utils/translator';

/** Max paragraphs to translate per /translate-next call (well under 50 subrequest limit) */
const BATCH_SIZE = 25;

/**
 * Handle book upload.
 * Stores the raw file to R2 and delegates parsing + DB writes to Railway.
 * No EPUB parsing in-worker — avoids CF CPU time limits.
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
    // Require Railway translator service for upload
    if (!env.TRANSLATOR_SERVICE_URL || !env.TRANSLATOR_SECRET) {
      return new Response(
        JSON.stringify({ error: 'Translation service not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const contentType = request.headers.get('content-type') || '';
    let fileExtension: string;
    let r2Key: string;
    let targetLanguage = 'zh';
    let sourceLanguage = 'en';
    const bookUuid = crypto.randomUUID();

    if (contentType.includes('application/json')) {
      // Fast path: file already in R2 from estimate phase — just copy it
      const body = await request.json() as { fileKey?: string; targetLanguage?: string; sourceLanguage?: string };

      if (!body.fileKey) {
        return new Response(JSON.stringify({ error: 'Missing fileKey' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }

      targetLanguage = body.targetLanguage || 'zh';
      sourceLanguage = body.sourceLanguage || 'en';

      // Derive extension from the temp key
      const supportedExtensions = ['.epub', '.mobi', '.azw3'];
      const ext = supportedExtensions.find(e => body.fileKey!.endsWith(e));
      if (!ext) {
        return new Response(
          JSON.stringify({ error: 'Invalid fileKey extension' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      fileExtension = ext;

      // Copy from temp estimate path to permanent path
      const tempObject = await env.ASSETS_BUCKET.get(body.fileKey);
      if (!tempObject) {
        console.warn(`Upload: estimate file not found at ${body.fileKey}`);
        return new Response(
          JSON.stringify({ error: 'Estimated file not found — please re-upload' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      r2Key = `uploads/${bookUuid}/original${fileExtension}`;
      await env.ASSETS_BUCKET.put(r2Key, tempObject.body, {
        httpMetadata: tempObject.httpMetadata,
        customMetadata: tempObject.customMetadata,
      });

      // Delete the temp estimate file
      await env.ASSETS_BUCKET.delete(body.fileKey);
    } else {
      // Legacy path: file sent via FormData
      const formData = await request.formData();
      const file = formData.get('file') as File;
      targetLanguage = (formData.get('targetLanguage') as string) || 'zh';
      sourceLanguage = (formData.get('sourceLanguage') as string) || 'en';

      if (!file) {
        return new Response(JSON.stringify({ error: 'No file provided' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }

      const fileName = file.name.toLowerCase();
      const supportedExtensions = ['.epub', '.mobi', '.azw3'];
      const ext = supportedExtensions.find(e => fileName.endsWith(e));
      if (!ext) {
        return new Response(
          JSON.stringify({ error: 'Only EPUB, MOBI, and AZW3 files are supported' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      fileExtension = ext;

      const buffer = await file.arrayBuffer();
      r2Key = `uploads/${bookUuid}/original${fileExtension}`;
      await env.ASSETS_BUCKET.put(r2Key, buffer, {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { originalName: file.name },
      });
    }

    // Create a placeholder book record so it appears on the shelf immediately
    const maxOrderRow = await env.DB.prepare(
      'SELECT COALESCE(MAX(display_order), 0) as max_order FROM books_v2'
    ).first<{ max_order: number }>();
    const nextOrder = ((maxOrderRow?.max_order) || 0) + 1;
    await env.DB.prepare(
      `INSERT INTO books_v2 (uuid, title, original_title, author, language_pair, user_id, status, display_order)
       VALUES (?, 'Processing...', '', '', ?, ?, 'processing', ?)`
    ).bind(bookUuid, `${sourceLanguage}-${targetLanguage}`, user.id, nextOrder).run();

    // Delegate everything to Railway (parsing, DB writes, credits, translation)
    const translatorUrl = env.TRANSLATOR_SERVICE_URL;
    const translatorSecret = env.TRANSLATOR_SECRET;
    ctx.waitUntil(
      fetch(`${translatorUrl}/upload-and-parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookUuid,
          fileKey: r2Key,
          fileExtension,
          sourceLanguage,
          targetLanguage,
          userId: user.id,
          secret: translatorSecret,
        }),
      }).catch((err) => {
        console.error(`Failed to notify translator service for ${bookUuid}:`, err);
      })
    );

    // Return immediately — Railway handles the rest
    return new Response(
      JSON.stringify({
        success: true,
        bookUuid,
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

      // Translate batch items, collecting failures for retry
      let translated = 0;
      const failedNodes: typeof batch = [];
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
          failedNodes.push(node);
          translated++;
        }
      }

      // Retry failed nodes one at a time
      for (const node of failedNodes) {
        let retryText: string;
        try {
          retryText = await translator.translateText(node.text, {
            sourceLanguage: job.source_language,
            targetLanguage: job.target_language,
          });
        } catch {
          retryText = '[Translation failed]';
        }
        await insertTranslationRow(
          env.DB,
          chapterId,
          node.xpath,
          node.text,
          node.html,
          retryText,
          node.orderIndex
        );
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
 * Handle book estimate — delegates to Railway to avoid CPU-heavy parsing in Worker.
 * Stores file temporarily in R2, asks Railway to parse and estimate, returns result.
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

  // Require Railway translator service for estimate
  if (!env.TRANSLATOR_SERVICE_URL || !env.TRANSLATOR_SECRET) {
    return new Response(
      JSON.stringify({ error: 'Translation service not configured' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
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

    const fileName = file.name.toLowerCase();
    const supportedExtensions = ['.epub', '.mobi', '.azw3'];
    const fileExtension = supportedExtensions.find(ext => fileName.endsWith(ext));

    if (!fileExtension) {
      return new Response(
        JSON.stringify({ error: 'Only EPUB, MOBI, and AZW3 files are supported' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const buffer = await file.arrayBuffer();

    // Store file temporarily in R2 for Railway to parse
    const tempKey = `uploads/_estimate/${crypto.randomUUID()}${fileExtension}`;
    await env.ASSETS_BUCKET.put(tempKey, buffer, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
      customMetadata: { originalName: file.name },
    });
    console.log(`Estimate: stored temp file at ${tempKey}`);

    // Ask Railway to parse and estimate
    const resp = await fetch(`${env.TRANSLATOR_SERVICE_URL}/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileKey: tempKey,
        fileExtension,
        targetLanguage,
        userId: user.id,
        secret: env.TRANSLATOR_SECRET,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Railway estimate error:', errText);
      return new Response(
        JSON.stringify({ error: 'Estimation failed', details: errText }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const result = await resp.json();
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
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
