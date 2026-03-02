/**
 * Endnote Extractor for EPUB files
 * 
 * Detects endnote/notes pages in EPUBs and extracts structured annotation data.
 * Handles common patterns:
 * 1. Calibre-style: separate HTML file with "Notes" heading, numbered entries linking back to text
 * 2. EPUB3 semantic: epub:type="footnote" / epub:type="noteref" (future)
 * 3. Aside-based: <aside> elements with notes (future)
 * 
 * Output: a map of anchor IDs → note content, plus info about which HTML files are endnote pages.
 */

import { DOMParser } from '@xmldom/xmldom';

export interface EndnoteEntry {
  /** The anchor ID in the notes page that the text links to (e.g. "id_p277") */
  anchorId: string;
  /** The note number/label (e.g. "20", "21") */
  label: string;
  /** Plain text content of the note */
  text: string;
  /** HTML content of the note (for rich display) */
  html: string;
  /** Link back to the source text (href from the backlink <a>) */
  backRef?: string;
  /** Chapter/section heading this note belongs to */
  section?: string;
}

export interface EndnotePageInfo {
  /** The HTML file path within the EPUB */
  filePath: string;
  /** All endnote entries found on this page */
  entries: EndnoteEntry[];
}

export interface NoteRefInText {
  /** The anchor ID in the source text where the note reference appears */
  sourceAnchorId?: string;
  /** The target anchor in the notes page */
  targetAnchorId: string;
  /** The notes page file path */
  targetFile: string;
  /** The display label (e.g. "20") */
  label: string;
}

export interface EndnoteExtractionResult {
  /** Files identified as endnote pages (should be excluded from normal chapter rendering) */
  endnotePages: EndnotePageInfo[];
  /** Map from notes-page anchor ID to the full note entry */
  notesByAnchor: Map<string, EndnoteEntry>;
  /** Note references found in text chapters, keyed by "file#anchorId" of the target */
  noteRefs: NoteRefInText[];
}

/**
 * Detect whether an HTML file is likely an endnotes/notes page.
 * Heuristics:
 * - Has a heading containing "Notes", "Endnotes", "Footnotes", "注释", "尾注"
 * - Most paragraphs start with a link that points back to other chapters
 * - High ratio of back-links to total paragraphs
 */
export function isEndnotePage(html: string, fileName: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc) return false;

  const body = doc.getElementsByTagName('body')[0];
  if (!body) return false;

  // Check headings and prominent text for "Notes" indicators
  const noteIndicators = [
    'notes', 'endnotes', 'footnotes', 'bibliography',
    '注释', '尾注', '脚注', '参考文献', '注釈'
  ];

  let hasNoteHeading = false;

  // Check h1-h3 and first prominent <p> elements
  for (const tag of ['h1', 'h2', 'h3', 'p']) {
    const elements = doc.getElementsByTagName(tag);
    for (let i = 0; i < Math.min(elements.length, 3); i++) {
      const text = (elements[i].textContent || '').trim().toLowerCase();
      if (text.length < 30 && noteIndicators.some(ind => text.includes(ind))) {
        hasNoteHeading = true;
        break;
      }
    }
    if (hasNoteHeading) break;
  }

  if (!hasNoteHeading) return false;

  // Count paragraphs that start with a link pointing to other files (back-references)
  const paragraphs = doc.getElementsByTagName('p');
  let totalP = 0;
  let backLinkP = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const text = (p.textContent || '').trim();
    if (text.length < 3) continue;
    totalP++;

    // Check if paragraph starts with an <a> linking to another file
    const links = p.getElementsByTagName('a');
    if (links.length > 0) {
      const href = links[0].getAttribute('href') || '';
      // Back-link: points to a different HTML file (not the current notes page)
      const targetFile = href.split('#')[0];
      if (targetFile && !fileName.endsWith(targetFile)) {
        backLinkP++;
      }
    }
  }

  // If most paragraphs have back-links, it's likely a notes page
  return totalP >= 3 && backLinkP / totalP >= 0.4;
}

/**
 * Extract endnote entries from a confirmed notes page.
 * Handles multi-paragraph notes (e.g. note text + URL on next line) by merging
 * continuation paragraphs into the previous entry.
 */
