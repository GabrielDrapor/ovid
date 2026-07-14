/**
 * Book parsing for Railway service.
 * Ported from src/utils/book-processor.ts — parsing only, no translation.
 * Runs in Node.js (not CF Worker) so no CPU time limits.
 */

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

// ---- Types (mirrored from book-processor.ts) ----

export interface ContentItemV2 {
  xpath: string;
  text: string;
  html: string;
  orderIndex: number;
}

export interface ChapterV2 {
  number: number;
  title: string;
  originalTitle: string;
  rawHtml: string;
  textNodes: ContentItemV2[];
}

export interface EpubImage {
  zipPath: string;
  filename: string;
  mediaType: string;
  data: Uint8Array;
}

export interface BookDataV2 {
  title: string;
  originalTitle: string;
  author: string;
  language: string;
  chapters: ChapterV2[];
  styles?: string;
  images?: EpubImage[];
  coverImage?: EpubImage;
}

// ---- Helpers ----

/** Collapse ./ and ../ segments in a zip path for reliable matching. */
function normalizeZipPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function getFullTextContent(node: any): string {
  let text = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) text += child.textContent || '';
      else if (child.nodeType === 1) text += getFullTextContent(child);
    }
  }
  return text;
}

/**
 * Like getFullTextContent, but skips note-reference links (superscript
 * footnote labels rewritten to `a[data-ov-note]`). Used for the `text` sent
 * to translation, so stray "1"/"[23]" markers don't pollute LLM input. The
 * labels stay in `html`/raw_html, where the reader renders them tappable.
 */
function getTranslatableTextContent(node: any): string {
  let text = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) text += child.textContent || '';
      else if (child.nodeType === 1) {
        if (
          (child.nodeName || '').toLowerCase() === 'a' &&
          child.getAttribute?.('data-ov-note')
        )
          continue;
        text += getTranslatableTextContent(child);
      }
    }
  }
  return text;
}

function serializeNode(node: any): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';

  const tagName = (node.nodeName || 'div').toLowerCase();

  let inner = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      inner += serializeNode(children[i]);
    }
  }

  // <a> policy: keep external http(s) links, resolved internal links
  // (rewritten to data-ov-chapter/data-ov-xpath by rewriteInternalLinks),
  // and named anchors that are jump targets. Everything else — internal
  // links we couldn't resolve — unwraps to its inner content, matching the
  // old behavior for genuinely dead links.
  if (tagName === 'a') {
    const href = node.getAttribute?.('href');
    const keep =
      node.getAttribute?.('data-ov-chapter') ||
      node.getAttribute?.('id') ||
      node.getAttribute?.('name') ||
      (href && href.startsWith('http'));
    if (!keep) return inner;
  }

  let attrs = '';
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes[i];
      attrs += ` ${attr.name}="${attr.value}"`;
    }
  }

  const selfClosing = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
  if (selfClosing.has(tagName)) return `<${tagName}${attrs}/>`;

  return `<${tagName}${attrs}>${inner}</${tagName}>`;
}

function getInnerHtml(node: any): string {
  let html = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) html += child.textContent || '';
      else if (child.nodeType === 1) html += serializeNode(child);
    }
  }
  return html;
}

// ---- Chapter parsing ----

const blockTags = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'td',
  'th',
  'dt',
  'dd',
  'figcaption',
  'article',
  'section',
  'table',
  'tr',
  'tbody',
  'thead',
  'tfoot',
  // EPUB3 popup footnotes live in <aside epub:type="footnote">, often as
  // bare text without a <p> wrapper — treat aside as a block so that text
  // is extracted (and translated) instead of silently dropped.
  'aside',
]);

const skipTags = new Set([
  'script',
  'style',
  'noscript',
  'head',
  'meta',
  'link',
]);

/**
 * Some EPUBs (notably Paul Graham essays) put a whole article inside a single
 * leaf block such as `<td>` or `<font>` and separate paragraphs with `<br><br>`.
 * Without intervention this becomes one giant text node that:
 *   - exceeds LLM context for translation (gets truncated or fails entirely), and
 *   - renders translated output as a wall of text (no visible paragraph breaks).
 *
 * Walk leaf blocks and, when a `<br><br>` (or longer) run is found, split the
 * block's flattened content into multiple `<p>` siblings. Inline formatting is
 * lost during the split — acceptable because the source already uses `<br>` for
 * structure, so there is no semantic markup to preserve.
 */
function splitBrSeparatedParagraphs(body: any, doc: any) {
  const hasBlockDescendant = (node: any): boolean => {
    const children = node.childNodes;
    if (!children) return false;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType !== 1) continue;
      const tag = (child.nodeName || '').toLowerCase();
      if (skipTags.has(tag)) continue;
      if (blockTags.has(tag)) return true;
      if (hasBlockDescendant(child)) return true;
    }
    return false;
  };

  const splitLeafBlock = (block: any) => {
    // Flatten descendants into a sequence of (text|br) tokens
    type Token = { kind: 'text'; text: string } | { kind: 'br' };
    const tokens: Token[] = [];
    const collect = (node: any) => {
      const children = node.childNodes;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 3) {
          const t = child.textContent || '';
          if (t.length > 0) tokens.push({ kind: 'text', text: t });
        } else if (child.nodeType === 1) {
          const tag = (child.nodeName || '').toLowerCase();
          if (skipTags.has(tag)) continue;
          if (tag === 'br') tokens.push({ kind: 'br' });
          else collect(child);
        }
      }
    };
    collect(block);

    // Group tokens, splitting on runs of 2+ <br> (interleaved whitespace allowed)
    const groups: string[][] = [[]];
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.kind === 'br') {
        // Count consecutive br/whitespace
        let j = i;
        let brCount = 0;
        while (j < tokens.length) {
          const t = tokens[j];
          if (t.kind === 'br') {
            brCount++;
            j++;
          } else if (t.kind === 'text' && !t.text.trim()) j++;
          else break;
        }
        if (brCount >= 2) {
          groups.push([]);
        } else {
          // single soft line break — treat as space
          groups[groups.length - 1].push(' ');
        }
        i = j;
      } else {
        groups[groups.length - 1].push(tok.text);
        i++;
      }
    }

    const paragraphs = groups
      .map((g) => g.join('').replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0);
    if (paragraphs.length < 2) return; // nothing useful to split

    while (block.firstChild) block.removeChild(block.firstChild);
    for (const para of paragraphs) {
      const p = doc.createElement('p');
      p.appendChild(doc.createTextNode(para));
      block.appendChild(p);
    }
  };

  const walk = (node: any) => {
    if (!node || node.nodeType !== 1) return;
    const tag = (node.nodeName || '').toLowerCase();
    if (skipTags.has(tag)) return;

    if (blockTags.has(tag) && !hasBlockDescendant(node)) {
      splitLeafBlock(node);
      return;
    }

    const children = Array.from(node.childNodes as any[]);
    for (const child of children) walk(child);
  };
  walk(body);
}

