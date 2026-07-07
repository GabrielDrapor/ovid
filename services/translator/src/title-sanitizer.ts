export interface LLMConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

const MAX_COVER_TITLE_CHARS = 120;

const MARKETING_CUE_RE =
  /(推荐|出品|新著|畅销|获奖|纪念版|珍藏版|修订版|完整版|完整传记|全译本|出版社|译丛|丛书|edition|kindle|illustrated|anniversary|complete|with a new|foreword|introduction|bestseller|award|winner|series|book\s+\d+|volume|vol\.|a novel|a memoir)/i;

export function normalizeTitleWhitespace(title: string): string {
  return title
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([：:，,。.!?？；;）)\]】》])/g, '$1')
    .replace(/([（(\[【《])\s+/g, '$1')
    .trim();
}

function stripOuterQuotes(title: string): string {
  let t = title.trim();
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['《', '》'],
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (t.startsWith(open) && t.endsWith(close) && t.length > 2) {
        t = t.slice(open.length, -close.length).trim();
        changed = true;
      }
    }
  }
  return t;
}

function unwrapLeadingBookMarks(title: string): string {
  const whole = title.match(/^《([^》]+)》$/u);
  if (whole) return whole[1].trim();

  const leading = title.match(/^《([^》]+)》\s*([:：]\s*)?(.+)$/u);
  if (!leading) return title;

  const rest = leading[3].trim();
  if (!rest) return leading[1].trim();
  if (/^[／/]/u.test(rest)) return `${leading[1].trim()} ${rest}`;
  return `${leading[1].trim()}：${rest}`;
}

function dropTrailingEditionSentences(title: string): string {
  return title
    .replace(
      /(?:[。.!?]\s*)?第[一二三四五六七八九十0-9]+版[^。.!?]*[。.!?]?$/u,
      ''
    )
    .replace(
      /(?:[.;]\s*)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|new|revised)\s+edition\b.*$/i,
      ''
    )
    .trim();
}

function findTrailingBracketStart(
  title: string,
  open: string,
  close: string
): number {
  if (!title.endsWith(close)) return -1;

  let depth = 0;
  for (let i = title.length - close.length; i >= 0; i--) {
    const ch = title[i];
    if (ch === close) depth++;
    if (ch === open) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return title.lastIndexOf(open);
}

function dropTrailingBracketedDescriptors(title: string): string {
  const pairs: Array<[string, string]> = [
    ['（', '）'],
    ['(', ')'],
    ['[', ']'],
    ['【', '】'],
  ];

  let t = title.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      const start = findTrailingBracketStart(t, open, close);
      if (start <= 0) continue;

      const before = t.slice(0, start).trim();
      if (!before) continue;

      // Parenthetical suffixes on catalog titles are overwhelmingly blurbs,
      // edition labels, publisher notes, or recommendation copy. For cover
      // typography, the title before that suffix is the useful signal.
      t = before;
      changed = true;
    }
  }
  return t;
}

function dropMarketingRightHandClauses(title: string): string {
  let t = title.trim();

  for (const sep of [' | ', '｜']) {
    const idx = t.indexOf(sep);
    if (idx > 0) {
      const left = t.slice(0, idx).trim();
      const right = t.slice(idx + sep.length).trim();
      if (left && (MARKETING_CUE_RE.test(right) || t.length > 80)) {
        t = left;
      }
    }
  }

  const dashMatch = t.match(/^(.+?)(?:\s+[-–—]\s+|——)(.+)$/u);
  if (dashMatch) {
    const left = dashMatch[1].trim();
    const right = dashMatch[2].trim();
    if (left && MARKETING_CUE_RE.test(right)) t = left;
  }

  return t.trim();
}

export function sanitizeBookTitleHeuristic(title: string): string {
  const original = normalizeTitleWhitespace(title);
  let t = stripOuterQuotes(original);
  t = unwrapLeadingBookMarks(t);
  t = dropTrailingBracketedDescriptors(t);
  t = dropMarketingRightHandClauses(t);
  t = dropTrailingEditionSentences(t);
  t = stripOuterQuotes(normalizeTitleWhitespace(t));
  return t || original;
}

function stripJsonFence(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return text.trim();
}

function parseLlmTitle(raw: string): string | null {
  const text = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { title?: unknown }).title === 'string'
    ) {
      return (parsed as { title: string }).title;
    }
  } catch {
    // Some OpenAI-compatible endpoints occasionally return the bare string.
  }

  if (!/[{}\n]/.test(text)) return text;
  return null;
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function latinLetterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) || []).length;
}

