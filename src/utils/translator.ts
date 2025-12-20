/**
 * Unified Translation Module for Ovid
 * Provides translation capabilities using OpenAI-compatible APIs
 */

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
}

export interface TranslateOptions {
  sourceLanguage?: string;
  targetLanguage?: string;
  onProgress?: (progress: number, current: number, total: number) => void;
  chapterConcurrency?: number;
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
  private config: Required<TranslatorConfig>;

  constructor(config: TranslatorConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.OPENAI_API_KEY || '',
      baseURL:
        config.baseURL ||
        process.env.OPENAI_API_BASE_URL ||
        'https://api.openai.com/v1',
      model: config.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: config.temperature ?? 0.3,
      concurrency: config.concurrency ?? 8, // Default: 8 parallel translations
    };

    if (this.config.apiKey) {
      console.log(`🔧 Translator configured with base URL: ${this.config.baseURL}`);
      console.log(`🤖 Using model: ${this.config.model}`);
    } else {
      console.warn(
        '⚠️  No OpenAI API key configured. Translations will use mock mode.'
      );
    }
  }

  /**
   * Translate a single text
   */
  async translateText(
    text: string,
    options: TranslateOptions = {}
  ): Promise<string> {
    const {
      sourceLanguage = 'English',
      targetLanguage = 'Chinese',
    } = options;

    // If no API configured, return mock translation
    if (!this.config.apiKey) {
      return `[${targetLanguage}: ${text.substring(0, 50)}...]`;
    }

    try {
      const targetLang = SUPPORTED_LANGUAGES[targetLanguage] || targetLanguage;
      const url = `${this.config.baseURL}/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              content: `You are a professional literary translator. Translate the following ${sourceLanguage} text to ${targetLang}.
Rules:
1. Translate EXACTLY what is provided. Do not add summaries, explanations, or continuations.
2. Maintain the original style, tone, and formatting.
3. If the input is a title or short phrase, translate it as such.
4. Return ONLY the translation.`,
            },
            {
              role: 'user',
              content: `Task: Translate the following text to ${targetLang}. Return ONLY the translation.\n\nText: "${text}"`,
            },
          ],
          temperature: this.config.temperature,
          max_tokens: Math.max(text.length * 2, 1000),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as any;
      const translation = data.choices[0]?.message?.content?.trim();

      if (!translation) {
        throw new Error('Empty response from translation API');
      }

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

          try {
            results[currentIndex] = await this.translateText(
              texts[currentIndex],
              options
            );
          } catch (error) {
            // On error, use fallback
            results[currentIndex] = `[Translation failed: ${texts[currentIndex].substring(0, 30)}...]`;
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
    let totalItems =
      chapters.reduce((sum, ch) => sum + ch.items.length + 1, 0); // +1 for title
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