/**
 * Browsers auto-insert a `<tbody>` whenever a `<table>` has `<tr>` direct
 * children, but @xmldom/xmldom does not. That mismatch makes every stored
 * XPath under a `<table>` (e.g. `/body/table/tr/td/p`) fail to resolve in
 * the reader, which walks the browser DOM and produces
 * `/body/table/tbody/tr/td/p`.
 *
 * Normalize at parse time by wrapping bare `<tr>` children in an explicit
 * `<tbody>`. After this both `raw_html` and the XPaths stored in
 * `text_nodes_json` contain the same `<tbody>` segment the browser will see.
 */
function normalizeTableBodies(body: any, doc: any) {
  const tables = body.getElementsByTagName('table');
  // Snapshot first — wrapping children mutates the live HTMLCollection.
  const tableList: any[] = [];
  for (let i = 0; i < tables.length; i++) tableList.push(tables[i]);

  for (const table of tableList) {
    const children = Array.from(table.childNodes as any[]);
    // Already has a tbody (or thead/tfoot) wrapping its rows — leave it alone.
    const hasSectionChild = children.some(
      (c: any) =>
        c.nodeType === 1 &&
        ['tbody', 'thead', 'tfoot'].includes((c.nodeName || '').toLowerCase())
    );
    if (hasSectionChild) continue;

    const looseRows = children.filter(
      (c: any) => c.nodeType === 1 && (c.nodeName || '').toLowerCase() === 'tr'
    );
    if (looseRows.length === 0) continue;

    const tbody = doc.createElement('tbody');
    for (const row of looseRows) {
      table.removeChild(row);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
  }
}

const hasChildBlockElements = (node: any): boolean => {
  const children = node.childNodes;
  if (!children) return false;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 1) {
      const childTag = (child.nodeName || '').toLowerCase();
      if (blockTags.has(childTag)) return true;
    }
  }
  return false;
};

/**
 * DFS over the body visiting every leaf block element (a block tag with no
 * block children) with its computed XPath. This is THE canonical walk: text
 * extraction, anchor mapping and the reader's own DOM walk must all agree on
 * it, or stored XPaths stop resolving.
 */
function walkBlockLeaves(body: any, cb: (node: any, xpath: string) => void) {
  const visit = (node: any, pathSegments: string[]) => {
    if (!node || node.nodeType !== 1) return;

    const tagName = (node.nodeName || '').toLowerCase();
    if (skipTags.has(tagName)) return;

    let elementIndex = 1;
    let sibling = node.previousSibling;
    while (sibling) {
      if (
        sibling.nodeType === 1 &&
        (sibling.nodeName || '').toLowerCase() === tagName
      )
        elementIndex++;
      sibling = sibling.previousSibling;
    }

    const currentPath = [...pathSegments, `${tagName}[${elementIndex}]`];

    if (blockTags.has(tagName)) {
      if (hasChildBlockElements(node)) {
        const children = node.childNodes;
        if (children) {
          for (let i = 0; i < children.length; i++)
            visit(children[i], currentPath);
        }
        return;
      }
      cb(node, '/' + currentPath.join('/'));
      return;
    }

    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) visit(children[i], currentPath);
    }
  };

  const bodyChildren = body.childNodes;
  for (let i = 0; i < bodyChildren.length; i++) {
    visit(bodyChildren[i], ['body[1]']);
  }
}

function extractTextNodes(body: any): ContentItemV2[] {
  const textNodes: ContentItemV2[] = [];
  let orderIndex = 0;
  walkBlockLeaves(body, (node, xpath) => {
    const fullText = decodeEntities(getTranslatableTextContent(node));
    if (fullText.length >= 2) {
      textNodes.push({
        xpath,
        text: fullText,
        html: getInnerHtml(node),
        orderIndex: orderIndex++,
      });
    }
  });
  return textNodes;
}

function extractHeadingTitle(doc: any): string {
  const h1 = doc.getElementsByTagName('h1')[0];
  const h2 = doc.getElementsByTagName('h2')[0];
  const h3 = doc.getElementsByTagName('h3')[0];
  if (h1?.textContent?.trim()) return h1.textContent.trim();
  if (h2?.textContent?.trim()) return h2.textContent.trim();
  if (h3?.textContent?.trim()) return h3.textContent.trim();
  return '';
}

/**
 * A short block is only usable as a derived title if it doesn't read like
 * running prose: dialogue openers (quotes) and sentence punctuation are
 * disqualifying \u2014 CJK novels open chapters with short dialogue lines that
 * used to get glued together into nonsense titles.
 */
