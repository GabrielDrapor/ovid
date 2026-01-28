/**
 * Context Manager for Translation Pipeline
 * Maintains a sliding window of context for coherent translation
 */

import { Paragraph, ContextItem, TranslationContext } from './types';

export class ContextManager {
  private paragraphs: Paragraph[];
  private translations: Map<string, string>;
  private contextBefore: number;
  private contextAfter: number;

  constructor(
    paragraphs: Paragraph[],
    contextBefore: number = 2,
    contextAfter: number = 2
  ) {
    this.paragraphs = paragraphs;
    this.translations = new Map();
    this.contextBefore = contextBefore;
    this.contextAfter = contextAfter;
  }

  /**
   * Add a translation for a paragraph
   */
  addTranslation(paraId: string, translation: string): void {
    this.translations.set(paraId, translation);
  }

  /**
   * Check if a paragraph has been translated
   */
  hasTranslation(paraId: string): boolean {
    return this.translations.has(paraId);
  }

  /**
   * Get the translation for a paragraph
   */
  getTranslation(paraId: string): string | undefined {
    return this.translations.get(paraId);
  }

  /**
   * Get context for a paragraph at the given index
   */
  getContext(index: number): TranslationContext {
    const before: ContextItem[] = [];
    const after: ContextItem[] = [];

    // Get preceding paragraphs with their translations
    const startBefore = Math.max(0, index - this.contextBefore);
    for (let i = startBefore; i < index; i++) {
      const para = this.paragraphs[i];
      before.push({
        id: para.id,
        original: para.original,
        translated: this.translations.get(para.id),
      });
    }

    // Get following paragraphs (original only)
    const endAfter = Math.min(this.paragraphs.length, index + 1 + this.contextAfter);
    for (let i = index + 1; i < endAfter; i++) {
      const para = this.paragraphs[i];
      after.push({
        id: para.id,
        original: para.original,
      });
    }

    return { before, after };
  }

  /**
   * Format context for inclusion in translation prompt
   * Uses the format from the technical documentation
   */
  formatContextForPrompt(index: number): string {
    const context = this.getContext(index);
    const sections: string[] = [];

    // Format preceding context with translations
    if (context.before.length > 0) {
      sections.push('### 前文 (Previous):');
      for (const item of context.before) {
        sections.push(`[${item.id}] ${item.original}`);
        if (item.translated) {
          sections.push(`-> ${item.translated}`);
        }
      }
      sections.push('');
    }

    // Format following context (original only)
    if (context.after.length > 0) {
      sections.push('### 后文 (Following):');
      for (const item of context.after) {
        sections.push(`[${item.id}] ${item.original}`);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * Load existing translations from a map (for resume from checkpoint)
   */
  loadExistingTranslations(translations: Record<string, string>): void {
    for (const [id, translation] of Object.entries(translations)) {
      this.translations.set(id, translation);
    }
  }

  /**
   * Get all translations as a record
   */
  getTranslationsDict(): Record<string, string> {
    const dict: Record<string, string> = {};
    this.translations.forEach((translation, id) => {
      dict[id] = translation;
    });
    return dict;
  }

  /**
   * Get count of completed translations
   */
  getCompletedCount(): number {
    return this.translations.size;
  }

  /**
   * Get total paragraph count
   */
  getTotalCount(): number {
    return this.paragraphs.length;
  }
}
