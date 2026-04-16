/**
 * Lightweight source-language detection.
 *
 * Uses Unicode-range heuristics over a sample of the book text. Only returns
 * codes we actually support as target languages. The result is meant to seed
 * a user-facing picker — the user can override if wrong.
 */

const SAMPLE_CHARS = 20000;

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export function detectLanguage(texts: string[]): string {
  let sample = '';
  for (const t of texts) {
    if (sample.length >= SAMPLE_CHARS) break;
    sample += ' ' + t;
  }
  sample = sample.slice(0, SAMPLE_CHARS);

  const han = countMatches(sample, /[\u4e00-\u9fff]/g);
  const hiragana = countMatches(sample, /[\u3040-\u309f]/g);
  const katakana = countMatches(sample, /[\u30a0-\u30ff]/g);
  const hangul = countMatches(
    sample,
    /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g
  );
  const cyrillic = countMatches(sample, /[\u0400-\u04ff]/g);

  if (hangul > 50) return 'ko';
  if (hiragana + katakana > 50) return 'ja';
  if (han > 50) return 'zh';
  if (cyrillic > 50) return 'ru';

  // Latin-based: choose among es/fr/de/en by diacritic frequency.
  const es = countMatches(sample, /[ñáéíóúÁÉÍÓÚÑ¿¡]/g);
  const fr = countMatches(sample, /[çàâæèêëîïôùûüÿœÇÀÂÆÈÊËÎÏÔÙÛÜŸŒ]/g);
  const de = countMatches(sample, /[äöüÄÖÜß]/g);

  const scores: Array<[string, number]> = [
    ['es', es],
    ['fr', fr],
    ['de', de],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [top, topScore] = scores[0];
  if (topScore >= 10) return top;

  return 'en';
}
