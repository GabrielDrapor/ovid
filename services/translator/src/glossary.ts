/**
 * Glossary building and maintenance.
 *
 * The one-shot pre-scan extraction (extractGlossary) is ovid's original
 * approach. Incremental per-chapter extraction (extractIncrementalGlossary)
 * is adapted from wenyi (https://github.com/BigDawnGhost/wenyi, MIT),
 * trans_novel/glossary/extractor.py: after each chapter is translated, new
 * proper nouns are extracted from the actual source/translation pairs and
 * merged into the glossary, so characters who first appear mid-book get a
 * consistent rendering from their next occurrence on. On conflicts the
 * existing entry wins (first rendering becomes canonical).
 */

import {
  LLMConfig,
  llmChat,
  languageName,
  parseJsonResponse,
} from './llm-client.js';
import { glossaryExtractorSystem, glossaryExtractorUser } from './prompts.js';

/**
 * Try to parse a JSON object string, repairing truncated output by trimming
 * back to the last complete `"key": "value"` entry and re-closing the brace.
 */
export function parseGlossaryJson(raw: string): Record<string, string> {
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr
      .replace(/```json?\n?/g, '')
      .replace(/```$/g, '')
      .trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Repair truncated JSON: trim back to the last `",` (complete entry boundary)
    // and close the object. Handles truncation mid-key or mid-value.
    const lastComma = jsonStr.lastIndexOf('",');
    if (lastComma > 0) {
      const repaired = jsonStr.slice(0, lastComma + 1) + '}';
      try {
        return JSON.parse(repaired);
      } catch {
        /* fall through */
      }
    }
    throw new Error('Unrepairable glossary JSON');
  }
}

/**
 * Extract proper nouns glossary from book text (one-shot pre-scan over
 * head/middle/tail samples).
 */
export async function extractGlossary(
  config: LLMConfig,
  allTexts: string[],
  sourceLanguage: string,
  targetLanguage: string
): Promise<Record<string, string>> {
  const targetLang = languageName(targetLanguage);
  const total = allTexts.length;

  // Two attempts with progressively smaller samples to keep output within token budget
  const sampleSizes: Array<[number, number, number]> = [
    [100, 50, 50],
    [50, 25, 25],
  ];

  for (let attempt = 0; attempt < sampleSizes.length; attempt++) {
    const [head, mid, tail] = sampleSizes[attempt];
    const samples: string[] = [];
    samples.push(...allTexts.slice(0, Math.min(head, total)));
    if (total > head * 2) {
      const midStart = Math.floor(total / 2) - Math.floor(mid / 2);
      samples.push(...allTexts.slice(midStart, midStart + mid));
    }
    if (total > head + tail) {
      samples.push(...allTexts.slice(-tail));
    }
    const combinedText = samples.join('\n\n');

    try {
      const response = await llmChat(
        config,
        [
          {
            role: 'system',
            content: `You are a professional literary translator specializing in proper noun extraction.
Extract ALL proper nouns (people, places, organizations, brands, acronyms) from the given ${sourceLanguage} text and provide consistent ${targetLang} translations.
For acronyms with no standard ${targetLang} translation, keep them as-is in the value (e.g. {"NBA": "NBA"}).
Return ONLY a valid JSON object. Be concise — short values, no commentary. Example: {"Whymper": "温珀", "NBA": "NBA"}`,
          },
          {
            role: 'user',
            content: `Extract all proper nouns and provide ${targetLang} translations. Return ONLY valid JSON.\n\nText:\n${combinedText}`,
          },
        ],
        { temperature: 0.1, maxTokens: 16384 }
      );

      const parsed = parseGlossaryJson(response);
      const count = Object.keys(parsed).length;
      console.log(
        `[glossary] Extracted ${count} terms (attempt ${attempt + 1}, sample size ${samples.length})`
      );
      return parsed;
    } catch (err) {
      console.warn(
        `[glossary] Attempt ${attempt + 1} failed:`,
        (err as Error).message
      );
    }
  }

  throw new Error(
    'All glossary extraction attempts failed (empty LLM response)'
  );
}

