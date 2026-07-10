/**
 * Translation-quality A/B evaluation harness.
 *
 * Runs the REAL translation pipeline (services/translator/src/translate-worker
 * translateBook) twice over the same fixture — once with a "baseline" feature
 * set and once with a "treatment" feature set — backed by an in-memory D1 so
 * no Cloudflare resources are touched. It then aligns the two outputs
 * paragraph-by-paragraph and has a strong LLM judge do blind, order-swapped
 * pairwise comparison (see judge.ts). The result is a per-dimension win rate
 * that says, with a concrete number, whether the treatment improved quality.
 *
 * Usage:
 *   OPENAI_API_KEY=... \
 *   OPENAI_MODEL=deepseek-chat OPENAI_API_BASE_URL=https://api.deepseek.com \
 *   [JUDGE_MODEL=...] [EVAL_VARIANT=all|<feature>] \
 *   npx tsx eval/run-eval.ts [fixture.json]
 *
 * EVAL_VARIANT selects what "treatment" means:
 *   all         — every wenyi feature on (default)
 *   styleGuide | bookContext | incrementalGlossary | reviewPass
 *               — that single feature on top of baseline (ablation)
 * Baseline is always all-features-off. Set EVAL_VARIANT=all,styleGuide,... to
 * run several treatments in sequence against one shared baseline.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  translateBook,
  PipelineFeatures,
  ALL_FEATURES_OFF,
} from '../src/translate-worker.js';
import { LLMConfig } from '../src/llm-client.js';
import { MemoryStore, makeMemoryD1, MemoryBookInput } from './memory-d1.js';
import {
  JUDGE_DIMENSIONS,
  JudgeDimension,
  judgePair,
  PairVerdict,
} from './judge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  title: string;
  source_language: string;
  target_language: string;
  chapters: Array<{ title: string; paragraphs: string[] }>;
}

const ALL_FEATURES_ON: PipelineFeatures = {
  styleGuide: true,
  bookContext: true,
  incrementalGlossary: true,
  reviewPass: true,
  autofixSevere: true,
};

/** Named treatment feature sets, each layered on top of the all-off baseline. */
function treatmentFeatures(variant: string): PipelineFeatures {
  if (variant === 'all') return { ...ALL_FEATURES_ON };
  const f = { ...ALL_FEATURES_OFF };
  switch (variant) {
    case 'styleGuide':
      f.styleGuide = true;
      break;
    case 'bookContext':
      f.bookContext = true;
      break;
    case 'incrementalGlossary':
      f.incrementalGlossary = true;
      break;
    case 'reviewPass':
      f.reviewPass = true;
      f.autofixSevere = true;
      break;
    default:
      throw new Error(`Unknown EVAL_VARIANT: ${variant}`);
  }
  return f;
}

function fixtureToBookInput(fx: Fixture, uuid: string): MemoryBookInput {
  return {
    uuid,
    bookId: 100,
    title: fx.title,
    sourceLanguage: fx.source_language,
    targetLanguage: fx.target_language,
    chapters: fx.chapters.map((ch, ci) => ({
      chapter_number: ci + 1,
      title: ch.title,
      original_title: ch.title,
      text_nodes: ch.paragraphs.map((p, pi) => ({
        xpath: `/body/p[${pi + 1}]`,
        text: p,
        html: `<p>${p}</p>`,
        orderIndex: pi,
      })),
    })),
  };
}

