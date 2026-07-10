/**
 * Shared LLM chat client and model-tier resolution.
 *
 * Tiering adapted from wenyi (https://github.com/BigDawnGhost/wenyi, MIT),
 * config.yaml `llm.tiers`: strong for translation/analysis, cheap for
 * review/QA judgments, fast for mechanical tasks (digests, glossary
 * extraction). Missing tiers fall back fast → cheap → strong so a
 * single-model setup keeps working unchanged.
 */

export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Optional cheaper model for review/QA tasks (falls back to `model`) */
  cheapModel?: string;
  /** Optional cheapest model for mechanical tasks (falls back to cheapModel, then `model`) */
  fastModel?: string;
}

export type LLMTier = 'strong' | 'cheap' | 'fast';

/** Resolve a tier to a concrete config (same endpoint, tier-appropriate model). */
export function tierConfig(config: LLMConfig, tier: LLMTier): LLMConfig {
  const model =
    tier === 'fast'
      ? config.fastModel || config.cheapModel || config.model
      : tier === 'cheap'
        ? config.cheapModel || config.model
        : config.model;
  return { ...config, model };
}

/**
 * Simple LLM chat call against an OpenAI-compatible endpoint,
 * with exponential-backoff retries.
 */
export async function llmChat(
  config: LLMConfig,
  messages: Array<{ role: string; content: string }>,
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      const res = await fetch(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
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

      const json = (await res.json()) as any;
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty LLM response');
      return content;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`LLM retry ${attempt + 1}: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

/**
 * Parse a JSON payload from an LLM response, tolerating markdown code fences
 * and leading/trailing prose around the JSON body.
 */
export function parseJsonResponse<T>(raw: string): T {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s
      .replace(/```json?\n?/g, '')
      .replace(/```$/g, '')
      .trim();
  }
  try {
    return JSON.parse(s) as T;
  } catch {
    // Fall back to the outermost {...} or [...] span
    const first = s.search(/[[{]/);
    if (first >= 0) {
      const open = s[first];
      const close = open === '{' ? '}' : ']';
      const last = s.lastIndexOf(close);
      if (last > first) {
        return JSON.parse(s.slice(first, last + 1)) as T;
      }
    }
    throw new Error('Unparseable JSON in LLM response');
  }
}

/** Rough token estimate: ~4 chars per token for English, ~2 for CJK */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-鿿가-힯]/g)?.length ?? 0;
  return Math.ceil(cjk / 2 + (text.length - cjk) / 4);
}

/** Language code to display name mapping */
export const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}