/** Build glossary string for relevant terms found in text */
export function buildGlossaryStr(
  text: string,
  glossary: Record<string, string>
): string {
  const relevant: Record<string, string> = {};
  const textLower = text.toLowerCase();
  for (const [key, value] of Object.entries(glossary)) {
    if (textLower.includes(key.toLowerCase())) {
      relevant[key] = value;
    }
  }
  if (Object.keys(relevant).length === 0) return '';
  const entries = Object.entries(relevant)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k, v]) => `  "${k}" → "${v}"`)
    .join('\n');
  return `\n\n**GLOSSARY (MUST use these exact translations):**\n${entries}\n`;
}

/** Cap on how much chapter text is sent per incremental extraction call */
const INCREMENTAL_INPUT_CHAR_CAP = 9000;

/** Sanity limits for extracted glossary entries */
const MAX_TERM_LENGTH = 60;

/**
 * Merge newly extracted terms into the existing glossary.
 * Existing entries always win (the first rendering is canonical); returns the
 * list of keys that were actually added.
 */
export function mergeGlossary(
  existing: Record<string, string>,
  extracted: Record<string, string>
): { merged: Record<string, string>; added: string[] } {
  const existingLower = new Set(
    Object.keys(existing).map((k) => k.toLowerCase())
  );
  const merged = { ...existing };
  const added: string[] = [];
  for (const [key, value] of Object.entries(extracted)) {
    const k = key.trim();
    const v = typeof value === 'string' ? value.trim() : '';
    if (!k || !v) continue;
    if (k.length > MAX_TERM_LENGTH || v.length > MAX_TERM_LENGTH) continue;
    if (existingLower.has(k.toLowerCase())) continue;
    merged[k] = v;
    added.push(k);
    existingLower.add(k.toLowerCase());
  }
  return { merged, added };
}

/**
 * Extract new glossary terms from a chapter's actual source/translation
 * pairs (fast tier recommended). Returns only terms not already present.
 * Never throws — extraction is best-effort and must not fail the pipeline.
 */
export async function extractIncrementalGlossary(
  config: LLMConfig,
  pairs: Array<{ source: string; translated: string }>,
  glossary: Record<string, string>,
  sourceLanguage: string,
  targetLanguage: string
): Promise<Record<string, string>> {
  // Cap the input: take pairs from the start until the char budget is spent.
  // New names tend to recur, so partial coverage of a chapter is fine.
  const sourceParts: string[] = [];
  const targetParts: string[] = [];
  let used = 0;
  for (const p of pairs) {
    const len = p.source.length + p.translated.length;
    if (used > 0 && used + len > INCREMENTAL_INPUT_CHAR_CAP) break;
    sourceParts.push(p.source);
    targetParts.push(p.translated);
    used += len;
  }
  if (sourceParts.length === 0) return {};

  const existingStr = Object.entries(glossary)
    .map(([k, v]) => `${k} → ${v}`)
    .join('\n');

  try {
    const response = await llmChat(
      config,
      [
        {
          role: 'system',
          content: glossaryExtractorSystem(
            languageName(sourceLanguage),
            languageName(targetLanguage)
          ),
        },
        {
          role: 'user',
          content: glossaryExtractorUser(
            existingStr,
            sourceParts.join('\n'),
            targetParts.join('\n')
          ),
        },
      ],
      { temperature: 0.1, maxTokens: 4096 }
    );

    const parsed = parseJsonResponse<Record<string, unknown>>(response);
    // Tolerate {"terms": {...}} wrappers
    const map =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as any).terms === 'object' &&
      !Array.isArray((parsed as any).terms)
        ? ((parsed as any).terms as Record<string, unknown>)
        : parsed;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch (err) {
    console.warn(
      '[glossary] Incremental extraction failed:',
      (err as Error).message
    );
    return {};
  }
}