async function runVariant(
  fx: Fixture,
  llmConfig: LLMConfig,
  features: PipelineFeatures,
  label: string
): Promise<MemoryStore> {
  const store = new MemoryStore(fixtureToBookInput(fx, `eval-${label}`));
  const db = makeMemoryD1(store);
  const t0 = Date.now();
  await translateBook(db, llmConfig, `eval-${label}`, features);
  console.log(
    `  [${label}] translated ${fx.chapters.length} chapters in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  return store;
}

interface AlignedPassage {
  chapter: number;
  order: number;
  source: string;
  baseline: string;
  treatment: string;
}

/** Align the two runs by (chapter, orderIndex); skip failed/empty nodes. */
function alignPassages(
  fx: Fixture,
  baseline: MemoryStore,
  treatment: MemoryStore
): AlignedPassage[] {
  const out: AlignedPassage[] = [];
  for (let ch = 1; ch <= fx.chapters.length; ch++) {
    const bt = baseline.chapterTranslations(ch);
    const tt = treatment.chapterTranslations(ch);
    const byOrderT = new Map(tt.map((t) => [t.orderIndex, t]));
    for (const b of bt) {
      const t = byOrderT.get(b.orderIndex);
      if (!t) continue;
      if (
        b.translatedText.includes('[Translation failed]') ||
        t.translatedText.includes('[Translation failed]')
      )
        continue;
      out.push({
        chapter: ch,
        order: b.orderIndex,
        source: b.originalText,
        baseline: b.translatedText,
        treatment: t.translatedText,
      });
    }
  }
  return out;
}

interface Tally {
  passages: number;
  judged: number;
  positionSensitive: number;
  overall: { baseline: number; treatment: number; tie: number };
  dimensions: Record<
    JudgeDimension,
    { baseline: number; treatment: number; tie: number }
  >;
}

function emptyTally(): Tally {
  const dims = {} as Tally['dimensions'];
  for (const d of JUDGE_DIMENSIONS)
    dims[d] = { baseline: 0, treatment: 0, tie: 0 };
  return {
    passages: 0,
    judged: 0,
    positionSensitive: 0,
    overall: { baseline: 0, treatment: 0, tie: 0 },
    dimensions: dims,
  };
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${((n / total) * 100).toFixed(0)}%`;
}

/** Simple concurrency-limited map. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

async function evaluateVariant(
  fx: Fixture,
  llmConfig: LLMConfig,
  judgeConfig: LLMConfig,
  variant: string
): Promise<{ tally: Tally; details: any[] }> {
  console.log(`\n=== Treatment: ${variant} ===`);
  const baselineStore = await runVariant(
    fx,
    llmConfig,
    { ...ALL_FEATURES_OFF },
    `baseline-${variant}`
  );
  const treatmentStore = await runVariant(
    fx,
    llmConfig,
    treatmentFeatures(variant),
    variant
  );

  const passages = alignPassages(fx, baselineStore, treatmentStore);
  console.log(
    `  aligned ${passages.length} passages; judging (blind, order-swapped)...`
  );

  const tally = emptyTally();
  tally.passages = passages.length;
  const details: any[] = [];

  const verdicts = await mapLimit(passages, 4, async (p) => {
    const v = await judgePair(
      judgeConfig,
      p.source,
      p.baseline,
      p.treatment,
      fx.source_language,
      fx.target_language
    );
    return { p, v };
  });

  for (const { p, v } of verdicts) {
    if (!v) continue;
    tally.judged++;
    if (v.positionSensitive) tally.positionSensitive++;
    tally.overall[v.overall]++;
    for (const d of JUDGE_DIMENSIONS)
      tally.dimensions[d][v.dimensionWinners[d]]++;
    details.push({
      chapter: p.chapter,
      order: p.order,
      source: p.source,
      baseline: p.baseline,
      treatment: p.treatment,
      overall: v.overall,
      dimensions: v.dimensionWinners,
      positionSensitive: v.positionSensitive,
      reasons: v.reasons,
    });
  }
  return { tally, details };
}

function printTally(variant: string, tally: Tally): void {
  console.log(`\n--- Results: ${variant} (baseline vs treatment) ---`);
  console.log(
    `  passages judged: ${tally.judged}/${tally.passages}` +
      (tally.positionSensitive
        ? `  (${tally.positionSensitive} position-sensitive → counted tie)`
        : '')
  );
  const row = (
    label: string,
    r: { baseline: number; treatment: number; tie: number }
  ) => {
    console.log(
      `  ${label.padEnd(13)}  treatment ${String(r.treatment).padStart(3)} (${pct(r.treatment, tally.judged).padStart(4)})  ` +
        `baseline ${String(r.baseline).padStart(3)} (${pct(r.baseline, tally.judged).padStart(4)})  ` +
        `tie ${String(r.tie).padStart(3)} (${pct(r.tie, tally.judged).padStart(4)})`
    );
  };
  row('overall', tally.overall);
  for (const d of JUDGE_DIMENSIONS) row(d, tally.dimensions[d]);

  const net = tally.overall.treatment - tally.overall.baseline;
  const verdict =
    net > 0
      ? `treatment BETTER (+${net} overall wins)`
      : net < 0
        ? `treatment WORSE (${net} overall wins)`
        : 'no clear difference';
  console.log(`  VERDICT: ${verdict}`);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required.');
    process.exit(1);
  }
  const baseURL =
    process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const llmConfig: LLMConfig = {
    apiKey,
    baseURL,
    model,
    fastModel: process.env.OPENAI_MODEL_FAST || undefined,
    cheapModel: process.env.OPENAI_MODEL_CHEAP || undefined,
  };
  const judgeConfig: LLMConfig = {
    apiKey: process.env.JUDGE_API_KEY || apiKey,
    baseURL: process.env.JUDGE_API_BASE_URL || baseURL,
    model: process.env.JUDGE_MODEL || model,
  };

  const fixtureArg =
    process.argv[2] || join(__dirname, 'fixtures', 'scandal-in-bohemia.json');
  const fx: Fixture = JSON.parse(readFileSync(resolve(fixtureArg), 'utf-8'));

  const variants = (process.env.EVAL_VARIANT || 'all')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(
    `Fixture: ${fx.title} (${fx.chapters.length} chapters, ${fx.source_language}→${fx.target_language})`
  );
  console.log(
    `Translator model: ${model}${llmConfig.fastModel ? ` (fast: ${llmConfig.fastModel})` : ''}${llmConfig.cheapModel ? ` (cheap: ${llmConfig.cheapModel})` : ''}`
  );
  console.log(`Judge model: ${judgeConfig.model}`);
  console.log(`Treatments: ${variants.join(', ')}`);

  const report: any = {
    fixture: fx.title,
    model,
    judgeModel: judgeConfig.model,
    variants: {},
  };

  for (const variant of variants) {
    const { tally, details } = await evaluateVariant(
      fx,
      llmConfig,
      judgeConfig,
      variant
    );
    printTally(variant, tally);
    report.variants[variant] = { tally, details };
  }

  const outDir = join(__dirname, 'results');
  mkdirSync(outDir, { recursive: true });
  // EVAL_TAG keeps per-run reports distinct (e.g. one file per translator model).
  const tag = (process.env.EVAL_TAG || '').replace(/[^a-zA-Z0-9._-]/g, '-');
  const outPath = join(
    outDir,
    `eval-${variants.join('_')}${tag ? `-${tag}` : ''}.json`
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(
    `\nFull report (with per-passage verdicts) written to ${outPath}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
