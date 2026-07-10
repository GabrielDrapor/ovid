/**
 * Prompt builders for the translation pipeline.
 *
 * Structure adapted from wenyi (https://github.com/BigDawnGhost/wenyi, MIT),
 * trans_novel/agents/prompts.py — especially its prompt-cache discipline:
 *
 *  - System prompts are fully static for a given book (never contain
 *    per-batch content like glossary subsets or segment counts), so every
 *    call of the same kind shares one cacheable system prefix.
 *  - User prompts are ordered static → dynamic: book-level blocks first
 *    (style guide, book overview), then chapter-level blocks (glossary
 *    subset, chapter summary), then the per-batch source segments last.
 *    OpenAI-compatible prefix caching then hits on the shared prefix of
 *    every batch in the same chapter/book.
 */

// ── Static context blocks ──────────────────────────────────────────────────

export interface StaticPromptContext {
  /** Book-level style guide text (constant for the whole book) */
  styleGuideText?: string;
  /** Book-level synopsis text (constant for the whole book) */
  synopsisText?: string;
  /** Chapter-scoped glossary block (constant within a chapter) */
  glossaryStr?: string;
  /** Chapter summary text (constant within a chapter) */
  digestText?: string;
}

/**
 * Assemble the static preamble of a user prompt, ordered from most stable
 * (book-level) to least stable (chapter-level). Returns '' when empty.
 */
export function buildStaticPreamble(ctx: StaticPromptContext): string {
  const blocks: string[] = [];
  if (ctx.styleGuideText) {
    blocks.push(`**STYLE GUIDE (follow strictly):**\n${ctx.styleGuideText}`);
  }
  if (ctx.synopsisText) {
    blocks.push(
      `**BOOK OVERVIEW (for coherence with the full story; do not add spoilers to the text):**\n${ctx.synopsisText}`
    );
  }
  if (ctx.glossaryStr) {
    blocks.push(ctx.glossaryStr.trim());
  }
  if (ctx.digestText) {
    blocks.push(`**CHAPTER SUMMARY:**\n${ctx.digestText}`);
  }
  return blocks.length > 0 ? blocks.join('\n\n') + '\n\n' : '';
}

// ── Translation ────────────────────────────────────────────────────────────

/** Static system prompt for batched (seg-tagged) translation. */
export function translatorBatchSystem(
  sourceLang: string,
  targetLang: string
): string {
  return `You are a professional literary translator. Translate the following ${sourceLang} text segments to ${targetLang}.

**CRITICAL RULES:**
1. Each segment is wrapped in <seg id="N">...</seg> tags.
2. Return each translation wrapped in the SAME <seg id="N">...</seg> tags with matching IDs.
3. Translate EVERY segment. Do not skip or merge segments.
4. Maintain style, tone, and formatting within each segment.
5. Do NOT wrap in quotes unless the source has them.
6. If the user message includes a GLOSSARY, use its exact translations for those terms — but only when the term actually appears in the segment; never insert unrelated glossary terms.
7. If the user message includes a STYLE GUIDE, follow its narration, register, and character-voice notes strictly.
8. Output ONLY the translated segments with their tags, nothing else.
9. NEVER leave ${sourceLang} words in the output, except for proper nouns with no standard ${targetLang} translation. Translate every word into ${targetLang}.`;
}

/** Static system prompt for single-text translation. */
export function translatorSingleSystem(
  sourceLang: string,
  targetLang: string
): string {
  return `You are a professional literary translator. Translate the following ${sourceLang} text to ${targetLang}.

**CRITICAL RULES:**
1. Return ONLY the translation of the text inside <translate> tags.
2. Do NOT wrap in quotes unless the source has them.
3. Maintain style, tone, and formatting.
4. If the user message includes a GLOSSARY, use its exact translations for those terms — but only when the term actually appears in the text; never insert unrelated glossary terms.
5. If the user message includes a STYLE GUIDE, follow its narration, register, and character-voice notes strictly.
6. Output ONLY the translated text.
7. NEVER leave ${sourceLang} words in the output, except for proper nouns with no standard ${targetLang} translation. If a word is difficult to translate, find the closest natural expression.`;
}

/** User prompt for batched translation: static preamble + tagged segments. */
export function translatorBatchUser(
  ctx: StaticPromptContext,
  taggedInput: string
): string {
  return `${buildStaticPreamble(ctx)}${taggedInput}`;
}

/** User prompt for single-text translation: static preamble + optional context + text. */
export function translatorSingleUser(
  ctx: StaticPromptContext,
  text: string,
  context?: string[]
): string {
  const contextStr = context?.length
    ? `<context>\n${context.join('\n')}\n</context>\n\n`
    : '';
  return `${buildStaticPreamble(ctx)}${contextStr}<translate>\n${text}\n</translate>`;
}

