/**
 * Prompt Templates for Translation Pipeline
 * Optimized prompts based on EPUB Translation Pipeline Technical Documentation
 */

import { Paragraph, ParagraphType, Glossary } from './types';
import { SUPPORTED_LANGUAGES } from '../translator';

/**
 * System prompt for literary translation
 */
export function getSystemPrompt(targetLanguage: string): string {
  const targetLang = SUPPORTED_LANGUAGES[targetLanguage] || targetLanguage;

  return `You are a professional literary translator specializing in English to ${targetLang} translation. Your task is to translate English literary works into fluent, elegant ${targetLang}.

Translation Principles:
1. [MOST IMPORTANT] Proper nouns (names, places) in the glossary MUST be translated exactly as provided. Do NOT use alternative translations.
2. Maintain the literary style and tone of the original text.
3. Reference the context to ensure coherent translation.
4. For poetry passages, preserve rhythm and flow.
5. Translation should be natural and follow ${targetLang} expression conventions.
6. Do NOT add any explanations or annotations. Output ONLY the translation.

Output ONLY the translation result, without any other content.`;
}

/**
 * Build user prompt for translation with glossary and context
 */
export function buildTranslationPrompt(
  paragraph: Paragraph,
  glossary: Glossary,
  context: string,
  targetLanguage: string
): string {
  const sections: string[] = [];
  const targetLang = SUPPORTED_LANGUAGES[targetLanguage] || targetLanguage;

  // 1. Glossary section (if terms exist)
  const glossaryEntries = Object.entries(glossary).sort();
  if (glossaryEntries.length > 0) {
    sections.push('## Glossary [MUST STRICTLY FOLLOW]');
    sections.push(
      'The following proper nouns MUST be translated exactly as shown. Do NOT use any other translation:'
    );
    sections.push('');
    for (const [english, translation] of glossaryEntries) {
      sections.push(`- ${english} -> ${translation}`);
    }
    sections.push('');
  }

  // 2. Context section
  if (context.trim()) {
    sections.push('## Context Reference');
    sections.push(context);
    sections.push('');
  }

  // 3. Type-specific hints
  switch (paragraph.type) {
    case ParagraphType.POEM:
      sections.push('## Note: The following is poetry/lyrics. Please preserve rhythm and flow.');
      sections.push('');
      break;
    case ParagraphType.CHAPTER:
      sections.push('## Note: The following is a chapter heading.');
      sections.push('');
      break;
    case ParagraphType.TITLE:
      sections.push('## Note: The following is a title. Keep it concise.');
      sections.push('');
      break;
    default:
      // Normal paragraph, no special hint needed
      break;
  }

  // 4. The paragraph to translate
  sections.push(`## Please translate the following to ${targetLang}:`);
  sections.push(paragraph.original);

  return sections.join('\n');
}

/**
 * Build a simple prompt for batch translation (no context/glossary)
 * Used for Worker environment where speed is prioritized
 */
export function buildSimplePrompt(text: string, targetLanguage: string): string {
  const targetLang = SUPPORTED_LANGUAGES[targetLanguage] || targetLanguage;
  return `Translate the following to ${targetLang}. Output ONLY the translation:\n\n${text}`;
}

/**
 * Get simple system prompt for batch translation
 */
export function getSimpleSystemPrompt(
  sourceLanguage: string,
  targetLanguage: string
): string {
  const sourceLang = SUPPORTED_LANGUAGES[sourceLanguage] || sourceLanguage;
  const targetLang = SUPPORTED_LANGUAGES[targetLanguage] || targetLanguage;

  return `You are a professional literary translator. Translate ${sourceLang} text to ${targetLang}.
Rules:
1. Translate EXACTLY what is provided. Do not add summaries, explanations, or continuations.
2. Maintain the original style, tone, and formatting.
3. If the input is a title or short phrase, translate it as such.
4. Return ONLY the translation. Do NOT wrap the translation in quotes unless the source text has them.`;
}