function isHeadingLikeText(text: string): boolean {
  if (/^[\u201c\u201d"'\u2018\u300c\u300e\u3008\u300a\uff08(]/.test(text))
    return false;
  if (/[\u3002\uff1f\uff01?!]/.test(text)) return false;
  return true;
}

/** Derive a title from leading short blocks; '' when nothing heading-like. */
function deriveTitleFromShortBlocks(body: any): string {
  const headingParts: string[] = [];
  let stopScanning = false;
  const scanForHeadings = (parent: any) => {
    const children = parent.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      if (stopScanning || headingParts.length >= 3) return;
      const child = children[i];
      if (child.nodeType !== 1) continue;
      const tag = (child.nodeName || '').toLowerCase();
      if (skipTags.has(tag)) continue;
      if (blockTags.has(tag)) {
        if (hasChildBlockElements(child)) {
          scanForHeadings(child);
          continue;
        }
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 1 && text.length <= 50) {
          if (!isHeadingLikeText(text)) {
            stopScanning = true;
            return;
          }
          headingParts.push(text);
        } else if (text.length > 50) {
          stopScanning = true;
          return;
        }
      } else {
        scanForHeadings(child);
      }
    }
  };
  scanForHeadings(body);
  return headingParts.join(' \u2013 ');
}

function extractChapterTitle(doc: any, body: any, chapterNumber: number) {
  return (
    extractHeadingTitle(doc) ||
    deriveTitleFromShortBlocks(body) ||
    `Chapter ${chapterNumber}`
  );
}

// ---- Front/back-matter classification ----

/** OPF <guide> reference types \u2192 display names. */
const GUIDE_ROLE_NAMES: Record<string, string> = {
  cover: 'Cover',
  'title-page': 'Title Page',
  titlepage: 'Title Page',
  'copyright-page': 'Copyright',
  copyright: 'Copyright',
  dedication: 'Dedication',
  acknowledgements: 'Acknowledgments',
  acknowledgments: 'Acknowledgments',
  epigraph: 'Epigraph',
  foreword: 'Foreword',
  preface: 'Preface',
  prologue: 'Prologue',
  epilogue: 'Epilogue',
  afterword: 'Afterword',
  glossary: 'Glossary',
  bibliography: 'Bibliography',
  index: 'Index',
  colophon: 'Colophon',
  toc: 'Contents',
};

/** Filename-based fallback for common front/back-matter files. */
const MATTER_FILENAME_PATTERNS: [RegExp, string][] = [
  [/cover/i, 'Cover'],
  [/half[-_]?title/i, 'Title Page'],
  [/title[-_]?page|^title\b/i, 'Title Page'],
  [/copyright|colophon|imprint/i, 'Copyright'],
  [/dedicat/i, 'Dedication'],
  [/acknowledg/i, 'Acknowledgments'],
  [/epigraph/i, 'Epigraph'],
  [/foreword/i, 'Foreword'],
  [/preface/i, 'Preface'],
  [/prologue/i, 'Prologue'],
  [/epilogue/i, 'Epilogue'],
  [/afterword/i, 'Afterword'],
  [/appendix/i, 'Appendix'],
  [/glossary/i, 'Glossary'],
  [/biblio/i, 'Bibliography'],
  [/about[-_]?(the[-_]?)?author/i, 'About the Author'],
  [/front[-_]?matter/i, 'Front Matter'],
  [/back[-_]?matter/i, 'Back Matter'],
  [/\btoc\b|contents/i, 'Contents'],
];

function matterRoleFromFilename(normPath: string): string {
  const base = (normPath.split('/').pop() || '').replace(/\.[^.]+$/, '');
  for (const [re, name] of MATTER_FILENAME_PATTERNS) {
    if (re.test(base)) return name;
  }
  return '';
}

function serializeBodyHtml(body: any): string {
  let rawHtml = '';
  const bodyChildren = body.childNodes;
  for (let i = 0; i < bodyChildren.length; i++) {
    const child = bodyChildren[i];
    if (child.nodeType === 1) rawHtml += serializeNode(child);
    else if (child.nodeType === 3 && child.textContent?.trim())
      rawHtml += child.textContent;
  }
  return rawHtml;
}

// ---- Internal links & footnotes ----
//
// EPUB footnotes come in a handful of shapes; we resolve them all to one
// uniform representation. The main kinds in the wild:
//   1. EPUB3 semantic:  <a epub:type="noteref" href="#fn1">1</a> +
//      <aside epub:type="footnote" id="fn1">\u2026</aside> (same file, popup)
//   2. Separate endnotes file (Calibre/trade press):
//      <a href="notes.xhtml#n12">12</a>; notes page entries link back
//   3. Same-file anchors (Project Gutenberg):
//      <a id="FNanchor_1" href="#Footnote_1">[1]</a> + note block at file end
//   4. Plain cross-references / in-text TOC links (not notes, still useful)
// At parse time every internal link that resolves gets
// data-ov-chapter/data-ov-xpath (the reader jumps via loadChapter), and the
// ones classified as note references additionally get data-ov-note (the
// reader shows a popover instead of jumping).

interface AnchorTarget {
  chapter: number;
  xpath: string;
}

interface AnchorIndex {
  /** fragment id/name \u2192 xpath of the block to scroll to */
  anchors: Map<string, string>;
  /** xpath of the first non-trivial text block (chapter-start target) */
  firstBlockXpath: string | null;
  /** xpath \u2192 full plain text of that block (for note-label echo checks) */
  blockTexts: Map<string, string>;
}

/**
 * Map every id/name anchor in a file to the XPath of the block a jump should
 * land on: the containing leaf block when the anchor sits inside one,
 * otherwise the next leaf block in document order (e.g. ids on container
 * divs or bare <a id> markers between paragraphs).
 */
