/**
 * Prompt A/B eval for translationese (翻译腔).
 *
 * Motivation: user-reported calque like 「中国的主要担忧，尼克松被告知。」
 * ("China's big worry, Nixon was told.") — grammatical residue-free output
 * that mirrors English syntax. The absolute-score judge in
 * eval-translation.mjs saturates at 4.9-5.0 and cannot see this, so this
 * eval is pairwise: same model, current prompt (A) vs candidate prompt (B),
 * judged blind by a non-deepseek judge with randomized presentation order.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/eval-prompt-ab.mjs
 * Env: EVAL_MODEL (default prod deepseek/deepseek-v3.2),
 *      JUDGE (default google/gemini-2.5-pro)
 */
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) { console.error('OPENROUTER_API_KEY required'); process.exit(1); }
const BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL = process.env.EVAL_MODEL || 'deepseek/deepseek-v3.2';
const JUDGE = process.env.JUDGE || 'google/gemini-2.5-pro';
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval-results');

// ─── Adversarial set: constructions that provoke calque ──────────────────────
// First two anchors are the user's real-world failure shapes.
const SEGMENTS = [
  // reporting clauses / attribution
  { tag: 'reporting', text: `China's big worry, Nixon was told, was the Soviet buildup on its northern border.` },
  { tag: 'reporting', text: `The deal, sources said, had been dead for weeks before anyone admitted it.` },
  { tag: 'reporting', text: `It would rain for forty days, the old men claimed, if the herons left the marsh.` },
  // passives
  { tag: 'passive', text: `He was believed to have left the country long before the warrant was issued.` },
  { tag: 'passive', text: `The bridge was said to be haunted, and was therefore avoided by anyone returning after dark.` },
  { tag: 'passive', text: `Mistakes were made, careers were ended, and nothing was learned.` },
  // clefts & fronting
  { tag: 'cleft', text: `It was not until the third winter that the villagers understood what the surveyors had really come for.` },
  { tag: 'cleft', text: `What worried her most was not the silence itself but how comfortable everyone had become with it.` },
  { tag: 'cleft', text: `It was his hands, more than anything he said, that gave him away.` },
  // appositives & interpolation
  { tag: 'appositive', text: `The manager — a careful, unhurried man who had survived three ownership changes — simply refused to answer.` },
  { tag: 'appositive', text: `Her brother, by then the only lawyer in a town of ranchers, drew up the papers himself.` },
  // nominalization / abstract subjects
  { tag: 'nominal', text: `The realization that no help was coming changed the character of their preparations.` },
  { tag: 'nominal', text: `His failure to mention the second account was what finally convinced the auditors.` },
  { tag: 'nominal', text: `There was a quiet insistence in the way she set the cup down that ended the argument.` },
  // negation & concession patterns
  { tag: 'negation', text: `Not that he minded the work; it was the gratitude he could not stand.` },
  { tag: 'negation', text: `No sooner had the gates opened than the rumor proved itself true.` },
  { tag: 'negation', text: `He liked facing managers with clear, rigid philosophies — it simply made his tactical task easier, as he outlined in a 2014 interview.` },
  // long periodic sentences
  { tag: 'periodic', text: `That a man of his standing, with every advantage of birth and education, should end his days keeping ledgers for a provincial brewery struck no one in the family as worth explaining.` },
  { tag: 'periodic', text: `Whether the letters were burned, or merely lost in one of the many moves, or kept by someone with reasons of her own, no biographer has been able to establish.` },
  // dialogue with interleaved attribution
  { tag: 'dialogue', text: `"You knew," she said, not looking up, "the whole time we were packing, you knew."` },
  { tag: 'dialogue', text: `"Wenger seems to want a rule," Allardyce said, "where Arsenal can keep the ball as long as they like and we are not allowed to tackle them."` },
  // idiom & metaphor
  { tag: 'idiom', text: `The committee kicked the can down the road again, and everyone went home pretending that was a decision.` },
  { tag: 'idiom', text: `By Thursday the story had legs, and by Friday it had outrun everyone who might have stopped it.` },
  // controls: plain narrative (prompt B must not degrade these)
  { tag: 'control', text: `The next morning they crossed the river and walked north along the old logging road until noon.` },
  { tag: 'control', text: `She opened the letter carefully, read it twice, and put it back in the envelope.` },
  { tag: 'control', text: `The restaurant was small, with six tables and a counter, and the owner cooked everything himself.` },
  { tag: 'control', text: `In 1911 the family moved to Trieste, where his father had found work in an insurance office.` },
];

// ─── Prompts ─────────────────────────────────────────────────────────────────
// A = the pre-2026-08 production prompt; B = A + naturalness rules 7-8.
// B won 21/27 (0 control regressions) and shipped as the production prompt —
// future candidates should use the current prod prompt as their new "A".
const PROMPT_A = `You are a professional literary translator. Translate the following en text to Chinese.

**CRITICAL RULES:**
1. Return ONLY the translation of the text inside <translate> tags.
2. Do NOT wrap in quotes unless the source has them.
3. Maintain style, tone, and formatting.
4. For proper nouns, use exact translations from the Glossary.
5. Output ONLY the translated text.
6. NEVER leave English words in the output, except for proper nouns with no standard Chinese translation. If a word is difficult to translate, find the closest natural expression.`;

