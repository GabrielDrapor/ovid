/**
 * Offline corpus scan: run the high-CJK residue detector over every
 * translated segment in production, to measure flag rate, eyeball false
 * positives, and emit flagged-ids.json for a targeted backfill.
 *
 * Inputs (JSON files in the directory passed as argv[2], default cwd):
 *   translations.json  [{id, chapter_id, translated_text}]
 *       sqlite3 -json corpus.db "SELECT id, chapter_id, translated_text FROM translations_v2"
 *       (corpus.db built from: wrangler d1 export ovid-db --remote --table=translations_v2)
 *   books.json         [{id, uuid, title, language_pair}]
 *   chapters.json      [{id, book_id, chapter_number}]
 *   glossaries.json    [{id, book_id, glossary_json}]
 *       (each via: yarn db:remote -- "SELECT ...")
 *
 * The detector here must stay in sync with detectEnglishResidue in
 * services/translator/src/translate-worker.ts.
 */
import { readFileSync } from 'fs';

const S = process.argv[2] ?? '.';
const translations = JSON.parse(readFileSync(`${S}/translations.json`, 'utf-8'));
const books = JSON.parse(readFileSync(`${S}/books.json`, 'utf-8'));
const chapters = JSON.parse(readFileSync(`${S}/chapters.json`, 'utf-8'));
const glossaries = JSON.parse(readFileSync(`${S}/glossaries.json`, 'utf-8'));

const bookById = new Map(books.map(b => [b.id, b]));
const chapterById = new Map(chapters.map(c => [c.id, c]));
const glossaryByBookId = new Map();
for (const g of glossaries) {
  try { glossaryByBookId.set(g.book_id, JSON.parse(g.glossary_json)); } catch { /* */ }
}

// ---- shared helpers (mirror of translate-worker.ts) ----
function stripCitations(text) {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, ' ')
    .replace(/\b(?:[\w-]+\.)+(?:com|org|net|gov|edu|io|co|cn|jp|de|fr|uk|us|ru|au|tv|info|news|me)(?:\.[a-z]{2})?(?:\/[\w\-./?#=&%~+]*)?/gi, ' ')
    .replace(/\.(?:shtml|html?|pdf|txt|aspx?|jsp|php|csv|json|xml)\b/gi, ' ');
}

// Candidate v2: common English words that should never survive untranslated
// in high-CJK output. Deliberately excludes anything that doubles as pinyin
// (e.g. "long", "sang", "man", "can", "he", "me" are pinyin syllables or too
// short — the ≥3-char rule plus this curation keeps precision high).
const COMMON_ENGLISH = new Set((
  'about above across after again against almost along already also although always among another anyone anything anywhere around because become becomes been before behind being below between both business came cannot certain certainly change children coming completely could course does doing done during each early either enough even every everyone everything exactly example except finally first following found four from further gave general getting give given goes going gone good great group hand having head help here herself high himself history home house however hundred idea important indeed instead into itself just keep kind knew know known large last later least leave left less life like likely little longer look looked looking made make making many matter maybe mean meant might more most much must myself near need never next nothing nowhere number often once only order other others ought over own part people perhaps place point possible probably problem public put quite rather real really right room said same saw says second see seem seemed seems seen several shall should side simply since small some someone something sometimes soon still such sure taken tell than that their them themselves then there these they thing things think third this those though thought three through thus time today together told took toward turn under until upon used using very want water week well went were what when where whether which while whole whom whose will with within without word work world would year years your yourself'
  + ' altogether anyhow besides elsewhere furthermore hence henceforth meanwhile moreover '
  + 'nevertheless nonetheless otherwise somehow somewhat somewhere thereafter therefore '
  + 'throughout whatever whenever whereas wherever'
).split(/\s+/).filter(w => w.length >= 3));

/**
 * Unmistakably English inflections — no pinyin syllable can end this way, so a
 * bare lowercase token with one of these shapes inside mostly-CJK output is
 * residue even when the word is too rare to enumerate. Mirror of
 * ENGLISH_WORD_SHAPES in translate-worker.ts.
 */
const ENGLISH_WORD_SHAPES = [
  /^[a-z]{3,}ly$/,
  /^[a-z]{2,}(?:tion|sion|ment|ness|able|ible|ive|ous|ful|less|ical|istic)$/,
  /^[a-z]{4,}(?:ing|ed|al)$/,
];

const TECH_ALLOWED = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'but',
  'are', 'was', 'were', 'has', 'had', 'have', 'will', 'can', 'may',
  'app', 'web', 'api', 'url', 'http', 'https', 'www', 'html', 'css',
  'pdf', 'jpg', 'png', 'gif', 'xml', 'json', 'sql', 'seg', 'translate', 'context',
]);

