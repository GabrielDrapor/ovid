/**
 * LLM-as-judge for blind pairwise comparison of two translations of the same
 * source passage.
 *
 * Translation quality is subjective, so instead of scoring one translation in
 * isolation we ask a strong model to pick the better of two, per named
 * dimension, given the source. Two guards against bias:
 *   - Blind: the judge never sees which variant produced which translation
 *     (labelled only "A"/"B").
 *   - Order-swapped: every pair is judged twice with A/B positions flipped;
 *     a variant only "wins" a dimension if it is preferred in a way that
 *     survives the swap (otherwise it's counted a tie). This cancels the
 *     well-known position bias of pairwise LLM judges.
 */

import {
  LLMConfig,
  llmChat,
  languageName,
  parseJsonResponse,
} from '../src/llm-client.js';

export const JUDGE_DIMENSIONS = [
  'accuracy', // faithful to the source meaning, no added/dropped info
  'fluency', // reads like natural target-language prose
  'consistency', // proper nouns and terminology are consistent
  'style', // tone/register/voice preserved
] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

export type PerDimensionWinner = Record<JudgeDimension, 'A' | 'B' | 'tie'>;

interface RawVerdict {
  winners: PerDimensionWinner;
  overall: 'A' | 'B' | 'tie';
  reason: string;
}

function judgeSystem(sourceLang: string, targetLang: string): string {
  return `You are an expert bilingual literary editor judging two ${targetLang} translations (A and B) of the same ${sourceLang} source passage.
Judge strictly on the text; you do not know how either translation was produced.
For EACH dimension decide which translation is better, or "tie" if genuinely equal:
- accuracy: faithful to the source meaning; no added, dropped, or mistranslated information
- fluency: reads like natural, idiomatic ${targetLang} prose (not translationese)
- consistency: proper nouns and recurring terms are rendered consistently and correctly
- style: preserves the source's tone, register, and character voice
Then give an overall winner. Be impartial; do not favour A or B by position.
Return ONLY JSON:
{"winners":{"accuracy":"A|B|tie","fluency":"A|B|tie","consistency":"A|B|tie","style":"A|B|tie"},"overall":"A|B|tie","reason":"one sentence"}`;
}

function judgeUser(source: string, a: string, b: string): string {
  return `SOURCE:
${source}

TRANSLATION A:
${a}

TRANSLATION B:
${b}

Judge each dimension and the overall winner. Return only the JSON.`;
}

/**
 * Recover the winner labels with regex when full JSON.parse fails — judges
 * occasionally emit an unescaped quote inside the free-text `reason`, which
 * breaks the whole object even though the machine-readable winner fields are
 * well-formed. We only need those fields, so pull them directly.
 */
function recoverVerdict(raw: string): RawVerdict | null {
  const winners = {} as PerDimensionWinner;
  let found = 0;
  for (const dim of JUDGE_DIMENSIONS) {
    const m = raw.match(new RegExp(`"${dim}"\\s*:\\s*"(A|B|tie)"`, 'i'));
    if (m) {
      winners[dim] =
        m[1].toLowerCase() === 'tie'
          ? 'tie'
          : (m[1].toUpperCase() as 'A' | 'B');
      found++;
    } else winners[dim] = 'tie';
  }
  if (found === 0) return null;
  const om = raw.match(/"overall"\s*:\s*"(A|B|tie)"/i);
  const overall = om
    ? om[1].toLowerCase() === 'tie'
      ? 'tie'
      : (om[1].toUpperCase() as 'A' | 'B')
    : 'tie';
  return { winners, overall, reason: '(recovered from malformed JSON)' };
}

async function judgeOnce(
  config: LLMConfig,
  source: string,
  a: string,
  b: string,
  sourceLang: string,
  targetLang: string
): Promise<RawVerdict | null> {
  let response = '';
  try {
    response = await llmChat(
      config,
      [
        { role: 'system', content: judgeSystem(sourceLang, targetLang) },
        { role: 'user', content: judgeUser(source, a, b) },
      ],
      { temperature: 0.0, maxTokens: 1024 }
    );
  } catch (err) {
    console.warn('[judge] request failed:', (err as Error).message);
    return null;
  }
  try {
    const parsed = parseJsonResponse<RawVerdict>(response);
    if (parsed?.winners) return parsed;
  } catch {
    /* fall through to regex recovery */
  }
  const recovered = recoverVerdict(response);
  if (!recovered)
    console.warn('[judge] unparseable verdict:', response.slice(0, 120));
  return recovered;
}

export interface PairVerdict {
  /** Per-dimension winner in terms of the real variant names. */
  dimensionWinners: Record<JudgeDimension, 'baseline' | 'treatment' | 'tie'>;
  overall: 'baseline' | 'treatment' | 'tie';
  /** True when the two swapped runs disagreed (position bias detected → tie). */
  positionSensitive: boolean;
  reasons: string[];
}

/**
 * Judge one source passage's baseline vs treatment translation, running the
 * comparison in both orderings and only awarding a win when it survives the
 * swap. `treatmentAsA` internally maps variant→position; callers pass the raw
 * texts and get variant-named winners back.
 */
export async function judgePair(
  config: LLMConfig,
  source: string,
  baseline: string,
  treatment: string,
  sourceLangCode: string,
  targetLangCode: string
): Promise<PairVerdict | null> {
  const sourceLang = languageName(sourceLangCode);
  const targetLang = languageName(targetLangCode);

  // Run 1: A = baseline, B = treatment. Run 2: A = treatment, B = baseline.
  const [run1, run2] = await Promise.all([
    judgeOnce(config, source, baseline, treatment, sourceLang, targetLang),
    judgeOnce(config, source, treatment, baseline, sourceLang, targetLang),
  ]);
  if (!run1 || !run2) return null;

  // Normalize both runs to variant names (baseline/treatment).
  const toVariant = (
    w: 'A' | 'B' | 'tie',
    baselineIsA: boolean
  ): 'baseline' | 'treatment' | 'tie' => {
    if (w === 'tie') return 'tie';
    const isBaseline = baselineIsA ? w === 'A' : w === 'B';
    return isBaseline ? 'baseline' : 'treatment';
  };

  const dimensionWinners = {} as Record<
    JudgeDimension,
    'baseline' | 'treatment' | 'tie'
  >;
  let positionSensitive = false;
  for (const dim of JUDGE_DIMENSIONS) {
    const v1 = toVariant(run1.winners[dim] ?? 'tie', true);
    const v2 = toVariant(run2.winners[dim] ?? 'tie', false);
    if (v1 === v2) {
      dimensionWinners[dim] = v1;
    } else {
      dimensionWinners[dim] = 'tie'; // disagreement under swap → no credit
      if (v1 !== 'tie' && v2 !== 'tie') positionSensitive = true;
    }
  }

  const o1 = toVariant(run1.overall ?? 'tie', true);
  const o2 = toVariant(run2.overall ?? 'tie', false);
  const overall = o1 === o2 ? o1 : 'tie';

  return {
    dimensionWinners,
    overall,
    positionSensitive,
    reasons: [run1.reason, run2.reason].filter(Boolean),
  };
}
