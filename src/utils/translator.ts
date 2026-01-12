/**
 * Unified Translation Module for Ovid
 * Provides translation capabilities using OpenAI-compatible APIs
 */

import { LLMClient, Tool } from './LLMClient';

/**
 * Interface for glossary KV store implementations.
 * This allows dependency injection of different storage backends:
 * - SimpleKVStore: In-memory (Worker-compatible, per-request persistence)
 * - KVStore: File-based (local scripts, persistent across runs)
 */
export interface KVStoreInterface {
  get(key: string): string | null;
  set(key: string, value: string): void;
  getAll?(): Record<string, string>;
}

/**
 * Simple in-memory KV store for glossary (Worker-compatible).
 * Data persists only during a single translation session.
 * Suitable for Worker environments or when cross-session persistence isn't needed.
 */
export class SimpleKVStore implements KVStoreInterface {
  private data: Record<string, string> = {};

  get(key: string): string | null {
    return this.data[key] || null;
  }

  set(key: string, value: string): void {
    this.data[key] = value;
  }

  getAll(): Record<string, string> {
    return { ...this.data };
  }
}

export const SUPPORTED_LANGUAGES: Record<string, string> = {
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  en: 'English',
};

export interface TranslatorConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  concurrency?: number;
  /**
   * Optional KV store for glossary persistence.
   * If not provided, uses in-memory SimpleKVStore (Worker-compatible).
   * For local scripts, pass a file-based KVStore instance for persistence.
   */
  kvStore?: KVStoreInterface;
}

export interface TranslateOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  onProgress?: (progress: number, current: number, total: number) => void;
  chapterConcurrency?: number;
  context?: string[]; // Previous paragraphs
}

export interface Chapter {
  title: string;
  items: string[];
}

export interface TranslatedChapter {
  title: string;
  items: string[];
}

export class Translator {
  private config: Omit<Required<TranslatorConfig>, 'kvStore'>;
  private llmClient: LLMClient;
  private kvStore: KVStoreInterface;

  constructor(config: TranslatorConfig = {}) {
    this.config = {
      apiKey: config.apiKey || '',
      baseURL: config.baseURL || 'https://api.openai.com/v1',
      model: config.model || 'gpt-4o-mini',
      temperature: config.temperature ?? 0.3,
      concurrency: config.concurrency ?? 8, // Default: 8 parallel translations
    };

    this.llmClient = new LLMClient({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      model: this.config.model,
      temperature: this.config.temperature,
    });

    // Use provided KV store or default to in-memory store (Worker-compatible)
    this.kvStore = config.kvStore ?? new SimpleKVStore();

    if (this.config.apiKey) {
      console.log(
        `🔧 Translator configured with base URL: ${this.config.baseURL}`
      );
      console.log(`🤖 Using model: ${this.config.model}`);
    } else {
      console.warn(
        '⚠️  No OpenAI API key configured. Translations will use mock mode.'
      );
    }
  }