/**
 * Strip quoted/parenthesized spans: quoted English is deliberate (word
 * discussions, signage, cited phrases, bracketed glosses), not residue.
 */
function stripQuotedSpans(text) {
  return text
    .replace(/“[^”]{0,120}”/g, ' ')
    .replace(/‘[^’]{0,120}’/g, ' ')
    .replace(/"[^"]{0,120}"/g, ' ')
    .replace(/'[^']{0,80}'/g, ' ')
    .replace(/（[^）]{0,120}）/g, ' ')
    .replace(/\([^)]{0,120}\)/g, ' ');
}

/** v2 check for the high-CJK branch: lowercase common-English leftovers */
function lowercaseCommonResidue(strippedIn, glossaryAllowed) {
  const stripped = stripQuotedSpans(strippedIn);
  const tokens = stripped.match(/[a-zA-Z]{3,}/g) ?? [];
  return tokens.filter(w =>
    /^[a-z]+$/.test(w) &&
    (COMMON_ENGLISH.has(w) || ENGLISH_WORD_SHAPES.some(re => re.test(w))) &&
    !TECH_ALLOWED.has(w) &&
    !glossaryAllowed.has(w)
  );
}

function glossaryAllowedSet(glossary) {
  const allowed = new Set();
  for (const [key, val] of Object.entries(glossary ?? {})) {
    for (const w of String(key).split(/\s+/)) if (w.length >= 3) allowed.add(w.toLowerCase());
    for (const w of String(val).split(/\s+/)) if (/^[a-zA-Z]{3,}$/.test(w)) allowed.add(w.toLowerCase());
  }
  return allowed;
}

// ---- scan ----
let total = 0, zhSegments = 0, highCjk = 0, flagged = 0;
const wordFreq = new Map();
const samples = [];
const flaggedIds = [];

for (const row of translations) {
  total++;
  const ch = chapterById.get(row.chapter_id);
  const book = ch ? bookById.get(ch.book_id) : null;
  if (!book || !/-zh$/.test(book.language_pair ?? '')) continue;
  zhSegments++;

  const text = row.translated_text ?? '';
  const stripped = stripCitations(text);
  const cjkCount = (stripped.match(/[　-鿿가-힯]/g) ?? []).length;
  const latinCount = (stripped.match(/[a-zA-Z]/g) ?? []).length;
  if (!(cjkCount > 0 && cjkCount / (cjkCount + latinCount) >= 0.6)) continue; // low-CJK: old detector already handles
  highCjk++;

  const glossary = glossaryByBookId.get(ch.book_id);
  const residue = lowercaseCommonResidue(stripped, glossaryAllowedSet(glossary));
  if (residue.length > 0) {
    flagged++;
    flaggedIds.push(row.id);
    for (const w of residue) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
    if (samples.length < 45) {
      const idx = text.search(new RegExp(`\\b${residue[0]}\\b`));
      const ctx = text.slice(Math.max(0, idx - 40), idx + 50).replace(/\n/g, ' ');
      samples.push({ id: row.id, book: (book.title ?? '').slice(0, 18), words: [...new Set(residue)].join(','), ctx });
    }
  }
}

console.log(`total segments:        ${total}`);
console.log(`zh-target segments:    ${zhSegments}`);
console.log(`high-CJK (v1 blind):   ${highCjk}`);
console.log(`v2 newly flagged:      ${flagged} (${(flagged / highCjk * 100).toFixed(2)}% of high-CJK, ${(flagged / zhSegments * 100).toFixed(2)}% of zh)`);
console.log(`\ntop flagged words:`);
for (const [w, n] of [...wordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${w.padEnd(12)} ${n}`);
}
console.log(`\nsamples:`);
for (const s of samples) {
  console.log(`  [${s.id}] (${s.book}) {${s.words}} …${s.ctx}…`);
}

import { writeFileSync } from 'fs';
writeFileSync(`${S}/flagged-ids.json`, JSON.stringify(flaggedIds));
console.log(`\nflagged ids written: ${flaggedIds.length}`);