/**
 * User prompt for retranslating a single segment that failed review.
 * Adapted from wenyi's TRANSLATOR_FIX_USER: the reviewer feedback is included
 * and must be addressed by the new translation.
 */
export function translatorFixUser(
  ctx: StaticPromptContext,
  source: string,
  badTranslation: string,
  feedback: string
): string {
  return `${buildStaticPreamble(ctx)}**REVIEW FEEDBACK (the previous translation had these problems; the new translation MUST fix them):**
- ${feedback}

**PREVIOUS (flawed) TRANSLATION:**
${badTranslation}

<translate>
${source}
</translate>`;
}

// ── Style analysis (wenyi ANALYZER) ────────────────────────────────────────

/**
 * Static system prompt for pre-translation style analysis of sample passages.
 * Adapted from wenyi's ANALYZER_SYSTEM: produces a style guide + character
 * voice notes that every later translation call follows.
 */
export function styleAnalyzerSystem(
  sourceLang: string,
  targetLang: string
): string {
  return `You are the pre-translation analyst for a novel translation project (${sourceLang} → ${targetLang}).
Read the sample passages and produce baseline guidance that all translators must follow for consistency.
Write all values in ${targetLang} except "source" fields, which stay in ${sourceLang}.
Return ONLY a JSON object:
{
  "genre": "genre",
  "tone": "overall tone/register (e.g. hardboiled first-person, lyrical third-person)",
  "narration": "narrative person and tense",
  "register": "formality level (literary/colloquial/mixed)",
  "dialogue_style": "dialogue conventions: speech habits, honorifics, address forms",
  "style_guide": ["3-6 concrete rules for the translator"],
  "characters": [{"source": "name in source text", "target": "suggested ${targetLang} rendering", "gender": "male/female/unknown", "note": "personality and speech style: self-reference, verbal tics, formality"}]
}`;
}

export function styleAnalyzerUser(
  samples: Array<{ position: string; text: string }>
): string {
  const body = samples
    .map((s) => `[sample from ${s.position}]\n${s.text}`)
    .join('\n\n');
  return `${body}

Analyze the samples above and output the JSON object. Samples may come from the beginning, middle, and end of the book — judge the overall style and its evolution.`;
}

/** Render a parsed style guide into the prompt block injected into translations. */
export interface StyleGuide {
  genre?: string;
  tone?: string;
  narration?: string;
  register?: string;
  dialogue_style?: string;
  style_guide?: string[];
  characters?: Array<{
    source?: string;
    target?: string;
    gender?: string;
    note?: string;
  }>;
}

export function formatStyleGuide(sg: StyleGuide): string {
  const lines: string[] = [];
  if (sg.genre) lines.push(`Genre: ${sg.genre}`);
  if (sg.tone) lines.push(`Tone: ${sg.tone}`);
  if (sg.narration) lines.push(`Narration: ${sg.narration}`);
  if (sg.register) lines.push(`Register: ${sg.register}`);
  if (sg.dialogue_style) lines.push(`Dialogue: ${sg.dialogue_style}`);
  for (const rule of sg.style_guide ?? []) lines.push(`- ${rule}`);
  const chars = (sg.characters ?? []).filter((c) => c.source);
  if (chars.length > 0) {
    lines.push('Characters:');
    for (const c of chars.slice(0, 20)) {
      const bits = [c.target, c.gender, c.note].filter(Boolean).join('; ');
      lines.push(`  - ${c.source}: ${bits}`);
    }
  }
  return lines.join('\n');
}

// ── Book understanding (wenyi CHAPTER_DIGEST / BOOK_SYNOPSIS) ──────────────

/**
 * Static system prompt for per-chapter digests.
 * Adapted from wenyi's CHAPTER_DIGEST_SYSTEM (≤200 chars per chapter).
 */
export function chapterDigestSystem(
  sourceLang: string,
  targetLang: string
): string {
  return `You summarize novel chapters for a translation project. Read the given ${sourceLang} chapter and write its digest in ${targetLang}, at most 100 words (or 200 characters for CJK):
cover the key plot developments, which characters appear and their situation, and any important reveals or turning points. Omit minor details. Output ONLY the digest text, no headers or explanations.`;
}

export function chapterDigestUser(chapterText: string): string {
  return chapterText;
}