  /**
   * Find glossary entries that are relevant to the given text.
   * Searches for glossary keys that appear in the text (case-insensitive).
   */
  private getRelevantGlossary(text: string): Record<string, string> {
    if (!this.kvStore.getAll) {
      return {};
    }

    const allEntries = this.kvStore.getAll();
    const relevant: Record<string, string> = {};
    const textLower = text.toLowerCase();

    for (const [key, value] of Object.entries(allEntries)) {
      // Check if the key appears in the text (case-insensitive word boundary match)
      const keyLower = key.toLowerCase();
      // Use word boundary detection for better matching
      const regex = new RegExp(`\\b${keyLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(text) || textLower.includes(keyLower)) {
        relevant[key] = value;
      }
    }

    return relevant;
  }

  /**
   * Format glossary entries for inclusion in prompt
   */
  private formatGlossaryForPrompt(glossary: Record<string, string>): string {
    const entries = Object.entries(glossary);
    if (entries.length === 0) {
      return '';
    }

    const formatted = entries
      .map(([key, value]) => `  "${key}" → "${value}"`)
      .join('\n');

    return `\nGlossary (MUST use these exact translations for consistency):\n${formatted}\n`;
  }

  /**
   * Translate a single text
   */
  async translateText(
    text: string,
    options: TranslateOptions = {}
  ): Promise<string> {
    const { sourceLanguage = 'English', targetLanguage = 'Chinese' } = options;

    // If no API configured, return mock translation
    if (!this.config.apiKey) {
      return `[${targetLanguage}: ${text.substring(0, 50)}...]`;
    }

    try {
      const targetLang = SUPPORTED_LANGUAGES[targetLanguage] || targetLanguage;

      // Prepare context string
      const contextStr =
        options.context && options.context.length > 0
          ? `\nContext (Preceding text):\n${options.context.join('\n')}\n`
          : '';

      // Get relevant glossary entries for this text
      const relevantGlossary = this.getRelevantGlossary(text);
      const glossaryStr = this.formatGlossaryForPrompt(relevantGlossary);

      const translation = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: `You are a professional literary translator. Translate the following ${sourceLanguage} text to ${targetLang}.
Rules:
1. Translate EXACTLY what is provided. Do not add summaries, explanations, or continuations.
2. Maintain the original style, tone, and formatting.
3. If the input is a title or short phrase, translate it as such.
4. Return ONLY the translation. Do NOT wrap the translation in quotes unless the source text has them.
5. For proper nouns (names, places, terms):
   - If a translation is provided in the Glossary below, you MUST use it exactly.
   - For NEW proper nouns not in the glossary, use 'kv_write' to save your translation for consistency.
   - Use 'kv_read' only if you need to check a term that might be in the glossary but wasn't auto-detected.${glossaryStr}`,
          },
          {
            role: 'user',
            content: `Task: Translate the following text to ${targetLang}. Return ONLY the translation.\n${contextStr}\nText: ${text}`,
          },
        ],
        max_tokens: 8192,
        tools: [
          {
            type: 'function',
            function: {
              name: 'kv_read',
              description:
                'Read a translation for a proper noun (name, place, specific term) from the glossary. Use this to check if a term has an established translation.',
              parameters: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description: 'The proper noun in source language',
                  },
                },
                required: ['key'],
              },
            },
            implementation: (args: { key: string }) => {
              const val = this.kvStore.get(args.key);
              return val ? `Found: ${val}` : 'Not found';
            },
          },
          {
            type: 'function',
            function: {
              name: 'kv_write',
              description:
                'IMPORTANT: Save a translation for a NEW proper noun to the glossary. Call this for any character name, place name, or specific term you translate that is not already in the glossary. This ensures consistency across the entire book.',
              parameters: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description: 'The proper noun or name in source language (e.g., "Boxer", "Manor Farm")',
                  },
                  value: {
                    type: 'string',
                    description: 'The translation in target language',
                  },
                },
                required: ['key', 'value'],
              },
            },
            implementation: (args: { key: string; value: string }) => {
              this.kvStore.set(args.key, args.value);
              return 'Saved';
            },
          },
        ],
      });

      return translation;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.warn(
        `⚠️  Translation failed for text "${text.substring(0, 50)}...": ${errorMessage}`
      );
      throw error;
    }
  }

  /**
   * Translate multiple texts with controlled concurrency
   */
  async translateBatch(
    texts: string[],
    options: TranslateOptions = {}
  ): Promise<string[]> {
    if (texts.length === 0) {
      return [];
    }

    const results: string[] = new Array(texts.length);
    let completed = 0;

    // Limited-parallel processing
    const concurrency = this.config.concurrency;
    let index = 0;

    const workers = Array.from(
      { length: Math.min(concurrency, texts.length) },
      async () => {
        while (true) {
          const currentIndex = index++;
          if (currentIndex >= texts.length) break;

          // Prepare context (last 2 texts)
          // Note: In parallel execution, we can only guarantee context from the original source array
          // We can't use translated output as context because it might not be ready.
          const contextStart = Math.max(0, currentIndex - 2);
          const context = texts.slice(contextStart, currentIndex);

          try {
            results[currentIndex] = await this.translateText(
              texts[currentIndex],
              { ...options, context }
            );
          } catch (error) {
            // On error, use fallback
            results[currentIndex] =
              `[Translation failed: ${texts[currentIndex].substring(0, 30)}...]`;
          }

          completed++;

          // Report progress
          if (options.onProgress) {
            const progress = Math.round((completed / texts.length) * 100);
            options.onProgress(progress, completed, texts.length);
          }

          // Optional: add small delay to avoid rate limits
          if (currentIndex < texts.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
    );

    await Promise.all(workers);
    return results;
  }

  /**
   * Translate texts with chapter-level grouping
   * Useful for maintaining context within chapters
   */
  async translateChapters(
    chapters: Chapter[],
    options: TranslateOptions = {}
  ): Promise<TranslatedChapter[]> {
    const chapterConcurrency = options.chapterConcurrency ?? 2; // Default: 2 chapters at a time
    const results: TranslatedChapter[] = new Array(chapters.length);

    let chapterIndex = 0;
    let totalItems = chapters.reduce((sum, ch) => sum + ch.items.length + 1, 0); // +1 for title
    let completedItems = 0;

    const chapterWorkers = Array.from(
      { length: Math.min(chapterConcurrency, chapters.length) },
      async () => {
        while (true) {
          const currentChapterIndex = chapterIndex++;
          if (currentChapterIndex >= chapters.length) break;

          const chapter = chapters[currentChapterIndex];

          // Translate chapter title
          const translatedTitle = await this.translateText(
            chapter.title,
            options
          );
          completedItems++;

          if (options.onProgress) {
            const progress = Math.round((completedItems / totalItems) * 100);
            options.onProgress(progress, completedItems, totalItems);
          }

          // Translate chapter items
          const translatedItems = await this.translateBatch(chapter.items, {
            ...options,
            onProgress: (_, current, total) => {
              completedItems++;
              if (options.onProgress) {
                const progress = Math.round(
                  (completedItems / totalItems) * 100
                );
                options.onProgress(progress, completedItems, totalItems);
              }
            },
          });

          results[currentChapterIndex] = {
            title: translatedTitle,
            items: translatedItems,
          };
        }
      }
    );

    await Promise.all(chapterWorkers);
    return results;
  }

  /**
   * Check if translator is properly configured
   */
  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  /**
   * Get current configuration (with masked API key)
   */
  getConfig(): Omit<TranslatorConfig, 'apiKey'> & { apiKey?: string } {
    return {
      ...this.config,
      apiKey: this.config.apiKey ? '***' : undefined,
    };
  }
}
