/**
 * Book upload and estimate handlers
 */

import { Env } from './types';
import { getCurrentUser } from './auth';
import { getUserCredits, deductCredits } from './credits';
import { insertBookShellV2, insertChapterTranslationsV2, updateBookStatus } from './db';
import { calculateBookCredits, TOKENS_PER_CREDIT } from '../utils/token-counter';

/**
 * Handle book upload with async background translation.
 * Returns immediately after parsing and inserting the book shell,
 * then translates in the background via ctx.waitUntil().
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
    // Use concurrency=1 to stay within Cloudflare Workers' 50 subrequest limit.
    // Each translation = 1 fetch subrequest; parallel calls exhaust the budget quickly.
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
          title: ch.originalTitle, // will be updated with translated title later
          originalTitle: ch.originalTitle,
          rawHtml: ch.rawHtml,
        })),
      },
      bookUuid,
      user.id
    );

    // Background translation via ctx.waitUntil
    ctx.waitUntil(
      translateInBackground(env, processor, bookData, bookId, bookUuid, targetLanguage, sourceLanguage)
    );

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
 * Background translation task run via ctx.waitUntil()
 */
async function translateInBackground(
  env: Env,
  processor: any,
  bookData: any,
  bookId: number,
  bookUuid: string,
  targetLanguage: string,
  sourceLanguage: string
): Promise<void> {
  try {
    console.log(`🔄 Starting background translation for ${bookUuid}`);

    const processedBook = await processor.translateBookV2(
      bookData,
      targetLanguage,
      sourceLanguage,
      1 // Process chapters serially to stay within subrequest limits
    );

    // Update book title with translation
    await env.DB.prepare('UPDATE books_v2 SET title = ? WHERE uuid = ?')
      .bind(processedBook.metadata.title, bookUuid)
      .run();

    // Insert translations chapter by chapter
    for (const chapter of processedBook.chapters) {
      await insertChapterTranslationsV2(
        env.DB,
        bookId,
        chapter.number,
        chapter.translatedTitle,
        chapter.textNodes,
        chapter.translations
      );
    }

    await updateBookStatus(env.DB, bookUuid, 'ready');
    console.log(`✅ Background translation complete for ${bookUuid}`);
  } catch (error) {
    console.error(`❌ Background translation failed for ${bookUuid}:`, error);
    await updateBookStatus(env.DB, bookUuid, 'error');
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
