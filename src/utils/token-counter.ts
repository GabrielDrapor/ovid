/**
 * Token counting utility for accurate credit calculation
 * Uses js-tiktoken for tokenization compatible with Cloudflare Workers
 */

import { Tiktoken, getEncoding, encodingForModel } from 'js-tiktoken';

// 1 credit = 100 tokens
export const TOKENS_PER_CREDIT = 100;

// Output token multipliers by target language
const OUTPUT_MULTIPLIERS: Record<string, number> = {
  zh: 1.5, // Chinese
  ja: 1.4, // Japanese
  ko: 1.3, // Korean
};
const DEFAULT_OUTPUT_MULTIPLIER = 1.2;

// Cached encoder instance
let cachedEncoder: Tiktoken | null = null;
let cachedEncoderModel: string | null = null;

/**
 * Get the tiktoken encoder for the specified model
 * Uses caching to avoid repeated initialization
 */
export function getEncoder(model: string): Tiktoken {
  // Return cached encoder if model matches
  if (cachedEncoder && cachedEncoderModel === model) {
    return cachedEncoder;
  }

  try {
    // Try to get encoding for the specific model
    cachedEncoder = encodingForModel(model as any);
    cachedEncoderModel = model;
    return cachedEncoder;
  } catch {
    // Fallback to o200k_base for gpt-4o series models
    // This is the encoding used by gpt-4o, gpt-4o-mini, etc.
    if (model.includes('gpt-4o') || model.includes('o1')) {
      cachedEncoder = getEncoding('o200k_base');
    } else if (model.includes('gpt-4') || model.includes('gpt-3.5')) {
      // cl100k_base for gpt-4 and gpt-3.5-turbo
      cachedEncoder = getEncoding('cl100k_base');
    } else {
      // Default to o200k_base for newer/unknown models
      cachedEncoder = getEncoding('o200k_base');
    }
    cachedEncoderModel = model;
    return cachedEncoder;
  }
}

/**
 * Count tokens in a text string
 */
export function countTokens(text: string, encoder: Tiktoken): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }
  return encoder.encode(text).length;
}

/**
 * Count tokens for an array of texts
 */
export function countTokensForTexts(texts: string[], encoder: Tiktoken): number {
  let total = 0;
  for (const text of texts) {
    total += countTokens(text, encoder);
  }
  return total;
}

/**
 * Get the output multiplier for a target language
 */
function getOutputMultiplier(targetLanguage: string): number {
  return OUTPUT_MULTIPLIERS[targetLanguage.toLowerCase()] || DEFAULT_OUTPUT_MULTIPLIER;
}

/**
 * Estimate total tokens for translation (input + estimated output)
 * @param texts - Array of source texts to translate
 * @param targetLanguage - Target language code (e.g., 'zh', 'ja', 'en')
 * @param encoder - Tiktoken encoder instance
 * @returns Object with input, output, and total token estimates
 */
export function estimateTranslationTokens(
  texts: string[],
  targetLanguage: string,
  encoder: Tiktoken
): { input: number; output: number; total: number } {
  const inputTokens = countTokensForTexts(texts, encoder);
  const outputMultiplier = getOutputMultiplier(targetLanguage);
  const outputTokens = Math.ceil(inputTokens * outputMultiplier);

  return {
    input: inputTokens,
    output: outputTokens,
    total: inputTokens + outputTokens,
  };
}

/**
 * Calculate credits from total tokens
 * @param totalTokens - Total number of tokens
 * @returns Number of credits (rounded up)
 */
export function calculateCreditsFromTokens(totalTokens: number): number {
  return Math.ceil(totalTokens / TOKENS_PER_CREDIT);
}

/**
 * Fallback token estimation when tiktoken is unavailable
 * Uses conservative character-to-token ratio
 * - English: ~4 chars per token
 * - Chinese: ~2 chars per token
 * - Mixed: ~3 chars per token (conservative)
 */
export function fallbackTokenEstimate(text: string): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }
  const charCount = text.length;
  // Conservative estimate: ~3 chars per token for mixed content
  return Math.ceil(charCount / 3);
}

/**
 * Fallback for estimating translation tokens without tiktoken
 */
export function fallbackEstimateTranslationTokens(
  texts: string[],
  targetLanguage: string
): { input: number; output: number; total: number } {
  let inputTokens = 0;
  for (const text of texts) {
    inputTokens += fallbackTokenEstimate(text);
  }

  const outputMultiplier = getOutputMultiplier(targetLanguage);
  const outputTokens = Math.ceil(inputTokens * outputMultiplier);

  return {
    input: inputTokens,
    output: outputTokens,
    total: inputTokens + outputTokens,
  };
}

/**
 * Calculate required credits for book translation
 * This is the main function to use for credit calculation
 * @param texts - Array of source texts to translate
 * @param targetLanguage - Target language code
 * @param model - LLM model name (for selecting correct encoding)
 * @returns Number of credits required
 */
export function calculateBookCredits(
  texts: string[],
  targetLanguage: string,
  model: string
): number {
  try {
    const encoder = getEncoder(model);
    const tokenEstimate = estimateTranslationTokens(texts, targetLanguage, encoder);
    return calculateCreditsFromTokens(tokenEstimate.total);
  } catch (error) {
    // Fallback to character-based estimation if tiktoken fails
    console.warn('Tiktoken encoding failed, using fallback estimation:', error);
    const tokenEstimate = fallbackEstimateTranslationTokens(texts, targetLanguage);
    return calculateCreditsFromTokens(tokenEstimate.total);
  }
}
