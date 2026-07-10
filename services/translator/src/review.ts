/**
 * Chapter-end review pass.
 *
 * Adapted from wenyi (https://github.com/BigDawnGhost/wenyi, MIT),
 * trans_novel/agents/reviewer.py + pipeline.autofix_severe: after a chapter
 * is translated, a cheap-tier reviewer compares source/translation pairs and
 * reports only definite problems (missing / added / mistranslation /
 * terminology / pronoun). Severe issues are then retranslated with the
 * reviewer's feedback, and the fix is only adopted if it passes basic sanity
 * checks (wenyi: "过长度校验才采纳").
 */

import {
  LLMConfig,
  llmChat,
  languageName,
  parseJsonResponse,
} from './llm-client.js';
import {
  StaticPromptContext,
  reviewerSystem,
  reviewerUser,
  translatorFixUser,
  translatorSingleSystem,
} from './prompts.js';

export interface ReviewIssue {
  index: number;
  type: string;
  detail: string;
  suggestion?: string;
}

export interface ReviewPair {
  index: number;
  source: string;
  translated: string;
}

/** Issue types severe enough to trigger automatic retranslation */
export const SEVERE_ISSUE_TYPES = new Set([
  'missing',
  'added',
  'mistranslation',
]);

/** Max pairs per review call */
const REVIEW_CHUNK_PAIRS = 10;
/** Max chars (source+translation) per review call */
const REVIEW_CHUNK_CHAR_CAP = 8000;

function chunkPairs(pairs: ReviewPair[]): ReviewPair[][] {
  const chunks: ReviewPair[][] = [];
  let current: ReviewPair[] = [];
  let chars = 0;
  for (const p of pairs) {
    const len = p.source.length + p.translated.length;
    if (
      current.length > 0 &&
      (current.length >= REVIEW_CHUNK_PAIRS ||
        chars + len > REVIEW_CHUNK_CHAR_CAP)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Review a chapter's source/translation pairs. Chunked into multiple LLM
 * calls; failures of individual chunks are logged and skipped. Returned
 * issues reference the `index` values passed in.
 */
export async function reviewPairs(
  config: LLMConfig,
  pairs: ReviewPair[],
  glossaryStr: string,
  sourceLanguage: string,
  targetLanguage: string
): Promise<ReviewIssue[]> {
  const system = reviewerSystem(
    languageName(sourceLanguage),
    languageName(targetLanguage)
  );
  const issues: ReviewIssue[] = [];
  const validIndexes = new Set(pairs.map((p) => p.index));

  for (const chunk of chunkPairs(pairs)) {
    try {
      const response = await llmChat(
        config,
        [
          { role: 'system', content: system },
          { role: 'user', content: reviewerUser(glossaryStr, chunk) },
        ],
        { temperature: 0.1, maxTokens: 4096 }
      );
      const parsed = parseJsonResponse<{ issues?: ReviewIssue[] }>(response);
      for (const issue of parsed.issues ?? []) {
        if (typeof issue?.index !== 'number' || !validIndexes.has(issue.index))
          continue;
        if (typeof issue.type !== 'string' || typeof issue.detail !== 'string')
          continue;
        issues.push(issue);
      }
    } catch (err) {
      console.warn('[review] Chunk review failed:', (err as Error).message);
    }
  }
  return issues;
}

/**
 * Sanity-check a retranslation before adopting it (wenyi's length check,
 * loosened for cross-script pairs): non-empty, no leaked prompt tags, and a
 * plausible length relative to the source.
 */
export function isPlausibleFix(source: string, fixed: string): boolean {
  const f = fixed.trim();
  if (!f) return false;
  if (/<\/?(seg|translate|context)\b/i.test(f)) return false;
  // CJK↔latin length ratios legitimately vary a lot; only reject extremes.
  const ratio = f.length / Math.max(source.length, 1);
  if (ratio < 0.15 || ratio > 6) return false;
  return true;
}

/**
 * Retranslate a single segment with the reviewer's feedback (strong tier).
 * Returns the fixed translation, or null if the fix failed sanity checks.
 */
export async function fixTranslation(
  config: LLMConfig,
  ctx: StaticPromptContext,
  pair: ReviewPair,
  feedback: string,
  sourceLanguage: string,
  targetLanguage: string
): Promise<string | null> {
  try {
    const response = await llmChat(
      config,
      [
        {
          role: 'system',
          content: translatorSingleSystem(
            languageName(sourceLanguage),
            languageName(targetLanguage)
          ),
        },
        {
          role: 'user',
          content: translatorFixUser(
            ctx,
            pair.source,
            pair.translated,
            feedback
          ),
        },
      ],
      { temperature: 0.3, maxTokens: 8192 }
    );
    const fixed = response
      .replace(/<\/?translate>/gi, '')
      .replace(/<\/?context>/gi, '')
      .trim();
    return isPlausibleFix(pair.source, fixed) ? fixed : null;
  } catch (err) {
    console.warn('[review] Fix retranslation failed:', (err as Error).message);
    return null;
  }
}