function buildAnchorIndex(body: any): AnchorIndex {
  const leaves: { node: any; xpath: string; text: string }[] = [];
  walkBlockLeaves(body, (node, xpath) => {
    leaves.push({
      node,
      xpath,
      text: decodeEntities(getFullTextContent(node)),
    });
  });

  const blockTexts = new Map<string, string>();
  for (const l of leaves) blockTexts.set(l.xpath, l.text);
  const firstContentLeaf = leaves.find((l) => l.text.length >= 2) || null;

  // Document-order sequence numbers for "next block after this anchor".
  const seqOf = new Map<any, number>();
  let seq = 0;
  const numberDfs = (node: any) => {
    if (!node || node.nodeType !== 1) return;
    seqOf.set(node, seq++);
    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) numberDfs(children[i]);
    }
  };
  numberDfs(body);

  const leafXpathByNode = new Map<any, string>();
  for (const l of leaves) leafXpathByNode.set(l.node, l.xpath);

  const anchors = new Map<string, string>();
  const collectIds = (node: any) => {
    if (!node || node.nodeType !== 1) return;
    const ids: string[] = [];
    const id = node.getAttribute?.('id');
    const name =
      (node.nodeName || '').toLowerCase() === 'a'
        ? node.getAttribute?.('name')
        : null;
    if (id) ids.push(id);
    if (name && name !== id) ids.push(name);

    if (ids.length > 0) {
      // Containing leaf block, if any
      let xpath: string | undefined;
      let p = node;
      while (p && p !== body) {
        const found = leafXpathByNode.get(p);
        if (found) {
          xpath = found;
          break;
        }
        p = p.parentNode;
      }
      // Otherwise the next leaf in document order (fall back to the last)
      if (!xpath) {
        const mySeq = seqOf.get(node) ?? 0;
        const next = leaves.find((l) => (seqOf.get(l.node) ?? -1) >= mySeq);
        xpath = (next || leaves[leaves.length - 1])?.xpath;
      }
      if (xpath) {
        for (const key of ids) {
          if (!anchors.has(key)) anchors.set(key, xpath);
        }
      }
    }

    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) collectIds(children[i]);
    }
  };
  collectIds(body);

  return {
    anchors,
    firstBlockXpath: firstContentLeaf?.xpath ?? null,
    blockTexts,
  };
}

const NOTES_HEADING_INDICATORS = [
  'notes',
  'endnotes',
  'footnotes',
  '\u6ce8\u91ca',
  '\u5c3e\u6ce8',
  '\u811a\u6ce8',
  '\u6ce8\u91c8',
];

/**
 * Heuristic detection of a dedicated endnotes page (Calibre-style): a
 * "Notes"-ish heading and/or most paragraphs leading with a back-link into
 * another chapter file.
 */