const PROMPT_B = `${PROMPT_A}
7. Do NOT mirror English sentence structure. Reorder and restructure freely so the result reads as if originally written in Chinese: convert unnatural passives into natural voice, move reporting clauses to where Chinese puts them (e.g. "X, Nixon was told." → "有人告诉尼克松，X"), and split or merge clauses to match Chinese rhythm.
8. Before answering, reread your translation as a native Chinese literary editor would; if any sentence reads like a word-for-word gloss of the English, rewrite that sentence.`;

// ─── LLM helpers ─────────────────────────────────────────────────────────────
async function llm(model, messages, opts = {}) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Ovid Prompt AB Eval' },
        body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 4096, temperature: opts.temperature ?? 0.3 }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('empty response');
      return content;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1500));
    }
  }
}

const translate = async (systemPrompt, text) =>
  (await llm(MODEL, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `\n<translate>\n${text}\n</translate>` },
  ])).replace(/<\/?translate>/gi, '').trim();

async function judgePair(source, first, second) {
  const content = await llm(JUDGE, [
    {
      role: 'system',
      content: `你是资深中文文学译者与翻译评审。给你一句英文原文和两个中文译文（甲/乙）。
评判标准（按重要性排序）：
1. 无翻译腔：不是英文句式的逐字影子（如「X，尼克松被告知。」这类被动位错、主语悬空、欧化定语都算翻译腔）
2. 准确：原意无损、无添油加醋
3. 自然：读起来像中文原生写作

只返回 JSON：{"winner": "甲" | "乙" | "平", "reason": "一句话理由"}`,
    },
    { role: 'user', content: `英文原文：\n${source}\n\n译文甲：\n${first}\n\n译文乙：\n${second}` },
  ], { temperature: 0.1, maxTokens: 4096 });
  let s = content.trim();
  if (s.startsWith('```')) s = s.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : s);
}

async function judgePairSafe(source, first, second) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await judgePair(source, first, second);
    } catch { /* retry once */ }
  }
  return { winner: '平', reason: 'judge unparseable — counted as tie' };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Model: ${MODEL} | Judge: ${JUDGE} | Segments: ${SEGMENTS.length}\n`);

  const rows = [];
  for (let i = 0; i < SEGMENTS.length; i++) {
    const seg = SEGMENTS[i];
    const [a, b] = await Promise.all([translate(PROMPT_A, seg.text), translate(PROMPT_B, seg.text)]);
    // Blind, randomized presentation
    const bFirst = Math.random() < 0.5;
    const verdictRaw = await judgePairSafe(seg.text, bFirst ? b : a, bFirst ? a : b);
    const winner =
      verdictRaw.winner === '平' ? 'tie'
        : (verdictRaw.winner === '甲') === bFirst ? 'B' : 'A';
    rows.push({ ...seg, a, b, winner, reason: verdictRaw.reason });
    process.stdout.write(winner === 'B' ? 'B' : winner === 'A' ? 'A' : '=');
  }
  console.log('\n');

  const wins = { A: 0, B: 0, tie: 0 };
  const byTag = {};
  for (const r of rows) {
    wins[r.winner]++;
    byTag[r.tag] = byTag[r.tag] ?? { A: 0, B: 0, tie: 0 };
    byTag[r.tag][r.winner]++;
  }

  console.log(`Overall: B wins ${wins.B} | A wins ${wins.A} | ties ${wins.tie}  (n=${rows.length})`);
  console.log('\nBy construction:');
  for (const [tag, w] of Object.entries(byTag)) {
    console.log(`  ${tag.padEnd(11)} B:${w.B} A:${w.A} =:${w.tie}`);
  }
  console.log('\nExamples where B won:');
  for (const r of rows.filter(r => r.winner === 'B').slice(0, 3)) {
    console.log(`  [${r.tag}] ${r.text.slice(0, 60)}`);
    console.log(`    A: ${r.a.slice(0, 80)}`);
    console.log(`    B: ${r.b.slice(0, 80)}`);
    console.log(`    judge: ${r.reason}`);
  }
  const regressions = rows.filter(r => r.winner === 'A' && r.tag === 'control');
  console.log(`\nControl regressions (B worse on plain narrative): ${regressions.length}`);
  for (const r of regressions) {
    console.log(`  ${r.text.slice(0, 50)} | judge: ${r.reason}`);
  }

  if (!existsSync(RESULTS_DIR)) await mkdir(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join(RESULTS_DIR, `prompt-ab-${ts}.json`);
  await writeFile(out, JSON.stringify({ model: MODEL, judge: JUDGE, promptA: PROMPT_A, promptB: PROMPT_B, wins, byTag, rows }, null, 2));
  console.log(`\nSaved: ${out}`);
}

main().catch(e => { console.error('eval failed:', e); process.exit(1); });