export function extractEndnotes(html: string, fileName: string): EndnoteEntry[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc) return [];

  const body = doc.getElementsByTagName('body')[0];
  if (!body) return [];

  const entries: EndnoteEntry[] = [];
  let currentSection = '';

  const paragraphs = doc.getElementsByTagName('p');

  // Helper: check if a paragraph has a back-link to a chapter file (not external URL)
  const getChapterBackLink = (p: any): { href: string; label: string } | null => {
    const links = p.getElementsByTagName('a');
    for (let j = 0; j < links.length; j++) {
      const href = links[j].getAttribute('href') || '';
      const linkText = (links[j].textContent || '').trim();
      const targetFile = href.split('#')[0];

      // Must point to another internal file (not http, not self)
      if (targetFile && !targetFile.startsWith('http') && !fileName.endsWith(targetFile)) {
        const numMatch = linkText.match(/^(\d+)/);
        return { href, label: numMatch ? numMatch[1] : '' };
      }
    }
    return null;
  };

  // Helper: check if paragraph is a continuation (URL-only or no chapter back-link)
  const isContinuation = (p: any): boolean => {
    const text = (p.textContent || '').trim();
    if (!text) return false;

    const backLink = getChapterBackLink(p);
    if (backLink) return false; // Has a chapter back-link → new entry

    // Check if it's a section heading
    const className = (p.getAttribute('class') || '').toLowerCase();
    if (className.includes('block_11') || className.includes('heading')) return false;
    if (text.length < 80 && (/^\d+\./.test(text) || /^(chapter|part|section)\s/i.test(text))) return false;

    return true; // No chapter back-link → continuation of previous entry
  };

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const text = (p.textContent || '').trim();
    if (!text) continue;

    const className = (p.getAttribute('class') || '').toLowerCase();

    // Check for section heading
    const backLink = getChapterBackLink(p);
    if (!backLink) {
      // No chapter back-link — could be section heading or continuation
      if (text.length < 80 && (
        /^\d+\./.test(text) ||
        /^(chapter|part|section)\s/i.test(text) ||
        className.includes('block_11') || className.includes('heading')
      )) {
        currentSection = text;
        continue;
      }

      // Continuation paragraph — merge into previous entry
      if (entries.length > 0 && isContinuation(p)) {
        const prev = entries[entries.length - 1];
        prev.text += ' ' + text;
        prev.html += ' ' + getInnerHtmlSimple(p);
        continue;
      }

      // No back-link and no previous entry to merge into — skip
      continue;
    }

    // New note entry with chapter back-link
    let anchorId = '';

    // Get anchor ID from paragraph id, span ids, or link ids
    const pId = p.getAttribute('id');
    if (pId) anchorId = pId;

    if (!anchorId) {
      const spans = p.getElementsByTagName('span');
      for (let j = 0; j < spans.length; j++) {
        const spanId = spans[j].getAttribute('id');
        if (spanId) { anchorId = spanId; break; }
      }
    }

    if (!anchorId) {
      const links = p.getElementsByTagName('a');
      for (let j = 0; j < links.length; j++) {
        const linkId = links[j].getAttribute('id') || links[j].getAttribute('name');
        if (linkId) { anchorId = linkId; break; }
      }
    }

    // Extract note text (strip the label number from the beginning)
    let noteText = text;
    if (backLink.label) {
      const labelIndex = noteText.indexOf(backLink.label);
      if (labelIndex >= 0 && labelIndex < 5) {
        noteText = noteText.substring(labelIndex + backLink.label.length).trim();
      }
    }

    entries.push({
      anchorId,
      label: backLink.label || `${entries.length + 1}`,
      text: noteText,
      html: getInnerHtmlSimple(p),
      backRef: backLink.href,
      section: currentSection || undefined,
    });
  }

  return entries;
}

/**
 * Scan text chapters for note references (links pointing to endnote pages).
 */
export function findNoteRefsInHTML(
  html: string,
  sourceFileName: string,
  endnoteFileNames: Set<string>
): NoteRefInText[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc) return [];

  const refs: NoteRefInText[] = [];
  const links = doc.getElementsByTagName('a');

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const href = link.getAttribute('href') || '';
    if (!href) continue;

    const [targetFile, targetAnchor] = href.split('#');
    
    // Check if this link points to an endnote page
    const resolvedTarget = targetFile || sourceFileName;
    const isEndnoteLink = endnoteFileNames.has(resolvedTarget) || 
      Array.from(endnoteFileNames).some(f => f.endsWith(targetFile) || targetFile.endsWith(f.split('/').pop() || ''));

    if (!isEndnoteLink) continue;

    // Extract the note label from link text
    const linkText = (link.textContent || '').trim();
    const numMatch = linkText.match(/(\d+)/);
    
    if (numMatch) {
      // Check for source anchor ID
      const sourceId = link.getAttribute('id') || link.getAttribute('name');
      const parentId = link.parentElement?.getAttribute('id');

      refs.push({
        sourceAnchorId: sourceId || parentId || undefined,
        targetAnchorId: targetAnchor || '',
        targetFile: resolvedTarget,
        label: numMatch[1],
      });
    }
  }

  return refs;
}

/**
 * Simple innerHTML extraction for xmldom.
 */
function getInnerHtmlSimple(node: any): string {
  let html = '';
  const children = node.childNodes;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) { // TEXT_NODE
        html += child.textContent || '';
      } else if (child.nodeType === 1) { // ELEMENT_NODE
        const tagName = (child.nodeName || 'span').toLowerCase();
        let attrs = '';
        if (child.attributes) {
          for (let j = 0; j < child.attributes.length; j++) {
            const attr = child.attributes[j];
            attrs += ` ${attr.name}="${attr.value}"`;
          }
        }
        const selfClosing = new Set(['br', 'hr', 'img']);
        if (selfClosing.has(tagName)) {
          html += `<${tagName}${attrs}/>`;
        } else {
          html += `<${tagName}${attrs}>${getInnerHtmlSimple(child)}</${tagName}>`;
        }
      }
    }
  }
  return html;
}