function detectNotesPage(body: any, filePath: string, title: string): boolean {
  const titleLower = (title || '').trim().toLowerCase();
  let hasHeading = NOTES_HEADING_INDICATORS.some(
    (ind) => titleLower.length <= 30 && titleLower.includes(ind)
  );
  if (!hasHeading) {
    outer: for (const tag of ['h1', 'h2', 'h3', 'p']) {
      const els = body.getElementsByTagName(tag);
      for (let i = 0; i < Math.min(els.length, 3); i++) {
        const text = (els[i].textContent || '').trim().toLowerCase();
        if (
          text.length > 0 &&
          text.length < 30 &&
          NOTES_HEADING_INDICATORS.some((ind) => text.includes(ind))
        ) {
          hasHeading = true;
          break outer;
        }
      }
    }
  }

  const fileName = filePath.split('/').pop() || filePath;
  const paragraphs = body.getElementsByTagName('p');
  let total = 0;
  let backLinked = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const text = (p.textContent || '').trim();
    if (text.length < 3) continue;
    total++;
    const link = p.getElementsByTagName('a')[0];
    if (!link) continue;
    const href = link.getAttribute('href') || '';
    const targetFile = href.split('#')[0];
    if (
      targetFile &&
      !targetFile.startsWith('http') &&
      !targetFile.endsWith(fileName)
    ) {
      backLinked++;
    }
  }

  const ratio = total > 0 ? backLinked / total : 0;
  return (
    (hasHeading && total >= 3 && ratio >= 0.25) || (total >= 5 && ratio >= 0.5)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Short numeric or symbol footnote label like "1", "[23]", "*", "(a)". */
const NOTE_LABEL_RE =
  /^[[(]?(\d{1,4}|[*\u2020\u2021\u00a7\u2016\u00b6#])[\])]?\.?$/;

/**
 * Resolve every internal <a href> in a chapter body to a stable
 * (chapter, xpath) coordinate and classify note references.
 * Mutates the DOM in place; must run before serialization/text extraction.
 */
function rewriteInternalLinks(opts: {
  body: any;
  filePath: string;
  anchorMap: Map<string, AnchorTarget>;
  notesFiles: Set<string>;
  blockTextByKey: Map<string, string>;
}): void {
  const { body, filePath, anchorMap, notesFiles, blockTextByKey } = opts;
  const dir = filePath.includes('/')
    ? filePath.slice(0, filePath.lastIndexOf('/') + 1)
    : '';

  const linkEls = body.getElementsByTagName('a');
  const links: any[] = [];
  for (let i = 0; i < linkEls.length; i++) links.push(linkEls[i]);

  for (const a of links) {
    const href = a.getAttribute('href');
    if (!href) continue;
    // Absolute scheme (http, mailto, \u2026) \u2014 leave to the serializer policy.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;

    const [rawPath, rawFrag] = href.split('#', 2);
    let targetPath = filePath;
    if (rawPath) {
      try {
        const decoded = decodeURIComponent(rawPath);
        targetPath = normalizeZipPath(
          decoded.startsWith('/') ? decoded.slice(1) : dir + decoded
        );
      } catch {
        continue;
      }
    }
    let frag: string | null = null;
    if (rawFrag) {
      try {
        frag = decodeURIComponent(rawFrag);
      } catch {
        frag = rawFrag;
      }
    }

    const target =
      (frag ? anchorMap.get(`${targetPath}#${frag}`) : undefined) ||
      anchorMap.get(targetPath);
    if (!target) continue; // unresolved \u2014 serializer will unwrap it

    // Classify BEFORE clobbering role below.
    const label = getFullTextContent(a).trim();
    const epubType = a.getAttribute('epub:type') || '';
    const role = a.getAttribute('role') || '';
    let isNote = /noteref/i.test(epubType) || /doc-noteref/i.test(role);
    if (!isNote && NOTE_LABEL_RE.test(label)) {
      if (targetPath !== filePath && notesFiles.has(targetPath)) {
        isNote = true;
      } else {
        // Label echo: the target block starts with the same label
        // ("12. The quote is from\u2026") \u2014 the signature of a note entry.
        const targetText =
          blockTextByKey.get(`${targetPath}#${target.xpath}`) || '';
        const core = label.replace(/[[\]().]/g, '');
        if (
          core &&
          new RegExp(`^[[(]?${escapeRegExp(core)}[\\])]?[.):\\s]`).test(
            targetText + ' '
          )
        ) {
          isNote = true;
        }
      }
    }

    a.setAttribute('data-ov-chapter', String(target.chapter));
    a.setAttribute('data-ov-xpath', target.xpath);
    if (isNote) a.setAttribute('data-ov-note', '1');
    // Drop the raw href: it can't resolve inside the SPA, and the worker's
    // legacy fallback path strips href-bearing internal links. Keep the
    // element keyboard-reachable instead.
    a.removeAttribute('href');
    a.setAttribute('tabindex', '0');
    if (!role) a.setAttribute('role', isNote ? 'doc-noteref' : 'link');
  }
}

/**
 * Mark EPUB3 footnote/endnote containers (typically <aside
 * epub:type="footnote">) so the reader can hide them from the main flow \u2014
 * their content is still extracted and translated, and surfaces through the
 * note popover.
 */
function markFootnoteAsides(body: any): void {
  const walk = (node: any) => {
    if (!node || node.nodeType !== 1) return;
    const epubType = node.getAttribute?.('epub:type') || '';
    if (
      /\b(footnote|rearnote|endnote)s?\b/i.test(epubType) &&
      !/noteref/i.test(epubType)
    ) {
      node.setAttribute('data-ov-hidden', 'note');
    }
    const children = node.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i++) walk(children[i]);
    }
  };
  walk(body);
}

function parseHTMLChapter(
  html: string,
  chapterNumber: number
): {
  title: string;
  originalTitle: string;
  rawHtml: string;
  textNodes: ContentItemV2[];
} | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.getElementsByTagName('body')[0];
  if (!body) return null;

  // Wrap loose <tr> children in <tbody> to match browser auto-insertion.
  // Must run before rawHtml serialization and the leaf walk so XPaths line
  // up with what the reader sees in the rendered DOM.
  normalizeTableBodies(body, doc);

  // Convert <br><br>-separated content inside leaf blocks into <p> siblings.
  // Must run before rawHtml serialization so the reader gets the <p> structure.
  splitBrSeparatedParagraphs(body, doc);

  const chapterTitle = extractChapterTitle(doc, body, chapterNumber);

  return {
    title: chapterTitle,
    originalTitle: chapterTitle,
    rawHtml: serializeBodyHtml(body),
    textNodes: extractTextNodes(body),
  };
}

// ---- TOC parsing ----

interface TocEntry {
  title: string;
  src: string; // file path (without fragment)
  fragment: string | null; // fragment identifier after #
}

/**
 * Parse toc.ncx to extract TOC entries.
 */
function parseNCX(ncxContent: string): TocEntry[] {
  const doc = new DOMParser().parseFromString(ncxContent, 'text/xml');
  const entries: TocEntry[] = [];

  const navPoints = doc.getElementsByTagName('navPoint');
  for (let i = 0; i < navPoints.length; i++) {
    const navPoint = navPoints[i];

    // Get navLabel > text
    const navLabels = navPoint.getElementsByTagName('navLabel');
    if (!navLabels.length) continue;
    const textEl = navLabels[0].getElementsByTagName('text')[0];
    if (!textEl?.textContent?.trim()) continue;
    const title = textEl.textContent.trim();

    // Get content@src
    const contentEl = navPoint.getElementsByTagName('content')[0];
    if (!contentEl) continue;
    const srcAttr = contentEl.getAttribute('src');
    if (!srcAttr) continue;

    const [src, fragment] = srcAttr.split('#', 2);
    entries.push({ title, src, fragment: fragment || null });
  }

  return entries;
}

/**
 * Parse nav.xhtml to extract TOC entries.
 */
function parseNavXhtml(navContent: string): TocEntry[] {
  const doc = new DOMParser().parseFromString(
    navContent,
    'application/xhtml+xml'
  );
  const entries: TocEntry[] = [];

  // Find nav element with epub:type="toc"
  const navElements = doc.getElementsByTagName('nav');
  let tocNav: any = null;
  for (let i = 0; i < navElements.length; i++) {
    const nav = navElements[i];
    // Check both epub:type and plain type attribute
    const epubType =
      nav.getAttribute('epub:type') ||
      nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type');
    if (epubType === 'toc') {
      tocNav = nav;
      break;
    }
  }
  if (!tocNav) {
    // Fallback: use first nav element
    if (navElements.length > 0) tocNav = navElements[0];
    else return entries;
  }

  // Walk ol > li > a elements
  const links = tocNav.getElementsByTagName('a');
  for (let i = 0; i < links.length; i++) {
    const a = links[i];
    const href = a.getAttribute('href');
    const title = getFullTextContent(a).replace(/\s+/g, ' ').trim();
    if (!href || !title) continue;

    const [src, fragment] = href.split('#', 2);
    entries.push({ title, src, fragment: fragment || null });
  }

  return entries;
}

/**
 * Build a map from NORMALIZED spine file path (without fragment) to TOC
 * entry title. Srcs are resolved relative to the TOC document's own
 * directory (per spec — not the OPF's), URL-decoded, and ./ ../ collapsed,
 * so entries like "../Text/ch%201.xhtml#part2" still land on the right
 * spine file. If multiple TOC entries point to the same file, the first
 * one wins.
 */
function buildTocTitleMap(
  tocEntries: TocEntry[],
  tocDir: string
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of tocEntries) {
    let src = entry.src;
    try {
      src = decodeURIComponent(src);
    } catch {
      /* keep raw */
    }
    const fullPath = normalizeZipPath(
      src.startsWith('/') ? src.substring(1) : tocDir + src
    );
    if (fullPath && !map.has(fullPath)) {
      map.set(fullPath, entry.title);
    }
  }
  return map;
}

// ---- Public API ----

/**
 * Parse an EPUB file into BookDataV2.
 */
export async function parseEPUB(
  buffer: ArrayBuffer | Buffer
): Promise<BookDataV2> {
  const zip = new JSZip();
  const zipContent = await zip.loadAsync(buffer);

  const opfFile = Object.keys(zipContent.files).find((name) =>
    name.endsWith('.opf')
  );

  let title = 'Unknown Title';
  let author = 'Unknown Author';
  let htmlFiles: string[] = [];
  let globalStyles = '';
  let imageManifestEntries: { href: string; mediaType: string }[] = [];
  let tocTitleMap = new Map<string, string>();
  const guideRoleByPath = new Map<string, string>();
  let coverHref: string | null = null;

  if (opfFile) {
    const opfContent = await zipContent.files[opfFile].async('text');
    const doc = new DOMParser().parseFromString(opfContent, 'text/xml');
    const basePath = opfFile.substring(0, opfFile.lastIndexOf('/') + 1);

    const titleElement = doc.getElementsByTagName('dc:title')[0];
    const authorElement = doc.getElementsByTagName('dc:creator')[0];
    if (titleElement?.textContent) title = titleElement.textContent.trim();
    if (authorElement?.textContent) author = authorElement.textContent.trim();

    const manifestElements = doc.getElementsByTagName('item');
    const manifestMap = new Map<string, string>();
    const manifestById = new Map<string, { href: string; mediaType: string }>();
    imageManifestEntries = [];

    let ncxHref: string | null = null;
    let navHref: string | null = null;

    for (let i = 0; i < manifestElements.length; i++) {
      const item = manifestElements[i];
      const mediaType = item.getAttribute('media-type');
      const href = item.getAttribute('href');
      const id = item.getAttribute('id');
      const properties = item.getAttribute('properties');

      if (id && href && mediaType) manifestById.set(id, { href, mediaType });

      // EPUB3 cover: <item properties="cover-image">
      if (
        properties &&
        properties.split(/\s+/).includes('cover-image') &&
        href &&
        mediaType?.startsWith('image/')
      ) {
        coverHref = href;
      }

      // Detect NCX
      if (mediaType === 'application/x-dtbncx+xml' && href) {
        ncxHref = href;
      }

      // Detect nav.xhtml
      if (properties && properties.split(/\s+/).includes('nav') && href) {
        navHref = href;
      }

      // CSS
      if (mediaType === 'text/css' && href) {
        try {
          const cssPath = basePath + href;
          const cssFile = zipContent.files[cssPath];
          if (cssFile) {
            const cssContent = await cssFile.async('text');
            globalStyles += `/* ${href} */\n${cssContent}\n`;
          }
        } catch {
          /* skip */
        }
      }

      // HTML manifest
      if (id && href && mediaType === 'application/xhtml+xml') {
        manifestMap.set(id, href);
      }

      // Images
      if (href && mediaType && mediaType.startsWith('image/')) {
        imageManifestEntries.push({ href, mediaType });
      }
    }

    // EPUB2 cover: <meta name="cover" content="{manifest-id}">
    if (!coverHref) {
      const metas = doc.getElementsByTagName('meta');
      for (let i = 0; i < metas.length; i++) {
        if (metas[i].getAttribute('name') === 'cover') {
          const cid = metas[i].getAttribute('content');
          const it = cid ? manifestById.get(cid) : undefined;
          if (it && it.mediaType.startsWith('image/')) {
            coverHref = it.href;
            break;
          }
        }
      }
    }
    // Last resort: an image whose filename looks like a cover.
    if (!coverHref) {
      const guess = imageManifestEntries.find((e) => /cover/i.test(e.href));
      if (guess) coverHref = guess.href;
    }

    // Parse TOC: prefer nav.xhtml, fall back to NCX. Srcs inside the TOC
    // document are relative to ITS directory, so remember it.
    let tocEntries: TocEntry[] = [];
    let tocDir = basePath;
    if (navHref) {
      const navPath = navHref.startsWith('/')
        ? navHref.substring(1)
        : basePath + navHref;
      const navFile = zipContent.files[navPath];
      if (navFile) {
        try {
          const navContent = await navFile.async('text');
          tocEntries = parseNavXhtml(navContent);
          tocDir = navPath.includes('/')
            ? navPath.slice(0, navPath.lastIndexOf('/') + 1)
            : '';
        } catch {
          /* skip */
        }
      }
    }
    if (tocEntries.length === 0 && ncxHref) {
      const ncxPath = ncxHref.startsWith('/')
        ? ncxHref.substring(1)
        : basePath + ncxHref;
      const ncxFile = zipContent.files[ncxPath];
      if (ncxFile) {
        try {
          const ncxContent = await ncxFile.async('text');
          tocEntries = parseNCX(ncxContent);
          tocDir = ncxPath.includes('/')
            ? ncxPath.slice(0, ncxPath.lastIndexOf('/') + 1)
            : '';
        } catch {
          /* skip */
        }
      }
    }
    if (tocEntries.length > 0) {
      tocTitleMap = buildTocTitleMap(tocEntries, tocDir);
    }

    // OPF <guide>: role names for front/back-matter files (EPUB2, still
    // widely present in EPUB3 output from Calibre etc.)
    const guideRefs = doc.getElementsByTagName('reference');
    for (let i = 0; i < guideRefs.length; i++) {
      const type = (guideRefs[i].getAttribute('type') || '').toLowerCase();
      const href = guideRefs[i].getAttribute('href');
      const roleName = GUIDE_ROLE_NAMES[type];
      if (!href || !roleName) continue;
      let src = href.split('#')[0];
      try {
        src = decodeURIComponent(src);
      } catch {
        /* keep raw */
      }
      const fullPath = normalizeZipPath(
        src.startsWith('/') ? src.substring(1) : basePath + src
      );
      if (fullPath && !guideRoleByPath.has(fullPath)) {
        guideRoleByPath.set(fullPath, roleName);
      }
    }

    // Spine order. linear="no" items are auxiliary content by spec (not part
    // of the default reading order) — don't turn them into chapters.
    const spineItems = doc.getElementsByTagName('itemref');
    for (let i = 0; i < spineItems.length; i++) {
      if (spineItems[i].getAttribute('linear') === 'no') continue;
      const idref = spineItems[i].getAttribute('idref');
      if (idref && manifestMap.has(idref)) {
        const href = manifestMap.get(idref)!;
        const fullPath = href.startsWith('/')
          ? href.substring(1)
          : basePath + href;
        htmlFiles.push(fullPath);
      }
    }
  }

  // Parse chapters in two phases so internal links can resolve across files:
  // phase 1 parses every spine file and indexes its anchors; titles and
  // junk-page skips are then assigned TOC-first, and phase 2 rewrites links
  // against the global anchor map, extracts text and serializes.
  interface PreparedFile {
    zipPath: string;
    normPath: string;
    doc: any;
    body: any;
    chapterNumber: number;
    title: string;
    index: AnchorIndex;
    isNotesPage: boolean;
    textLength: number;
    hasImages: boolean;
  }

  const prepared: PreparedFile[] = [];

  for (const htmlPath of htmlFiles) {
    const file = zipContent.files[htmlPath];
    if (!file) continue;

    const htmlContent = await file.async('text');
    const doc = new DOMParser().parseFromString(htmlContent, 'text/html');

    // Collect internal styles
    const styleTags = doc.getElementsByTagName('style');
    for (let i = 0; i < styleTags.length; i++) {
      const styleContent = styleTags[i].textContent;
      if (styleContent)
        globalStyles += `/* Internal from ${htmlPath} */\n${styleContent}\n`;
    }

    const body = doc.getElementsByTagName('body')[0];
    if (!body) continue;

    normalizeTableBodies(body, doc);
    splitBrSeparatedParagraphs(body, doc);

    const index = buildAnchorIndex(body);
    // Same inclusion rule as before: files without real text content
    // (image-only pages etc.) don't become chapters.
    if (!index.firstBlockXpath) continue;

    let textLength = 0;
    index.blockTexts.forEach((t) => {
      textLength += t.length;
    });
    const hasImages =
      body.getElementsByTagName('img').length > 0 ||
      body.getElementsByTagName('image').length > 0;

    prepared.push({
      zipPath: htmlPath,
      normPath: normalizeZipPath(htmlPath),
      doc,
      body,
      chapterNumber: 0, // assigned after title/skip resolution
      title: '',
      index,
      isNotesPage: false,
      textLength,
      hasImages,
    });
  }

  // ---- Title assignment & junk-page skips (TOC-first) ----
  //
  // When the EPUB has a usable TOC we follow it: files it references get
  // its titles; substantial files between two referenced ones are treated
  // as split-chapter continuations and inherit the preceding entry's title;
  // tiny text-only pages OUTSIDE the TOC's range (publisher ads, blank
  // filler around the actual book) are dropped. Everything else falls back
  // through guide/filename roles, headings, then a derived title — and
  // "Chapter N" only as the true last resort.
  const tocIdx = prepared.map((p, i) => (tocTitleMap.has(p.normPath) ? i : -1));
  const coveredIdx = tocIdx.filter((i) => i >= 0);
  const tocUsable = coveredIdx.length >= 2;
  const firstCovered = coveredIdx[0] ?? -1;
  const lastCovered = coveredIdx[coveredIdx.length - 1] ?? -1;

  const skipped = new Set<number>();
  let lastTocTitle = '';
  prepared.forEach((p, i) => {
    const tocTitle = tocTitleMap.get(p.normPath);
    if (tocTitle) {
      p.title = tocTitle;
      lastTocTitle = tocTitle;
      return;
    }

    // After the first TOC entry, a substantial untitled file is a
    // split-chapter continuation of the preceding entry — including the
    // trailing parts of the final chapter after the last entry.
    if (tocUsable && i > firstCovered && p.textLength >= 1500 && lastTocTitle) {
      p.title = lastTocTitle;
      return;
    }
    // Outside the TOC's range: tiny text-only pages are publisher filler
    // (ads, blank filler around the actual book), not chapters. Pages
    // with images (covers, title art) are kept.
    if (
      tocUsable &&
      (i < firstCovered || i > lastCovered) &&
      p.textLength < 300 &&
      !p.hasImages
    ) {
      skipped.add(i);
      return;
    }

    p.title =
      extractHeadingTitle(p.doc) ||
      guideRoleByPath.get(p.normPath) ||
      matterRoleFromFilename(p.normPath) ||
      deriveTitleFromShortBlocks(p.body) ||
      '';
  });

  const kept = prepared.filter((_, i) => !skipped.has(i));
  kept.forEach((p, i) => {
    p.chapterNumber = i + 1;
    if (!p.title) p.title = `Chapter ${p.chapterNumber}`;
    p.isNotesPage = detectNotesPage(p.body, p.normPath, p.title);
  });

  // Global anchor map: file → chapter start, file#fragment → exact block.
  // Built from kept files only — links into skipped filler pages stay
  // unresolved and get unwrapped by the serializer.
  const anchorMap = new Map<string, AnchorTarget>();
  const notesFiles = new Set<string>();
  const blockTextByKey = new Map<string, string>();
  for (const p of kept) {
    anchorMap.set(p.normPath, {
      chapter: p.chapterNumber,
      xpath: p.index.firstBlockXpath!,
    });
    for (const [id, xpath] of p.index.anchors) {
      anchorMap.set(`${p.normPath}#${id}`, {
        chapter: p.chapterNumber,
        xpath,
      });
    }
    if (p.isNotesPage) notesFiles.add(p.normPath);
    for (const [xpath, text] of p.index.blockTexts) {
      blockTextByKey.set(`${p.normPath}#${xpath}`, text);
    }
  }

  const chapters: ChapterV2[] = [];
  for (const p of kept) {
    rewriteInternalLinks({
      body: p.body,
      filePath: p.normPath,
      anchorMap,
      notesFiles,
      blockTextByKey,
    });
    markFootnoteAsides(p.body);

    chapters.push({
      number: p.chapterNumber,
      title: p.title,
      originalTitle: p.title,
      rawHtml: serializeBodyHtml(p.body),
      textNodes: extractTextNodes(p.body),
    });
  }

  // Extract images
  const images: EpubImage[] = [];
  const basePath = opfFile
    ? opfFile.substring(0, opfFile.lastIndexOf('/') + 1)
    : '';
  for (const entry of imageManifestEntries) {
    const imgPath = entry.href.startsWith('/')
      ? entry.href.substring(1)
      : basePath + entry.href;
    const imgFile = zipContent.files[imgPath];
    if (imgFile) {
      try {
        const data = await imgFile.async('uint8array');
        const filename = entry.href.split('/').pop() || entry.href;
        images.push({
          zipPath: imgPath,
          filename,
          mediaType: entry.mediaType,
          data,
        });
      } catch {
        /* skip */
      }
    }
  }

  // Resolve the detected cover href to one of the extracted images.
  let coverImage: EpubImage | undefined;
  if (coverHref) {
    const target = normalizeZipPath(
      coverHref.startsWith('/') ? coverHref.slice(1) : basePath + coverHref
    );
    const coverFilename = coverHref.split('/').pop();
    coverImage =
      images.find((img) => normalizeZipPath(img.zipPath) === target) ||
      images.find((img) => img.filename === coverFilename);
  }

  return {
    title,
    originalTitle: title,
    author,
    language: 'en',
    chapters,
    styles: globalStyles,
    images: images.length > 0 ? images : undefined,
    coverImage,
  };
}

/**
 * Parse a MOBI/AZW3 file into BookDataV2.
 */
export async function parseMOBI(
  buffer: ArrayBuffer | Buffer,
  fileExtension: string
): Promise<BookDataV2> {
  // Dynamic import — @lingo-reader/mobi-parser may not be installed
  let initMobiFile: any, initKf8File: any;
  try {
    // @ts-ignore — optional dependency, may not be installed
    const mod = await import('@lingo-reader/mobi-parser');
    initMobiFile = mod.initMobiFile;
    initKf8File = mod.initKf8File;
  } catch {
    throw new Error(
      'MOBI/AZW3 parsing not supported — @lingo-reader/mobi-parser not installed'
    );
  }
  const uint8 =
    buffer instanceof Buffer ? new Uint8Array(buffer) : new Uint8Array(buffer);

  const isKf8 = fileExtension === '.azw3';

  if (isKf8) {
    try {
      const parser = await initKf8File(uint8);
      const result = parseMOBIInternal(parser);
      if (result.chapters.length >= 1) return result;
      parser.destroy();
    } catch {
      /* fall through to MOBI parser */
    }
  }

  const parser = await initMobiFile(uint8);
  return parseMOBIInternal(parser);
}

function parseMOBIInternal(parser: any): BookDataV2 {
  const metadata = parser.getMetadata();
  const spine = parser.getSpine();

  const title = metadata.title || 'Unknown Title';
  const author =
    metadata.author && metadata.author.length > 0
      ? metadata.author.join(', ')
      : 'Unknown Author';

  const chapters: ChapterV2[] = [];
  let chapterNumber = 1;

  for (const spineItem of spine) {
    let loaded;
    try {
      loaded = parser.loadChapter(spineItem.id);
    } catch {
      continue;
    }
    if (!loaded) continue;

    const html = loaded.html;
    if (!html || !html.trim()) continue;

    const cleanedHtml = html.replace(
      /<a\s+[^>]*href\s*=\s*["'](?:filepos:|kindle:|#)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
      '$1'
    );

    const wrappedHtml = `<html><body>${cleanedHtml}</body></html>`;
    const chapterData = parseHTMLChapter(wrappedHtml, chapterNumber);

    if (chapterData && chapterData.textNodes.length > 0) {
      chapters.push({ ...chapterData, number: chapterNumber++ });
    }
  }

  parser.destroy();

  return {
    title,
    originalTitle: title,
    author,
    language: metadata.language || 'en',
    chapters,
    styles: '',
  };
}

/**
 * Parse any supported book format.
 */
export async function parseBook(
  buffer: ArrayBuffer | Buffer,
  fileExtension: string
): Promise<BookDataV2> {
  if (fileExtension === '.epub') return parseEPUB(buffer);
  return parseMOBI(buffer, fileExtension);
}