/**
 * Static system prompt for the whole-book synopsis, synthesized from chapter
 * digests. Adapted from wenyi's BOOK_SYNOPSIS_SYSTEM: gives the translator a
 * global view (plot arc, character arcs, setups/payoffs) before translating
 * chapter 1, so early wording doesn't conflict with later developments.
 */
export function bookSynopsisSystem(targetLang: string): string {
  return `You write a book overview for a translation project, in ${targetLang}, at most 250 words (or 500 characters for CJK).
Based on the chapter digests, cover: the main plot arc and how it resolves, the main characters with their relationships and arcs, core setting/mysteries/important foreshadowing, and the overall tone.
The overview is read by a translator before translating any chapter, so it must give the global picture. Output ONLY the overview text, no headers, lists, or explanations.`;
}

export function bookSynopsisUser(
  digests: Array<{ chapter: number; digest: string }>
): string {
  const body = digests
    .map((d) => `[Chapter ${d.chapter}] ${d.digest}`)
    .join('\n');
  return `Chapter digests:\n${body}\n\nWrite the book overview.`;
}

// ── Review (wenyi REVIEWER) ────────────────────────────────────────────────

/**
 * Static system prompt for the chapter-end review pass.
 * Adapted from wenyi's REVIEWER_SYSTEM, including its restraint rule:
 * only report definite, substantive errors; when unsure, do not report.
 */
export function reviewerSystem(sourceLang: string, targetLang: string): string {
  return `You are a strict translation reviewer. Compare each ${sourceLang} source segment with its ${targetLang} translation and report only DEFINITE problems. Problem types:
- missing: information present in the source is absent from the translation
- added: the translation invents information not present in the source
- mistranslation: the translation misreads the source meaning
- terminology: a term that appears in this batch's source has a fixed rendering in the GLOSSARY, but the translation does not use it (the glossary is a book-wide reference and may list terms not in this batch; only judge terms that actually appear here)
- pronoun: wrong person/gender pronoun

Report ONLY substantive errors: reasonable reordering, natural free translation, and stylistic polish are NOT problems — do not report them.
If you are not sure something is an error, do NOT report it. Prefer missing a doubtful case over a false positive.
Each issue must include a directly usable "suggestion".
Return ONLY JSON: {"issues":[{"index": <segment number>, "type": "...", "detail": "brief description", "suggestion": "corrected translation or concrete fix"}]}
If there are no problems, return {"issues":[]}.`;
}

export function reviewerUser(
  glossaryStr: string,
  pairs: Array<{ index: number; source: string; translated: string }>
): string {
  const body = pairs
    .map(
      (p) =>
        `[${p.index}] SOURCE: ${p.source}\n    TRANSLATION: ${p.translated}`
    )
    .join('\n');
  const glossaryBlock = glossaryStr ? `${glossaryStr.trim()}\n\n` : '';
  return `${glossaryBlock}**SEGMENT PAIRS (${pairs.length} segments):**\n${body}\n\nReview and return JSON: {"issues":[...]}.`;
}

// ── Incremental glossary extraction (wenyi GLOSSARY_EXTRACTOR) ─────────────

/**
 * Static system prompt for post-chapter glossary extraction.
 * Adapted from wenyi's GLOSSARY_EXTRACTOR_SYSTEM, simplified to ovid's flat
 * source→target glossary map: extract proper nouns from the chapter's actual
 * source/translation pairs so mid-book characters and places enter the
 * glossary as soon as they first appear, instead of only what the one-shot
 * pre-scan sampled.
 */
export function glossaryExtractorSystem(
  sourceLang: string,
  targetLang: string
): string {
  return `You maintain the proper-noun glossary of a novel translation project (${sourceLang} → ${targetLang}).
From the given source text and its actual translation, extract NEW glossary entries: people, places, organizations, in-world terms, nicknames and forms of address that need book-wide consistency.
Rules:
1. The "target" value must be the rendering actually used in the given translation — do not invent new renderings.
2. Do NOT repeat entries already present in the EXISTING GLOSSARY (they are provided for reference; reuse their renderings when translating is handled elsewhere).
3. Only extract terms that actually appear in the given text. Skip common words, one-off rhetoric, and generic phrases.
Return ONLY a JSON object mapping source terms to ${targetLang} renderings, e.g. {"Whymper": "温珀"}. Return {} if there is nothing new.`;
}

export function glossaryExtractorUser(
  existingGlossaryStr: string,
  sourceText: string,
  translatedText: string
): string {
  return `**EXISTING GLOSSARY (do not repeat these):**
${existingGlossaryStr || '(empty)'}

**SOURCE:**
${sourceText}

**TRANSLATION:**
${translatedText}

Extract new entries as a JSON object.`;
}
