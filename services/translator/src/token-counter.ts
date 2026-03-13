/**
 * Token counting for Railway service.
 * Simplified from src/utils/token-counter.ts — uses fallback character-based
 * estimation to avoid js-tiktoken dependency in Railway.
 */

export const TOKENS_PER_CREDIT = 100;

const OUTPUT_MULTIPLIERS: Record<string, number> = {
  zh: 1.5,
  ja: 1.4,
  ko: 1.3,
};
const DEFAULT_OUTPUT_MULTIPLIER = 1.2;

function getOutputMultiplier(targetLanguage: string): number {
  return OUTPUT_MULTIPLIERS[targetLanguage.toLowerCase()] || DEFAULT_OUTPUT_MULTIPLIER;
}

/**
 * Estimate tokens from text length (conservative: ~3 chars per token for mixed content)
 */
function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  return Math.ceil(text.length / 3);
}

/**
 * Calculate required credits for book translation.
 */
export function calculateBookCredits(
  texts: string[],
  targetLanguage: string,
): number {
  let inputTokens = 0;
  for (const text of texts) {
    inputTokens += estimateTokens(text);
  }
  const outputMultiplier = getOutputMultiplier(targetLanguage);
  const outputTokens = Math.ceil(inputTokens * outputMultiplier);
  const totalTokens = inputTokens + outputTokens;
  return Math.ceil(totalTokens / TOKENS_PER_CREDIT);
}