function dropsSubtitleBoundary(fallback: string, candidate: string): boolean {
  const markers = ['：', ':', ' / ', '/', '／'];
  const clean = normalizeTitleWhitespace(candidate);

  for (const marker of markers) {
    const idx = fallback.indexOf(marker);
    if (idx <= 0) continue;

    const left = fallback.slice(0, idx).trim();
    const right = fallback.slice(idx + marker.length).trim();
    if (!left || right.length < 2) continue;

    const candidateHasSubtitleMarker = markers.some((m) => clean.includes(m));
    if (!candidateHasSubtitleMarker && clean.length < fallback.length) {
      return true;
    }
  }

  return false;
}

function usableCandidate(
  original: string,
  fallback: string,
  candidate: string
): boolean {
  const clean = normalizeTitleWhitespace(candidate);
  if (!clean || clean.length > MAX_COVER_TITLE_CHARS) return false;
  if (clean.length > original.length + 10) return false;
  if (dropsSubtitleBoundary(fallback, clean)) return false;

  // The sanitizer must not translate titles. A shortened English title should
  // still contain Latin letters; a shortened CJK title should still contain CJK.
  if (latinLetterCount(original) >= 3 && latinLetterCount(clean) === 0) {
    return false;
  }
  if (hasCjk(original) && !hasCjk(clean)) return false;

  return true;
}

async function callTitleSanitizerLlm(
  title: string,
  fallback: string,
  config: LLMConfig
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(
      `${config.baseURL || 'https://api.openai.com/v1'}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model || 'gpt-4o-mini',
          temperature: 0.1,
          max_tokens: 120,
          messages: [
            {
              role: 'system',
              content:
                'You prepare book titles for cover and spine typography. Remove catalog clutter, edition labels, publisher slogans, recommendation blurbs, award copy, series ads, and long parenthetical descriptions, especially trailing text in parentheses/brackets. Preserve subtitles introduced by colon, full-width colon, slash, or Chinese slash unless that subtitle is itself inside trailing brackets. Do not shorten a "Title: Subtitle" or "Title / Subtitle" to only "Title". Preserve the original language and script; do not translate. Return ONLY JSON like {"title":"Clean Title"}.',
            },
            {
              role: 'user',
              content: `Original title:\n${title}\n\nRule-based fallback:\n${fallback}`,
            },
          ],
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as any;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Empty LLM response');

    const parsed = parseLlmTitle(content);
    if (!parsed) throw new Error('Unparseable LLM response');
    return sanitizeBookTitleHeuristic(parsed);
  } finally {
    clearTimeout(timeout);
  }
}

export async function sanitizeBookTitle(
  title: string,
  config?: LLMConfig
): Promise<string> {
  const original = normalizeTitleWhitespace(title);
  const fallback = sanitizeBookTitleHeuristic(original);

  if (!config?.apiKey) return fallback;

  try {
    const llmTitle = await callTitleSanitizerLlm(original, fallback, config);
    return usableCandidate(original, fallback, llmTitle) ? llmTitle : fallback;
  } catch (err) {
    console.warn('[cover] title sanitizer LLM failed:', (err as Error).message);
    return fallback;
  }
}

export function compressBookTitleForSpine(title: string): string {
  const normalized = normalizeTitleWhitespace(title);
  const markers = ['：', ':', ' / ', '／'];
  let main = normalized;

  for (const marker of markers) {
    const idx = normalized.indexOf(marker);
    if (idx <= 0) continue;

    const left = stripOuterQuotes(normalized.slice(0, idx).trim());
    const right = normalized.slice(idx + marker.length).trim();
    if (left && right.length >= 2) {
      main = left;
      break;
    }
  }

  const commaMatch = main.match(
    /^([^,]{4,36}),\s+(from|to|with|being|including|containing|or)\b/i
  );
  if (commaMatch) {
    main = commaMatch[1].trim();
  }

  const elementsMatch = main.match(/^(?:the\s+)?elements\s+of\s+(.+)$/i);
  if (elementsMatch && main.length > 28) {
    main = elementsMatch[1].trim();
  }

  return stripOuterQuotes(normalizeTitleWhitespace(main)) || normalized;
}

export const sanitizeBookTitleForCover = sanitizeBookTitle;
