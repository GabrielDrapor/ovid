/**
 * Pre-translation book understanding.
 *
 * Adapted from wenyi (https://github.com/BigDawnGhost/wenyi, MIT):
 *  - Style analysis (trans_novel/agents/analyzer.py): sample passages from
 *    the head/middle/tail of the book are analyzed once to produce a style
 *    guide (narration, register, character voices) that every translation
 *    call follows.
 *  - Book understanding (trans_novel/agents/synopsis.py): each chapter gets
 *    a short digest (fast tier, concurrent), then the digests are synthesized
 *    into a whole-book overview. Both are injected as constant prompt
 *    prefixes so even chapter 1 is translated with knowledge of where the
 *    story goes.
 *
 * Every function here is best-effort: failures degrade to `null` and the
 * pipeline continues without the corresponding context block.
 */

import {
  LLMConfig,
  llmChat,
  languageName,
  parseJsonResponse,
} from './llm-client.js';
import {
  StyleGuide,
  bookSynopsisSystem,
  bookSynopsisUser,
  chapterDigestSystem,
  chapterDigestUser,
  styleAnalyzerSystem,
  styleAnalyzerUser,
} from './prompts.js';

/** Persisted on translation_jobs.book_context_json */
export interface BookContext {
  styleGuide: StyleGuide | null;
  synopsis: string | null;
  /** chapter number (as string key) → digest */
  digests: Record<string, string>;
}

/** Max chars of a chapter fed into one digest call */
const DIGEST_INPUT_CHAR_CAP = 8000;
/** Max chars per style-analysis sample */
const SAMPLE_CHAR_CAP = 6000;
/** Concurrent digest calls (wenyi config: prescan_concurrency) */
const DIGEST_CONCURRENCY = 4;

/** Pick head/middle/tail sample passages for style analysis. */
export function pickStyleSamples(
  chapterTexts: string[]
): Array<{ position: string; text: string }> {
  const nonEmpty = chapterTexts.filter((t) => t.trim().length > 0);
  if (nonEmpty.length === 0) return [];
  const clip = (t: string) => t.slice(0, SAMPLE_CHAR_CAP);
  const samples = [{ position: 'the beginning', text: clip(nonEmpty[0]) }];
  if (nonEmpty.length >= 3) {
    samples.push({
      position: 'the middle',
      text: clip(nonEmpty[Math.floor(nonEmpty.length / 2)]),
    });
  }
  if (nonEmpty.length >= 2) {
    samples.push({
      position: 'the end',
      text: clip(nonEmpty[nonEmpty.length - 1]),
    });
  }
  return samples;
}

/** Analyze sample passages into a style guide. Returns null on failure. */
export async function analyzeStyle(
  config: LLMConfig,
  chapterTexts: string[],
  sourceLanguage: string,
  targetLanguage: string
): Promise<StyleGuide | null> {
  const samples = pickStyleSamples(chapterTexts);
  if (samples.length === 0) return null;
  try {
    const response = await llmChat(
      config,
      [
        {
          role: 'system',
          content: styleAnalyzerSystem(
            languageName(sourceLanguage),
            languageName(targetLanguage)
          ),
        },
        { role: 'user', content: styleAnalyzerUser(samples) },
      ],
      { temperature: 0.2, maxTokens: 4096 }
    );
    const parsed = parseJsonResponse<StyleGuide>(response);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.warn('[analysis] Style analysis failed:', (err as Error).message);
    return null;
  }
}

/**
 * Generate a digest per chapter (concurrent, fast tier).
 * Chapters that fail are simply absent from the result.
 */
export async function digestChapters(
  config: LLMConfig,
  chapters: Array<{ number: number; text: string }>,
  sourceLanguage: string,
  targetLanguage: string
): Promise<Record<string, string>> {
  const system = chapterDigestSystem(
    languageName(sourceLanguage),
    languageName(targetLanguage)
  );
  const digests: Record<string, string> = {};

  const work = chapters.filter((c) => c.text.trim().length > 0);
  for (let i = 0; i < work.length; i += DIGEST_CONCURRENCY) {
    const group = work.slice(i, i + DIGEST_CONCURRENCY);
    const results = await Promise.allSettled(
      group.map((ch) =>
        llmChat(
          config,
          [
            { role: 'system', content: system },
            {
              role: 'user',
              content: chapterDigestUser(
                ch.text.slice(0, DIGEST_INPUT_CHAR_CAP)
              ),
            },
          ],
          { temperature: 0.2, maxTokens: 1024 }
        )
      )
    );
    for (let j = 0; j < group.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        digests[String(group[j].number)] = r.value.trim();
      } else {
        console.warn(
          `[analysis] Digest failed for chapter ${group[j].number}:`,
          r.reason?.message ?? r.reason
        );
      }
    }
  }
  return digests;
}

/** Synthesize the whole-book overview from chapter digests. Null on failure. */
export async function synthesizeSynopsis(
  config: LLMConfig,
  digests: Record<string, string>,
  targetLanguage: string
): Promise<string | null> {
  const entries = Object.entries(digests)
    .map(([ch, digest]) => ({ chapter: Number(ch), digest }))
    .sort((a, b) => a.chapter - b.chapter);
  if (entries.length === 0) return null;
  try {
    const response = await llmChat(
      config,
      [
        {
          role: 'system',
          content: bookSynopsisSystem(languageName(targetLanguage)),
        },
        { role: 'user', content: bookSynopsisUser(entries) },
      ],
      { temperature: 0.2, maxTokens: 2048 }
    );
    return response.trim();
  } catch (err) {
    console.warn(
      '[analysis] Synopsis synthesis failed:',
      (err as Error).message
    );
    return null;
  }
}
