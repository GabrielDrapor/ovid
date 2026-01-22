/**
 * Unified Translation Module for Ovid
 *
 * Two-Phase Translation Architecture:
 * 1. Pre-scan phase: Extract all proper nouns from the entire book and build a unified glossary
 * 2. Translation phase: Translate paragraphs using the pre-built glossary
 * 3. Post-processing: Enforce consistency by replacing any remaining variants
 */

import { LLMClient } from './LLMClient';

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
  context?: string[]; // Previous paragraphs (translated)
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
  /**
   * Maps source terms to known translation variants.
   * Used to detect and replace inconsistent translations.
   */
  private translationVariants: Map<string, Set<string>> = new Map();

  constructor(config: TranslatorConfig = {}) {
    this.config = {
      apiKey: config.apiKey || '',
      baseURL: config.baseURL || 'https://api.openai.com/v1',
      model: config.model || 'gpt-4o-mini',
      temperature: config.temperature ?? 0.3,
      concurrency: config.concurrency ?? 1, // Sequential translation for consistency
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
   * Phase 1: Extract all proper nouns from text and build unified glossary.
   * This is called once per book before translation begins.
   */
  async extractProperNouns(
    allText: string[],
    options: TranslateOptions = {}
  ): Promise<Record<string, string>> {
    const { sourceLanguage = 'English', targetLanguage = 'Chinese' } = options;
    const targetLang = SUPPORTED_LANGUAGES[targetLanguage] || targetLanguage;

    // If no API configured, return empty glossary
    if (!this.config.apiKey) {
      return {};
    }

    // Combine all text, but limit to avoid token limits
    // Sample strategically: first chapter, middle, and end for variety
    const sampleTexts: string[] = [];
    const totalItems = allText.length;

    // Take first 100 items (usually covers most character introductions)
    sampleTexts.push(...allText.slice(0, Math.min(100, totalItems)));

    // Take some from middle
    if (totalItems > 200) {
      const midStart = Math.floor(totalItems / 2) - 25;
      sampleTexts.push(...allText.slice(midStart, midStart + 50));
    }

    // Take some from end
    if (totalItems > 150) {
      sampleTexts.push(...allText.slice(-50));
    }

    const combinedText = sampleTexts.join('\n\n');

    console.log('📝 Phase 1: Extracting proper nouns from book...');
    console.log(`   Analyzing ${sampleTexts.length} text segments...`);

    try {
      const response = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: `You are a professional literary translator specializing in proper noun extraction.

Your task is to identify ALL proper nouns (names, places, organizations, specific terms) in the given ${sourceLanguage} text and provide consistent ${targetLang} translations for each.

CRITICAL RULES:
1. Extract EVERY proper noun - character names, place names, organization names, special terms
2. For each proper noun, provide ONE canonical translation that will be used throughout the book
3. Include variations (e.g., "Mr. Whymper" and "Whymper" should both map to the same base translation)
4. For names, choose a natural-sounding transliteration that is consistent
5. Return a JSON object with proper nouns as keys and translations as values

Example output format:
{
  "Whymper": "温珀",
  "Mr. Whymper": "温珀先生",
  "Napoleon": "拿破仑",
  "Snowball": "雪球",
  "Animal Farm": "动物庄园",
  "Manor Farm": "曼诺庄园"
}

IMPORTANT: The translations must be CONSISTENT. If "Whymper" is "温珀", then "Mr. Whymper" must be "温珀先生", not "温普尔先生".`,
          },
          {
            role: 'user',
            content: `Extract all proper nouns from the following ${sourceLanguage} text and provide consistent ${targetLang} translations. Return ONLY a valid JSON object.\n\nText:\n${combinedText}`,
          },
        ],
        max_tokens: 8192,
        temperature: 0.1, // Low temperature for consistency
      });

      // Parse the JSON response
      try {
        // Extract JSON from the response (handle markdown code blocks)
        let jsonStr = response.trim();
        if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '');
        }

        const extractedNouns = JSON.parse(jsonStr) as Record<string, string>;
        console.log(
          `   ✅ Extracted ${Object.keys(extractedNouns).length} proper nouns`
        );

        // Merge with existing glossary (existing entries take precedence)
        const existingGlossary = this.kvStore.getAll?.() || {};
        const mergedGlossary = { ...extractedNouns };

        // Existing glossary entries override extracted ones
        for (const [key, value] of Object.entries(existingGlossary)) {
          mergedGlossary[key] = value;
        }

        // Save all entries to KV store
        for (const [key, value] of Object.entries(mergedGlossary)) {
          this.kvStore.set(key, value);
        }

        // Build variant detection map
        this.buildVariantMap(mergedGlossary);

        return mergedGlossary;
      } catch (parseError) {
        console.warn('⚠️  Failed to parse proper noun extraction response');
        console.warn('   Response was:', response.substring(0, 500));
        return this.kvStore.getAll?.() || {};
      }
    } catch (error) {
      console.warn('⚠️  Proper noun extraction failed, using existing glossary');
      return this.kvStore.getAll?.() || {};
    }
  }

  /**
   * Build a map of translation variants for consistency enforcement.
   * Groups all terms that should have the same base translation.
   */
  private buildVariantMap(glossary: Record<string, string>): void {
    // Group entries by their base translation
    const translationGroups: Record<string, string[]> = {};

    for (const [source, translation] of Object.entries(glossary)) {
      // Normalize the translation (remove honorifics for grouping)
      const baseTranslation = translation
        .replace(/先生|夫人|小姐|博士|教授|上校|少校/g, '')
        .trim();

      if (!translationGroups[baseTranslation]) {
        translationGroups[baseTranslation] = [];
      }
      translationGroups[baseTranslation].push(source);
    }

    // For each group, register all possible variants
    for (const sources of Object.values(translationGroups)) {
      if (sources.length > 1) {
        // These terms should have related translations
        for (const source of sources) {
          this.translationVariants.set(source, new Set());
        }
      }
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
      const keyLower = key.toLowerCase();
      // Use word boundary detection for better matching
      const regex = new RegExp(
        `\\b${keyLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i'
      );
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

    // Sort by length (longer first) to handle "Mr. Whymper" before "Whymper"
    entries.sort((a, b) => b[0].length - a[0].length);

    const formatted = entries
      .map(([key, value]) => `  "${key}" → "${value}"`)
      .join('\n');

    return `\n\n**GLOSSARY (MUST use these exact translations):**\n${formatted}\n`;
  }

  /**
   * Post-process translation to enforce glossary consistency.
   * Replaces any variant translations with the canonical glossary value.
   */
  private enforceGlossaryConsistency(
    translation: string,
    originalText: string
  ): string {
    const glossary = this.kvStore.getAll?.() || {};
    let result = translation;

    // Build a map of what proper nouns appear in the original text
    const presentNouns: Array<{ source: string; translation: string }> = [];

    for (const [source, canonicalTranslation] of Object.entries(glossary)) {
      const sourceRegex = new RegExp(
        `\\b${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i'
      );
      if (sourceRegex.test(originalText)) {
        presentNouns.push({ source, translation: canonicalTranslation });
      }
    }

    // Sort by translation length (longer first) to avoid partial replacements
    presentNouns.sort((a, b) => b.translation.length - a.translation.length);

    // For each proper noun that should be in the translation,
    // check if a variant was used and replace it
    for (const { source, translation: canonical } of presentNouns) {
      // Check if the canonical translation is already there
      if (result.includes(canonical)) {
        continue;
      }

      // Look for common variant patterns
      const variants = this.generatePossibleVariants(source, canonical);
      for (const variant of variants) {
        if (variant !== canonical && result.includes(variant)) {
          console.log(`      🔄 Fixing: "${variant}" → "${canonical}"`);
          result = result.split(variant).join(canonical);
          // Register this variant for future reference
          this.registerVariant(source, variant);
        }
      }
    }

    return result;
  }

  /**
   * Generate possible variant translations for a proper noun.
   * This helps catch common transliteration differences.
   */
  private generatePossibleVariants(
    source: string,
    canonical: string
  ): string[] {
    const variants: string[] = [canonical];

    // For Chinese transliterations, generate phonetic variants
    // Common variant patterns for names ending in consonants
    const variantPatterns: Array<[RegExp, string[]]> = [
      // -er endings
      [/珀$/, ['普尔', '伯', '珀尔']],
      [/普尔$/, ['珀', '伯', '珀尔']],
      [/伯$/, ['珀', '普尔', '伯尔']],
      // -all/-ell endings
      [/尔$/, ['尔勒', '尔斯']],
      // -son/-sen endings
      [/森$/, ['逊', '孙']],
      [/逊$/, ['森', '孙']],
      // -ton/-den endings
      [/顿$/, ['登', '敦']],
      [/登$/, ['顿', '敦']],
      // Common first syllable variants
      [/^温/, ['温', '文', '韦']],
      [/^斯/, ['斯', '史']],
    ];

    for (const [pattern, replacements] of variantPatterns) {
      if (pattern.test(canonical)) {
        for (const replacement of replacements) {
          const variant = canonical.replace(pattern, replacement);
          if (variant !== canonical) {
            variants.push(variant);
          }
        }
      }
    }

    // Also check registered variants
    const registered = this.translationVariants.get(source);
    if (registered) {
      variants.push(...Array.from(registered));
    }

    // Deduplicate using a simple filter
    const seen = new Set<string>();
    return variants.filter((v) => {
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });
  }

  /**
   * Register a translation variant for future enforcement.
   */
  public registerVariant(sourceKey: string, variant: string): void {
    let variants = this.translationVariants.get(sourceKey);
    if (!variants) {
      variants = new Set();
      this.translationVariants.set(sourceKey, variants);
    }
    variants.add(variant);
  }

  /**
   * Pre-register common translation variants for proper nouns.
   */
  public registerCommonVariants(variantsMap: Record<string, string[]>): void {
    for (const [key, variants] of Object.entries(variantsMap)) {
      for (const variant of variants) {
        this.registerVariant(key, variant);
      }
    }
  }

  /**
   * Translate a single text segment.
   * Uses the pre-built glossary for consistency.
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

      // Get relevant glossary entries for this text
      const relevantGlossary = this.getRelevantGlossary(text);
      const glossaryStr = this.formatGlossaryForPrompt(relevantGlossary);

      // Prepare context from previous translations
      const contextStr =
        options.context && options.context.length > 0
          ? `\n**Context (Previous translated paragraphs):**\n${options.context.join('\n')}\n`
          : '';

      const translation = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: `You are a professional literary translator. Translate the following ${sourceLanguage} text to ${targetLang}.

**CRITICAL RULES:**
1. Return ONLY the translation, nothing else.
2. Do NOT wrap the translation in quotes unless the source text has them.
3. Maintain the original style, tone, and formatting.
4. For proper nouns (names, places, terms), you MUST use the exact translations from the Glossary below.
5. Do NOT invent new translations for names that are in the glossary.${glossaryStr}`,
          },
          {
            role: 'user',
            content: `Translate to ${targetLang}:${contextStr}\n${text}`,
          },
        ],
        max_tokens: 8192,
        temperature: 0.3,
      });

      // Post-process: enforce glossary consistency
      const enforced = this.enforceGlossaryConsistency(translation, text);
      return enforced;
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
   * Translate multiple texts with controlled concurrency.
   * Uses sequential processing for the first batch to establish patterns,
   * then parallel processing for the rest.
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

    // For small batches or the first few items, process sequentially
    // to build up translated context
    const sequentialCount = Math.min(3, texts.length);

    // Process first few items sequentially to build context
    const translatedContext: string[] = [];
    for (let i = 0; i < sequentialCount; i++) {
      try {
        results[i] = await this.translateText(texts[i], {
          ...options,
          context: translatedContext.slice(-2), // Last 2 translations as context
        });
        translatedContext.push(results[i]);
      } catch (error) {
        results[i] = `[Translation failed: ${texts[i].substring(0, 30)}...]`;
      }

      completed++;
      if (options.onProgress) {
        const progress = Math.round((completed / texts.length) * 100);
        options.onProgress(progress, completed, texts.length);
      }
    }

    // Process remaining items in parallel batches
    if (texts.length > sequentialCount) {
      const concurrency = this.config.concurrency;
      let index = sequentialCount;

      const workers = Array.from(
        { length: Math.min(concurrency, texts.length - sequentialCount) },
        async () => {
          while (true) {
            const currentIndex = index++;
            if (currentIndex >= texts.length) break;

            // Use the original text context (previous 2 source texts)
            // since we can't guarantee translated context order in parallel
            const contextStart = Math.max(0, currentIndex - 2);
            const sourceContext = texts.slice(contextStart, currentIndex);

            try {
              results[currentIndex] = await this.translateText(
                texts[currentIndex],
                { ...options, context: sourceContext }
              );
            } catch (error) {
              results[currentIndex] = `[Translation failed: ${texts[currentIndex].substring(0, 30)}...]`;
            }

            completed++;

            if (options.onProgress) {
              const progress = Math.round((completed / texts.length) * 100);
              options.onProgress(progress, completed, texts.length);
            }

            // Small delay to avoid rate limits
            if (currentIndex < texts.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        }
      );

      await Promise.all(workers);
    }

    return results;
  }

  /**
   * Translate texts with chapter-level grouping.
   * Phase 1: Extract proper nouns from all text
   * Phase 2: Translate with pre-built glossary
   * Phase 3: Post-process for consistency
   */
  async translateChapters(
    chapters: Chapter[],
    options: TranslateOptions = {}
  ): Promise<TranslatedChapter[]> {
    // Phase 1: Extract proper nouns from all text
    const allTexts: string[] = [];
    for (const chapter of chapters) {
      allTexts.push(chapter.title);
      allTexts.push(...chapter.items);
    }

    await this.extractProperNouns(allTexts, options);
    console.log('');

    // Phase 2: Translate chapters
    console.log('📖 Phase 2: Translating chapters...');
    const chapterConcurrency = options.chapterConcurrency ?? 1; // Sequential for consistency
    const results: TranslatedChapter[] = new Array(chapters.length);

    let totalItems = chapters.reduce((sum, ch) => sum + ch.items.length + 1, 0);
    let completedItems = 0;

    let chapterIndex = 0;

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

    // Phase 3: Post-process all translations for final consistency check
    console.log('');
    console.log('🔍 Phase 3: Final consistency check...');
    let fixCount = 0;

    for (let i = 0; i < results.length; i++) {
      const chapter = chapters[i];
      const result = results[i];

      // Re-apply consistency enforcement
      result.title = this.enforceGlossaryConsistency(
        result.title,
        chapter.title
      );

      for (let j = 0; j < result.items.length; j++) {
        const original = result.items[j];
        const fixed = this.enforceGlossaryConsistency(
          original,
          chapter.items[j]
        );
        if (fixed !== original) {
          fixCount++;
        }
        result.items[j] = fixed;
      }
    }

    if (fixCount > 0) {
      console.log(`   ✅ Fixed ${fixCount} consistency issues`);
    } else {
      console.log('   ✅ No consistency issues found');
    }

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

  /**
   * Get the current glossary for inspection
   */
  getGlossary(): Record<string, string> {
    return this.kvStore.getAll?.() || {};
  }
}
