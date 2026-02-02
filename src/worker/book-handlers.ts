/**
 * Book upload and estimate handlers
 */

import { Env } from './types';
import { getCurrentUser } from './auth';
import { getUserCredits, deductCredits } from './credits';
import { insertProcessedBookV2 } from './db';
import { calculateBookCredits, TOKENS_PER_CREDIT } from '../utils/token-counter';

/**
 * Handle book upload with translation
 */
export async function handleBookUpload(
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

    console.log('📝 Environment configuration:');
    console.log('  API Key present:', !!env.OPENAI_API_KEY);
    console.log('  API Base URL:', env.OPENAI_API_BASE_URL);
    console.log('  API Model:', env.OPENAI_MODEL);

    const { BookProcessor } = await import('../utils/book-processor');
    const processor = new BookProcessor(8, {
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_API_BASE_URL,
      model: env.OPENAI_MODEL,
    });

    // Parse EPUB with V2 XPath-based extraction
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

    const totalCharacters = allTexts.reduce((sum, text) => sum + text.length, 0);
    console.log(`📊 Book stats: ${totalCharacters} chars, ~${requiredCredits * TOKENS_PER_CREDIT} tokens, ${requiredCredits} credits needed, user has ${userCredits}`);

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

    // Translate book using V2 method
    const processedBook = await processor.translateBookV2(
      bookData,
      targetLanguage,
      sourceLanguage,
      2
    );

    const bookUuid = crypto.randomUUID();

    // Insert into V2 database tables
    await insertProcessedBookV2(env.DB, processedBook, bookUuid, user.id);

    // Deduct credits
    await deductCredits(
      env.DB,
      user.id,
      requiredCredits,
      bookUuid,
      `Translation: ${processedBook.metadata.title || 'Book'}`
    );

    console.log(`💳 Deducted ${requiredCredits} credits from user ${user.id}`);

    return new Response(
      JSON.stringify({
        success: true,
        bookUuid,
        creditsUsed: requiredCredits,
        message: 'Book uploaded and processed successfully',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Book upload error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    return new Response(
      JSON.stringify({
        error: 'Failed to process book',
        details: errorMessage,
        stack: errorStack,
      }),
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
    const processor = new BookProcessor(8, {
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
