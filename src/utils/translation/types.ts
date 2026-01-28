/**
 * Translation Pipeline Types
 * Based on EPUB Translation Pipeline Technical Documentation
 */

/**
 * Paragraph content type classification
 */
export enum ParagraphType {
  NORMAL = 'normal',
  POEM = 'poem',
  CHAPTER = 'chapter',
  TITLE = 'title',
}

/**
 * A paragraph with its metadata for translation
 */
export interface Paragraph {
  id: string; // e.g., "ch01_p001"
  chapter: number; // Chapter number (0 = preface/intro)
  type: ParagraphType; // Content classification
  original: string; // Source text
  htmlElement?: string; // Original HTML tag (p, div, h1, etc.)
  className?: string; // CSS class for style detection
}

/**
 * Translation result with original and translated text
 */
export interface TranslationResult {
  id: string;
  chapter: number;
  type: ParagraphType;
  original: string;
  translated: string;
  checkpointTime?: string; // ISO timestamp
}

/**
 * Context item for building translation prompts
 */
export interface ContextItem {
  id: string;
  original: string;
  translated?: string; // Only available for preceding paragraphs
}

/**
 * Context window for translation
 */
export interface TranslationContext {
  before: ContextItem[]; // Preceding paragraphs (with translations)
  after: ContextItem[]; // Following paragraphs (original only)
}

/**
 * Flattened glossary structure: English -> Target Language
 */
export type Glossary = Record<string, string>;

/**
 * Configuration for the translation pipeline
 */
export interface TranslationPipelineConfig {
  api: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeout: number;
    maxRetries: number;
    delayBetweenCalls: number;
  };
  translation: {
    sourceLanguage: string;
    targetLanguage: string;
    contextBefore: number;
    contextAfter: number;
  };
  output: {
    checkpointFile: string;
  };
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: TranslationPipelineConfig = {
  api: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    timeout: 60000,
    maxRetries: 3,
    delayBetweenCalls: 500,
  },
  translation: {
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    contextBefore: 2,
    contextAfter: 2,
  },
  output: {
    checkpointFile: 'translation_checkpoint.jsonl',
  },
};

/**
 * Detect paragraph type from HTML element and content
 */
export function detectParagraphType(
  text: string,
  tagName?: string,
  className?: string
): ParagraphType {
  const normalizedTag = (tagName || '').toLowerCase();
  const normalizedClass = (className || '').toLowerCase();

  // Title detection: h1, h2, h3 tags or class contains 'title'
  if (['h1', 'h2', 'h3'].includes(normalizedTag)) {
    return ParagraphType.TITLE;
  }

  if (normalizedClass.includes('title')) {
    return ParagraphType.TITLE;
  }

  // Chapter heading detection
  if (/^(Chapter|CHAPTER|Part|PART)\s+[IVXLCDM\d]+/i.test(text)) {
    return ParagraphType.CHAPTER;
  }

  // Poem/verse detection: CSS classes or formatting patterns
  const poemClasses = ['poem', 'verse', 'stanza', 'poetry', 'calibre_', 'song', 'lyrics'];
  if (poemClasses.some((cls) => normalizedClass.includes(cls))) {
    return ParagraphType.POEM;
  }

  // Detect poetry by line structure (multiple short lines)
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length > 2) {
    const avgLineLength = lines.reduce((sum, l) => sum + l.length, 0) / lines.length;
    if (avgLineLength < 60 && lines.length >= 3) {
      return ParagraphType.POEM;
    }
  }

  return ParagraphType.NORMAL;
}

/**
 * Extract relevant glossary terms that appear in the text
 */
export function extractRelevantTerms(text: string, glossary: Glossary): Glossary {
  const relevant: Glossary = {};
  const lowerText = text.toLowerCase();

  for (const [english, translation] of Object.entries(glossary)) {
    if (lowerText.includes(english.toLowerCase())) {
      relevant[english] = translation;
    }
  }

  return relevant;
}
