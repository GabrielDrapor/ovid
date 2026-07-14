import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getMessages, useI18n } from '../i18n';
import './BilingualReader.css';

interface Chapter {
  id: number;
  chapter_number: number;
  title: string;
  original_title: string;
  order_index: number;
}

interface Translation {
  xpath: string;
  original_text: string;
  original_html?: string; // Preserves formatting (em, i, strong, etc.)
  translated_text: string;
}

interface BilingualReaderV2Props {
  rawHtml: string;
  translations: Translation[];
  styles?: string;
  title: string;
  author: string;
  currentChapter: number;
  totalChapters: number;
  chapters: Chapter[];
  onLoadChapter: (chapterNumber: number) => void | Promise<void>;
  isLoading: boolean;
  bookUuid?: string;
  onBackToShelf?: () => void;
  // Reading status
  onMarkComplete?: (isCompleted: boolean) => Promise<void>;
  isCompleted?: boolean;
  // Sharing
  isOwner?: boolean;
  shareToken?: string | null;
  onShare?: () => Promise<void>;
  onRevokeShare?: () => Promise<void>;
  // Granular progress tracking
  initialXpath?: string; // XPath to scroll to on initial load
  onProgressChange?: (xpath: string, chapterFraction: number) => void; // Called when visible element changes; chapterFraction is 0–1
  // Show translation / show original toggle persistence
  initialShowOriginal?: boolean;
  onShowOriginalChange?: (showOriginal: boolean) => void;
  // Internal links (footnotes / cross-references rewritten by the parser to
  // a[data-ov-chapter][data-ov-xpath], optionally [data-ov-note])
  onNavigateInternal?: (chapterNumber: number, xpath: string) => void;
  fetchChapter?: (
    chapterNumber: number
  ) => Promise<{ translations: Translation[] } | null>;
}

interface NotePopoverState {
  label: string;
  chapter: number;
  xpath: string;
  originalHtml?: string;
  translated?: string;
  loading: boolean;
  missing?: boolean;
}

/**
 * Scope EPUB CSS rules under .epub-content to prevent them from
 * leaking to the reader's own layout elements (nav buttons, menus, etc.)
 *
 * `body`/`html` rules are dropped: EPUBs often inline per-page <style> blocks
 * (e.g. titlepage.xhtml's `body { text-align: center }`) into individual xhtml
 * files. The book parser concatenates all of them into one stylesheet, so a
 * single titlepage rule would otherwise center every paragraph in the book.
 */
function scopeEpubStyles(css: string): string {
  return css.replace(/([^{}@]+)\{/g, (match, selectors: string) => {
    // Don't scope @-rules (media queries, keyframes, etc.)
    if (selectors.trim().startsWith('@')) return match;
    const scoped = selectors
      .split(',')
      .map((s: string) => {
        s = s.trim();
        if (!s) return null;
        if (/^(body|html)$/i.test(s)) return null;
        return `.epub-content ${s}`;
      })
      .filter((s): s is string => s !== null)
      .join(', ');
    // If every selector was dropped, neutralize the rule with a no-match
    // selector so the declaration block is still syntactically valid.
    if (!scoped) return '.epub-content :not(*) {';
    return `${scoped} {`;
  });
}

export const TYPOGRAPHY_KEY = 'ovid_typography';

export function loadTypographyDefaults(): Record<string, number> {
  try {
    const saved = localStorage.getItem(TYPOGRAPHY_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
}

/**
 * BilingualReaderV2 - XPath-based bilingual reader
 *
 * This component renders the original EPUB HTML and patches text nodes
 * to enable toggle between original and translated text.
 */
const BilingualReaderV2: React.FC<BilingualReaderV2Props> = ({
  rawHtml,
  translations,
  styles,
  title,
  author,
  currentChapter,
  totalChapters,
  chapters,
  onLoadChapter,
  isLoading,
  bookUuid,
  onBackToShelf,
  onMarkComplete,
  isCompleted,
  isOwner,
  shareToken,
  onShare,
  onRevokeShare,
  initialXpath,
  onProgressChange,
  initialShowOriginal,
  onShowOriginalChange,
  onNavigateInternal,
  fetchChapter,
}) => {
  const { t, locale } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const [showOriginal, setShowOriginal] = useState(initialShowOriginal ?? true);
  const showOriginalRef = useRef(showOriginal);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isChaptersOpen, setIsChaptersOpen] = useState(false);
  const [typographyDefaults] = useState(loadTypographyDefaults);
  const [paragraphSpacing, setParagraphSpacing] = useState(
    typographyDefaults.paragraphSpacing ?? 0
  );
  const [lineHeight, setLineHeight] = useState(
    typographyDefaults.lineHeight ?? 1.6
  );
  const [letterSpacing, setLetterSpacing] = useState(
    typographyDefaults.letterSpacing ?? -0.03
  );
  const [wordSpacing, setWordSpacing] = useState(
    typographyDefaults.wordSpacing ?? 0
  );
  const [fontWeight, setFontWeight] = useState(
    typographyDefaults.fontWeight ?? 450
  );
  const [fontSize, setFontSize] = useState(typographyDefaults.fontSize ?? 19);
  const [isMarkingComplete, setIsMarkingComplete] = useState(false);
  const [markCompleteError, setMarkCompleteError] = useState<string | null>(
    null
  );
  const [isTypographyOpen, setIsTypographyOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        TYPOGRAPHY_KEY,
        JSON.stringify({
          paragraphSpacing,
          lineHeight,
          letterSpacing,
          wordSpacing,
          fontWeight,
          fontSize,
        })
      );
    } catch {}
  }, [
    paragraphSpacing,
    lineHeight,
    letterSpacing,
    wordSpacing,
    fontWeight,
    fontSize,
  ]);
  const [shareCopied, setShareCopied] = useState(false);
  const [showOnboardingTooltip, setShowOnboardingTooltip] = useState(false);

  // Store element references for toggling
  // originalHtml preserves formatting (innerHTML), translated is plain text
  // showingOriginal tracks the current state to avoid innerHTML comparison issues
  // noteRefChunks: serialized footnote-reference markers (a[data-ov-note], with
  // their <sup> wrapper when present) re-appended after translated text so the
  // notes stay reachable in translated view
  const elementsRef = useRef<
    Map<
      string,
      {
        element: HTMLElement;
        originalHtml: string;
        translated: string;
        showingOriginal: boolean;
        noteRefChunks: string[];
      }
    >
  >(new Map());

  // Footnote/endnote popover (opened by tapping an a[data-ov-note] marker)
  const [notePopover, setNotePopover] = useState<NotePopoverState | null>(null);

  // Track the topmost visible element for progress saving
  const visibleXpathRef = useRef<string | undefined>(undefined);
  const progressCallbackRef = useRef(onProgressChange);
  progressCallbackRef.current = onProgressChange;

  // Set of all currently-visible xpaths (kept up to date across observer callbacks)
  const visibleXpathsSetRef = useRef<Set<string>>(new Set());

  // Debounce timer for progress updates
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Track when translations have been applied (for observer setup timing)
  const [translationsReady, setTranslationsReady] = useState(0);

  /**
   * Serialize the footnote-reference markers inside an element (while it
   * still shows original content) so they can be re-appended after the
   * plain-text translation replaces innerHTML.
   */
  const collectNoteRefChunks = (el: HTMLElement): string[] => {
    const seen = new Set<Element>();
    const chunks: string[] = [];
    el.querySelectorAll('a[data-ov-note]').forEach((a) => {
      const sup = a.closest('sup');
      const chunk = sup && el.contains(sup) && sup !== el ? sup : a;
      if (!seen.has(chunk)) {
        seen.add(chunk);
        chunks.push(chunk.outerHTML);
      }
    });
    return chunks;
  };

  /** Swap an element to its translated text, keeping note markers tappable. */
  const renderTranslated = (data: {
    element: HTMLElement;
    translated: string;
    noteRefChunks: string[];
  }) => {
    data.element.textContent = data.translated;
    if (data.noteRefChunks.length > 0) {
      data.element.insertAdjacentHTML(
        'beforeend',
        ' ' + data.noteRefChunks.join('')
      );
    }
  };

  /**
   * Apply translations to the rendered HTML
   * Now works with element-level XPaths (e.g., /body[1]/p[1]) instead of text nodes
   */
  const applyTranslations = useCallback(() => {
    if (!contentRef.current || translations.length === 0) return;

    elementsRef.current.clear();

    // Build translation map
    const translationMap = new Map<string, Translation>();
    for (const t of translations) {
      translationMap.set(t.xpath, t);
    }

    // Block-level elements we're tracking
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
      'aside',
      'header',
      'footer',
    ]);

    // First, try to match by data-xpath attribute (for fallback reconstructed HTML)
    const elementsWithXpath =
      contentRef.current.querySelectorAll('[data-xpath]');
    if (elementsWithXpath.length > 0) {
      elementsWithXpath.forEach((el) => {
        const xpath = el.getAttribute('data-xpath');
        if (!xpath) return;

        const translation = translationMap.get(xpath);
        if (!translation) return;

        elementsRef.current.set(xpath, {
          element: el as HTMLElement,
          // Use original_html if available (preserves em, i, etc.), fallback to original_text
          originalHtml: translation.original_html || translation.original_text,
          translated: translation.translated_text,
          showingOriginal: true, // Will be set by updateAllElements
          noteRefChunks: collectNoteRefChunks(el as HTMLElement),
        });

        // Make element clickable
        (el as HTMLElement).setAttribute('data-bilingual', 'true');
        (el as HTMLElement).style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleElement(xpath);
        });
      });

      // Set initial state and return early
      updateAllElements(showOriginalRef.current);
      return;
    }

    // Walk the DOM and find block elements matching our XPaths
    const walkAndMap = (node: Node, pathSegments: string[]) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const nodeName = el.tagName.toLowerCase();

        // Skip script and style
        if (nodeName === 'script' || nodeName === 'style') return;

        // Count element index among siblings of same name
        let elementIndex = 1;
        let sibling: Node | null = node.previousSibling;
        while (sibling) {
          if (sibling.nodeType === Node.ELEMENT_NODE) {
            const sibEl = sibling as Element;
            if (sibEl.tagName.toLowerCase() === nodeName) {
              elementIndex++;
            }
          }
          sibling = sibling.previousSibling;
        }

        const currentPath = [...pathSegments, `${nodeName}[${elementIndex}]`];
        const xpath = '/' + currentPath.join('/');

        // Check if this element has a translation
        const translation = translationMap.get(xpath);
        if (translation && blockTags.has(nodeName)) {
          elementsRef.current.set(xpath, {
            element: el,
            // Store the actual innerHTML to preserve formatting (em, i, strong, etc.)
            originalHtml: el.innerHTML,
            translated: translation.translated_text,
            showingOriginal: true, // Will be set by updateAllElements
            noteRefChunks: collectNoteRefChunks(el),
          });

          // Make element clickable
          el.setAttribute('data-bilingual', 'true');
          el.style.cursor = 'pointer';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleElement(xpath);
          });

          // Don't recurse into matched block elements
          return;
        }

        // Process children for non-matched elements
        const children = node.childNodes;
        for (let i = 0; i < children.length; i++) {
          walkAndMap(children[i], currentPath);
        }
      }
    };

    // Find the starting point - either body element or contentDiv
    const contentDiv = contentRef.current;
    const bodyElement: Element | null = contentDiv.querySelector('body');
    const startingPoint = bodyElement || contentDiv;

    // Walk from the starting point
    const children = startingPoint.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const nodeName = el.tagName.toLowerCase();
        if (nodeName === 'script' || nodeName === 'style') continue;

        walkAndMap(child, ['body[1]']);
      }
    }

    // Initialize elements to match the current showOriginal state
    updateAllElements(showOriginalRef.current);
  }, [translations]);

  /**
   * Toggle text in a specific element by xpath
   * Uses innerHTML for original (preserves formatting) and textContent for translated
   */
  const toggleElement = (xpath: string) => {
    const data = elementsRef.current.get(xpath);
    if (!data) return;

    // Use tracked state instead of comparing innerHTML (browser normalizes HTML differently)
    if (data.showingOriginal) {
      // Switch to translated (plain text + re-appended note markers)
      renderTranslated(data);
      data.showingOriginal = false;
    } else {
      // Switch to original (with HTML formatting)
      data.element.innerHTML = data.originalHtml;
      data.showingOriginal = true;
    }
  };

  /**
   * Update all elements to show original or translated
   * Uses innerHTML for original (preserves em, i, strong, etc.) and textContent for translated
   */
  const updateAllElements = useCallback((showOrig: boolean) => {
    elementsRef.current.forEach((data) => {
      if (showOrig) {
        data.element.innerHTML = data.originalHtml;
      } else {
        renderTranslated(data);
      }
      data.showingOriginal = showOrig;
    });
  }, []);

  /**
   * Open the footnote popover for a note reference. Same-chapter notes read
   * from the already-loaded translations/DOM; cross-chapter notes fetch the
   * target chapter (cached upstream by AppV2).
   */
  const openNotePopover = useCallback(
    (chapter: number, xpath: string, label: string) => {
      const base: NotePopoverState = { label, chapter, xpath, loading: false };

      const fromTranslations = (list: Translation[]) => {
        const t = list.find((x) => x.xpath === xpath);
        if (!t) return null;
        return {
          originalHtml: t.original_html || t.original_text,
          translated: t.translated_text,
        };
      };

      if (chapter === currentChapter) {
        const found = fromTranslations(translations);
        if (found) {
          setNotePopover({ ...base, ...found });
          return;
        }
        // Untranslated book — pull the raw block from the rendered DOM
        const el = elementsRef.current.get(xpath);
        if (el) {
          setNotePopover({
            ...base,
            originalHtml: el.originalHtml || el.element.innerHTML,
          });
          return;
        }
        setNotePopover({ ...base, missing: true });
        return;
      }

      if (!fetchChapter) {
        // No fetcher — fall back to jumping
        onNavigateInternal?.(chapter, xpath);
        return;
      }

      setNotePopover({ ...base, loading: true });
      fetchChapter(chapter)
        .then((data) => {
          const found = data ? fromTranslations(data.translations) : null;
          setNotePopover((cur) => {
            // A newer popover/close superseded this fetch
            if (!cur || cur.xpath !== xpath || cur.chapter !== chapter)
              return cur;
            return found
              ? { ...cur, ...found, loading: false }
              : { ...cur, loading: false, missing: true };
          });
        })
        .catch(() => {
          setNotePopover((cur) =>
            cur && cur.xpath === xpath && cur.chapter === chapter
              ? { ...cur, loading: false, missing: true }
              : cur
          );
        });
    },
    [currentChapter, translations, fetchChapter, onNavigateInternal]
  );

  /**
   * Activate an internal link (parser-resolved a[data-ov-chapter]):
   * note refs open the popover, everything else jumps via AppV2.
   * Returns true when the event was handled.
   */
  const activateInternalLink = useCallback(
    (target: HTMLElement): boolean => {
      const link = target.closest('a[data-ov-chapter]') as HTMLElement | null;
      if (!link) return false;

      const chapter = parseInt(link.getAttribute('data-ov-chapter') || '', 10);
      const xpath = link.getAttribute('data-ov-xpath') || '';
      if (!chapter || !xpath) return true; // malformed — swallow the click

      if (link.hasAttribute('data-ov-note')) {
        openNotePopover(chapter, xpath, (link.textContent || '').trim());
      } else {
        onNavigateInternal?.(chapter, xpath);
      }
      return true;
    },
    [openNotePopover, onNavigateInternal]
  );

  // Intercept clicks on links in the content area (capture phase, so the
  // paragraph-level bilingual toggle underneath never fires for link taps).
  // Resolved internal links navigate in-app; legacy unresolved internal
  // links (old imports) are still blocked from navigating away.
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleLinkClick = (e: MouseEvent) => {
      if (activateInternalLink(e.target as HTMLElement)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const target = (e.target as HTMLElement).closest('a');
      if (!target) return;
      const href = target.getAttribute('href');
      if (!href) return;
      // Allow external links (http/https) to open normally
      if (href.startsWith('http://') || href.startsWith('https://')) return;
      // Block all remaining internal links (legacy content)
      e.preventDefault();
      e.stopPropagation();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target as HTMLElement;
      if (!target?.matches?.('a[data-ov-chapter]')) return;
      if (activateInternalLink(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    container.addEventListener('click', handleLinkClick, true);
    container.addEventListener('keydown', handleKeyDown, true);
    return () => {
      container.removeEventListener('click', handleLinkClick, true);
      container.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [rawHtml, activateInternalLink]);

  // Close the note popover when the chapter changes
  useEffect(() => {
    setNotePopover(null);
  }, [currentChapter]);

  /**
   * Register block-level elements for scroll tracking, without bilingual toggle
   * behavior. Used for books uploaded with "Import without translation" — the
   * IntersectionObserver still needs elementsRef populated to compute the
   * current xpath, otherwise reading progress never gets saved.
   *
   * Registers only leaf block elements (block tags with no block descendants)
   * to match the paragraph-level granularity that translated books get
   * naturally via translation-matched walks.
   */
  const registerElementsForTracking = useCallback(() => {
    if (!contentRef.current) return;
    elementsRef.current.clear();

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
      'aside',
      'header',
      'footer',
    ]);

    const hasBlockDescendant = (el: Element): boolean => {
      for (const child of Array.from(el.children)) {
        if (blockTags.has(child.tagName.toLowerCase())) return true;
        if (hasBlockDescendant(child)) return true;
      }
      return false;
    };

    // data-xpath fast path: reconstructed HTML annotates elements with their
    // canonical xpath, so we don't need to compute it.
    const annotated = contentRef.current.querySelectorAll('[data-xpath]');
    if (annotated.length > 0) {
      annotated.forEach((el) => {
        const xpath = el.getAttribute('data-xpath');
        if (!xpath) return;
        elementsRef.current.set(xpath, {
          element: el as HTMLElement,
          originalHtml: '',
          translated: '',
          showingOriginal: true,
          noteRefChunks: [],
        });
      });
      return;
    }

    const walk = (node: Node, pathSegments: string[]) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      const nodeName = el.tagName.toLowerCase();
      if (nodeName === 'script' || nodeName === 'style') return;

      let elementIndex = 1;
      let sibling: Node | null = node.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE) {
          const sibEl = sibling as Element;
          if (sibEl.tagName.toLowerCase() === nodeName) elementIndex++;
        }
        sibling = sibling.previousSibling;
      }

      const currentPath = [...pathSegments, `${nodeName}[${elementIndex}]`];
      const xpath = '/' + currentPath.join('/');

      if (blockTags.has(nodeName) && !hasBlockDescendant(el)) {
        elementsRef.current.set(xpath, {
          element: el,
          originalHtml: '',
          translated: '',
          showingOriginal: true,
          noteRefChunks: [],
        });
        return; // Leaf block — don't recurse
      }

      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) {
        walk(children[i], currentPath);
      }
    };

    const contentDiv = contentRef.current;
    const bodyElement: Element | null = contentDiv.querySelector('body');
    const startingPoint = bodyElement || contentDiv;
    const children = startingPoint.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const nodeName = el.tagName.toLowerCase();
        if (nodeName === 'script' || nodeName === 'style') continue;
        walk(child, ['body[1]']);
      }
    }
  }, []);

  // Apply translations (or just register elements for tracking) when content
  // changes. Skip-translation books need elementsRef populated too so the
  // IntersectionObserver can fire onProgressChange and save reading position.
  useEffect(() => {
    if (!rawHtml) return;
    // Small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      if (translations.length > 0) {
        applyTranslations();
      } else {
        registerElementsForTracking();
      }
      // Signal that elements are ready for observer setup
      setTranslationsReady((c) => c + 1);
    }, 100);
    return () => clearTimeout(timer);
  }, [rawHtml, translations, applyTranslations, registerElementsForTracking]);

  // Update text when showOriginal changes
  useEffect(() => {
    showOriginalRef.current = showOriginal;
    updateAllElements(showOriginal);
  }, [showOriginal, updateAllElements]);

  // Set up IntersectionObserver to track visible elements (after translations applied)
  useEffect(() => {
    if (!translationsReady || elementsRef.current.size === 0) return;

    // Reset the visible set when observer is (re-)created
    visibleXpathsSetRef.current.clear();

    const observer = new IntersectionObserver(
      (entries) => {
        // Update the persistent set of visible xpaths
        entries.forEach((entry) => {
          // Resolve xpath for this entry's target
          let entryXpath: string | undefined;
          elementsRef.current.forEach((data, xpath) => {
            if (data.element === entry.target) entryXpath = xpath;
          });
          if (!entryXpath) return;

          if (entry.isIntersecting) {
            visibleXpathsSetRef.current.add(entryXpath);
          } else {
            visibleXpathsSetRef.current.delete(entryXpath);
          }
        });

        // Find the topmost visible element from the full set
        let topmostXpath: string | undefined;
        let topmostTop = Infinity;

        visibleXpathsSetRef.current.forEach((xpath) => {
          const data = elementsRef.current.get(xpath);
          if (!data) return;
          const rect = data.element.getBoundingClientRect();
          if (rect.top < topmostTop && rect.top >= -rect.height / 2) {
            topmostTop = rect.top;
            topmostXpath = xpath;
          }
        });

        // Update visible xpath if changed
        if (topmostXpath && topmostXpath !== visibleXpathRef.current) {
          visibleXpathRef.current = topmostXpath;

          // Compute chapter fraction: position of this element among all tracked elements
          const totalElements = elementsRef.current.size;
          const elementIndex = Array.from(elementsRef.current.keys()).indexOf(
            topmostXpath
          );
          const chapterFraction =
            totalElements > 1 ? elementIndex / (totalElements - 1) : 0;

          // Debounced callback - wait 1s of stability before reporting
          if (progressTimerRef.current) {
            clearTimeout(progressTimerRef.current);
          }
          const capturedFraction = chapterFraction;
          progressTimerRef.current = setTimeout(() => {
            if (progressCallbackRef.current && visibleXpathRef.current) {
              progressCallbackRef.current(
                visibleXpathRef.current,
                capturedFraction
              );
            }
          }, 1000);
        }
      },
      {
        root: null, // viewport
        rootMargin: '0px',
        threshold: [0, 0.25, 0.5, 0.75, 1.0],
      }
    );

    // Observe all bilingual elements
    elementsRef.current.forEach((data) => {
      observer.observe(data.element);
    });

    return () => {
      observer.disconnect();
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
      }
    };
  }, [translationsReady]);

  // Show onboarding tooltip for first-time users, positioned near first paragraph
  const [tooltipPos, setTooltipPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  useEffect(() => {
    if (!translationsReady || elementsRef.current.size === 0) return;
    const seen = localStorage.getItem('ovid_onboarding_seen');
    if (seen) return;
    // Small delay so the content is rendered and laid out
    const timer = setTimeout(() => {
      // Find the first paragraph element
      const firstEntry = elementsRef.current.values().next().value;
      if (firstEntry?.element) {
        const rect = firstEntry.element.getBoundingClientRect();
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        setTooltipPos({
          top: rect.top + scrollTop + rect.height / 2,
          right: window.innerWidth - rect.left + 12,
        });
      }
      setShowOnboardingTooltip(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [translationsReady]);

  const dismissOnboarding = useCallback(() => {
    setShowOnboardingTooltip(false);
    localStorage.setItem('ovid_onboarding_seen', '1');
  }, []);

  // Dismiss onboarding on any click (acts as a global listener when tooltip is visible)
  useEffect(() => {
    if (!showOnboardingTooltip) return;
    const handler = () => dismissOnboarding();
    // Delay attaching so the current click doesn't immediately dismiss
    const timer = setTimeout(
      () => document.addEventListener('click', handler),
      100
    );
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handler);
    };
  }, [showOnboardingTooltip, dismissOnboarding]);

  // Scroll to initial xpath after translations are applied
  useEffect(() => {
    if (!translationsReady || !initialXpath || elementsRef.current.size === 0)
      return;

    const data = elementsRef.current.get(initialXpath);
    if (!data?.element) return;

    const el = data.element;
    const doScroll = () => {
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
      window.scrollBy(0, -20);
    };

    // First attempt after initial layout settles
    const t1 = setTimeout(doScroll, 200);
    // Second attempt handles books where images/web-fonts shift layout after the first scroll
    const t2 = setTimeout(() => {
      if (Math.abs(el.getBoundingClientRect().top) > 100) {
        doScroll();
      }
    }, 1000);
    // Briefly highlight the target so jumps (footnotes, cross-references)
    // land with a visible anchor point
    el.classList.add('ov-jump-flash');
    const t3 = setTimeout(() => el.classList.remove('ov-jump-flash'), 2200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      el.classList.remove('ov-jump-flash');
    };
  }, [translationsReady, initialXpath]);

  const toggleMenu = () => setIsMenuOpen(!isMenuOpen);

  const adjustParagraphSpacing = (delta: number) => {
    setParagraphSpacing((prev) => Math.max(0, Math.min(50, prev + delta)));
  };

  const adjustLineHeight = (delta: number) => {
    setLineHeight((prev) => Math.max(1.0, Math.min(3.0, prev + delta)));
  };

  const adjustLetterSpacing = (delta: number) => {
    setLetterSpacing((prev) => Math.max(-0.1, Math.min(0.3, prev + delta)));
  };

  const adjustWordSpacing = (delta: number) => {
    setWordSpacing((prev) => Math.max(-0.2, Math.min(0.3, prev + delta)));
  };

  const adjustFontWeight = (delta: number) => {
    setFontWeight((prev) => Math.max(200, Math.min(900, prev + delta)));
  };

  const adjustFontSize = (delta: number) => {
    setFontSize((prev) => Math.max(14, Math.min(24, prev + delta)));
  };

  const resetTypography = () => {
    setFontSize(19);
    setParagraphSpacing(0);
    setLineHeight(1.6);
    setLetterSpacing(-0.03);
    setWordSpacing(0);
    setFontWeight(450);
  };

  // View-transition wrapper: crossfades chapters using the browser's View
  // Transitions API when available, falling back to a plain load otherwise.
  const navigateWithTransition = useCallback(
    (chapterNumber: number) => {
      const run = () => onLoadChapter(chapterNumber);
      const doc = document as Document & {
        startViewTransition?: (cb: () => void | Promise<void>) => {
          finished: Promise<void>;
        };
      };
      const reduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;
      if (typeof doc.startViewTransition !== 'function' || reduced) {
        run();
        return;
      }
      doc.startViewTransition(() => Promise.resolve(run()));
    },
    [onLoadChapter]
  );

  const goToPreviousChapter = useCallback(() => {
    if (currentChapter > 1 && !isLoading) {
      navigateWithTransition(currentChapter - 1);
    }
  }, [currentChapter, isLoading, navigateWithTransition]);

  const goToNextChapter = useCallback(() => {
    if (currentChapter < totalChapters && !isLoading) {
      navigateWithTransition(currentChapter + 1);
    }
  }, [currentChapter, isLoading, totalChapters, navigateWithTransition]);

  const scrollToChapter = (chapterNumber: number) => {
    navigateWithTransition(chapterNumber);
    setIsChaptersOpen(false);
    setIsMenuOpen(false);
  };

  // Keyboard navigation: ArrowLeft = previous chapter, ArrowRight = next chapter.
  // Skip when a menu is open or focus is on an editable field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isMenuOpen || isChaptersOpen || isTypographyOpen) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      e.preventDefault();
      if (e.key === 'ArrowLeft') goToPreviousChapter();
      else goToNextChapter();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    goToPreviousChapter,
    goToNextChapter,
    isMenuOpen,
    isChaptersOpen,
    isTypographyOpen,
  ]);

  // iOS Safari standalone PWA: position:fixed anchors to the layout viewport, so when the
  // visual viewport shifts during scroll (toolbar show/hide, rubber-band overscroll) the FAB
  // appears to drift. Track the gap between the two and expose it as a CSS var.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty(
        '--fab-vv-offset',
        `${offset}px`
      );
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div className="bilingual-reader">
      {/* Inject EPUB CSS styles — scoped to .epub-content to prevent leaking */}
      {styles && (
        <style dangerouslySetInnerHTML={{ __html: scopeEpubStyles(styles) }} />
      )}

      {/* Custom styles for V2 reader */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .reader-content-v2,
        .reader-content-v2 * {
          font-family: "LXGW Neo ZhiSong Screen", "Literata", "New York", ui-serif, "Times New Roman", Times, serif !important;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          text-rendering: optimizeLegibility;
          font-optical-sizing: auto;
        }
        .reader-content-v2 {
          line-height: 1.8;
          text-align: justify;
          -webkit-hyphens: auto;
          hyphens: auto;
          overflow-wrap: break-word;
          word-break: break-word;
        }
        @media (max-width: 768px) {
          .reader-content-v2 {
            text-align: left;
          }
        }
        .reader-content-v2 [data-bilingual] {
          cursor: pointer;
          transition: background-color 0.2s;
        }
        .reader-content-v2 [data-bilingual]:hover {
          background-color: rgba(0, 0, 0, 0.02);
        }
        .reader-content-v2 p {
          margin: 0 0 0.8em 0;
          text-indent: 0;
        }
        .reader-content-v2 h1,
        .reader-content-v2 h2,
        .reader-content-v2 h3,
        .reader-content-v2 h4 {
          text-indent: 0 !important;
          margin-left: 0 !important;
          text-align: left !important;
        }
        .reader-content-v2 * {
          line-height: inherit !important;
        }
        .reader-content-v2 ol,
        .reader-content-v2 ul {
          list-style-position: inside;
          padding-left: 0;
          margin-left: 0;
        }
        .reader-content-v2 img,
        .reader-content-v2 svg {
          max-width: 100%;
          height: auto;
        }

        /* Sequential fade between chapters via View Transitions API:
           old fades out, then new fades in — no overlap, so no ghosting. */
        .epub-content {
          view-transition-name: epub-page;
        }
        @keyframes page-fade-out {
          from { opacity: 1; }
          to   { opacity: 0; }
        }
        @keyframes page-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        ::view-transition-old(epub-page) {
          animation: page-fade-out 200ms ease-out both;
        }
        ::view-transition-new(epub-page) {
          animation: page-fade-in 240ms ease-in 200ms both;
        }
        @media (prefers-reduced-motion: reduce) {
          ::view-transition-old(epub-page),
          ::view-transition-new(epub-page) {
            animation-duration: 1ms;
            animation-delay: 0s;
          }
        }
      `,
        }}
      />

      <main
        className="reader-content reader-content-v2"
        style={{
          fontSize: `${fontSize}px`,
          lineHeight: lineHeight,
          letterSpacing: `${letterSpacing}em`,
          wordSpacing: `${wordSpacing}em`,
          fontWeight: fontWeight,
        }}
      >
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>
            {t.reader.loadingChapter}
          </div>
        )}

        {/* Previous Chapter Button */}
        {!isLoading && currentChapter > 1 && (
          <div className="chapter-navigation-top">
            <button
              className="nav-button prev-button"
              onClick={goToPreviousChapter}
              title={t.reader.prevChapter}
            >
              ↶
            </button>
          </div>
        )}

        {/* Render the raw HTML */}
        {!isLoading && rawHtml && (
          <div
            className="epub-content"
            ref={contentRef}
            dangerouslySetInnerHTML={{ __html: rawHtml }}
          />
        )}

        {/* Onboarding tooltip for first-time users */}
        {showOnboardingTooltip && (
          <div
            className="onboarding-tooltip"
            onClick={dismissOnboarding}
            style={
              tooltipPos
                ? {
                    position: 'absolute',
                    top: tooltipPos.top,
                    right: tooltipPos.right,
                    left: 'auto',
                    transform: 'translateY(-50%)',
                  }
                : undefined
            }
          >
            <div className="onboarding-tooltip-arrow" />
            <span>{t.reader.tapToToggle}</span>
            <span className="onboarding-tooltip-en">
              {getMessages(locale === 'zh' ? 'en' : 'zh').reader.tapToToggle}
            </span>
          </div>
        )}

        {/* Next Chapter Button */}
        {!isLoading && currentChapter < totalChapters && (
          <div className="chapter-navigation-bottom">
            <button
              className="nav-button next-button"
              onClick={goToNextChapter}
              title={t.reader.nextChapter}
            >
              ↷
            </button>
          </div>
        )}
      </main>

      {/* Footnote / endnote popover */}
      {notePopover && (
        <>
          <div
            className="note-popover-backdrop"
            onClick={() => setNotePopover(null)}
          />
          <div
            className="note-popover"
            role="dialog"
            aria-label={`${t.reader.note} ${notePopover.label}`}
          >
            <div className="note-popover-header">
              <span className="note-popover-title">
                {t.reader.note} {notePopover.label}
              </span>
              <button
                className="note-popover-close"
                aria-label="Close"
                onClick={() => setNotePopover(null)}
              >
                ×
              </button>
            </div>
            <div className="note-popover-body">
              {notePopover.loading ? (
                <p className="note-popover-status">…</p>
              ) : notePopover.missing ? (
                <p className="note-popover-status">{t.reader.noteNotFound}</p>
              ) : (
                <>
                  {notePopover.originalHtml && (
                    <div
                      className="note-popover-original"
                      onClickCapture={(e) => {
                        const link = (e.target as HTMLElement).closest(
                          'a[data-ov-chapter]'
                        );
                        if (!link) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const chapter = parseInt(
                          link.getAttribute('data-ov-chapter') || '',
                          10
                        );
                        const xpath = link.getAttribute('data-ov-xpath') || '';
                        if (!chapter || !xpath) return;
                        if (link.hasAttribute('data-ov-note')) {
                          openNotePopover(
                            chapter,
                            xpath,
                            (link.textContent || '').trim()
                          );
                        } else {
                          setNotePopover(null);
                          onNavigateInternal?.(chapter, xpath);
                        }
                      }}
                      dangerouslySetInnerHTML={{
                        __html: notePopover.originalHtml,
                      }}
                    />
                  )}
                  {notePopover.translated && (
                    <div className="note-popover-translated">
                      {notePopover.translated}
                    </div>
                  )}
                </>
              )}
            </div>
            <button
              className="note-popover-goto"
              onClick={() => {
                const { chapter, xpath } = notePopover;
                setNotePopover(null);
                onNavigateInternal?.(chapter, xpath);
              }}
            >
              {t.reader.viewInContext} →
            </button>
          </div>
        </>
      )}

      <div className="fab-container">
        {/* Backdrop for mobile bottom sheet */}
        {isMenuOpen && (
          <div
            className="fab-backdrop"
            onClick={() => {
              setIsMenuOpen(false);
              setIsTypographyOpen(false);
            }}
          />
        )}
        <button className="fab" onClick={toggleMenu} aria-label={t.reader.menu}>
          <span className="fab-dots"></span>
        </button>
        {isMenuOpen && (
          <div className="fab-menu">
            {/* Primary actions */}
            {onBackToShelf && (
              <button className="fab-menu-item" onClick={onBackToShelf}>
                {t.reader.backToShelf}
              </button>
            )}
            {translations.length > 0 && (
              <button
                className="fab-menu-item"
                onClick={() => {
                  const next = !showOriginal;
                  setShowOriginal(next);
                  updateAllElements(next);
                  onShowOriginalChange?.(next);
                }}
              >
                {showOriginal
                  ? t.reader.showTranslation
                  : t.reader.showOriginal}
              </button>
            )}
            <button
              className="fab-menu-item"
              onClick={() => {
                setIsChaptersOpen(true);
                setIsMenuOpen(false);
              }}
            >
              {t.reader.chapters}
            </button>
            {onMarkComplete && (
              <button
                className={`fab-menu-item ${isCompleted ? 'fab-menu-item-completed' : ''}`}
                onClick={async () => {
                  setIsMarkingComplete(true);
                  setMarkCompleteError(null);
                  try {
                    await onMarkComplete(!isCompleted);
                  } catch (err) {
                    const errorMsg =
                      err instanceof Error ? err.message : String(err);
                    setMarkCompleteError(errorMsg);
                  } finally {
                    setIsMarkingComplete(false);
                  }
                }}
                disabled={isMarkingComplete}
              >
                {isMarkingComplete
                  ? '...'
                  : isCompleted
                    ? t.reader.markedRead
                    : t.reader.markAsRead}
              </button>
            )}
            {markCompleteError && (
              <div className="fab-error">{markCompleteError}</div>
            )}

            {/* Share buttons (owner only) */}
            {isOwner && onShare && !shareToken && (
              <button
                className="fab-menu-item"
                onClick={async () => {
                  setIsSharing(true);
                  try {
                    await onShare();
                  } finally {
                    setIsSharing(false);
                  }
                }}
                disabled={isSharing}
              >
                {isSharing ? '...' : t.reader.share}
              </button>
            )}
            {isOwner && shareToken && (
              <>
                <button
                  className="fab-menu-item"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `${window.location.origin}/shared/${shareToken}`
                    );
                    setShareCopied(true);
                    setTimeout(() => setShareCopied(false), 2000);
                  }}
                >
                  {shareCopied ? t.reader.copied : t.reader.copyShareLink}
                </button>
                <button
                  className="fab-menu-item"
                  onClick={async () => {
                    if (onRevokeShare) {
                      setIsSharing(true);
                      try {
                        await onRevokeShare();
                      } finally {
                        setIsSharing(false);
                      }
                    }
                  }}
                  disabled={isSharing}
                >
                  {isSharing ? '...' : t.reader.revokeShare}
                </button>
              </>
            )}

            {/* Divider */}
            <div className="fab-divider" />

            {/* Typography section - collapsible */}
            <button
              className="fab-menu-item fab-section-toggle"
              onClick={() => setIsTypographyOpen(!isTypographyOpen)}
            >
              <span>{t.reader.typography}</span>
              <span className={`fab-chevron ${isTypographyOpen ? 'open' : ''}`}>
                ›
              </span>
            </button>

            {isTypographyOpen && (
              <div className="fab-typography-panel">
                <div className="fab-typo-row">
                  <span className="fab-typo-label">{t.reader.fontSize}</span>
                  <div className="fab-menu-controls">
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustFontSize(-1)}
                    >
                      -
                    </button>
                    <span className="fab-typo-value">{fontSize}</span>
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustFontSize(1)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">
                    {t.reader.paragraphGap}
                  </span>
                  <div className="fab-menu-controls">
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustParagraphSpacing(-5)}
                    >
                      -
                    </button>
                    <span className="fab-typo-value">{paragraphSpacing}</span>
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustParagraphSpacing(5)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">{t.reader.lineHeight}</span>
                  <div className="fab-menu-controls">
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustLineHeight(-0.1)}
                    >
                      -
                    </button>
                    <span className="fab-typo-value">
                      {lineHeight.toFixed(1)}
                    </span>
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustLineHeight(0.1)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">
                    {t.reader.letterSpacing}
                  </span>
                  <div className="fab-menu-controls">
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustLetterSpacing(-0.01)}
                    >
                      -
                    </button>
                    <span className="fab-typo-value">
                      {letterSpacing.toFixed(2)}
                    </span>
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustLetterSpacing(0.01)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">{t.reader.wordSpacing}</span>
                  <div className="fab-menu-controls">
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustWordSpacing(-0.01)}
                    >
                      -
                    </button>
                    <span className="fab-typo-value">
                      {wordSpacing.toFixed(2)}
                    </span>
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustWordSpacing(0.01)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">{t.reader.fontWeight}</span>
                  <div className="fab-menu-controls">
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustFontWeight(-10)}
                    >
                      -
                    </button>
                    <span className="fab-typo-value">{fontWeight}</span>
                    <button
                      className="fab-control-btn"
                      onClick={() => adjustFontWeight(10)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <button className="fab-reset-btn" onClick={resetTypography}>
                  {t.reader.resetToDefault}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Chapters Modal */}
        {isChaptersOpen && (
          <div className="chapters-modal">
            <div className="chapters-content">
              <div className="chapters-header">
                <h3>{t.reader.contents}</h3>
                <button
                  className="chapters-close"
                  onClick={() => setIsChaptersOpen(false)}
                >
                  X
                </button>
              </div>
              <div className="chapters-list">
                {chapters.map((chapter) => (
                  <button
                    key={chapter.id}
                    className={`chapter-item ${currentChapter === chapter.chapter_number ? 'active' : ''}`}
                    onClick={() => scrollToChapter(chapter.chapter_number)}
                  >
                    <div className="chapter-number">
                      {chapter.chapter_number}
                    </div>
                    <div className="chapter-titles">
                      <div className="chapter-title-original">
                        {chapter.original_title}
                      </div>
                      <div className="chapter-title-translated">
                        {chapter.title}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div
              className="chapters-backdrop"
              onClick={() => setIsChaptersOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default BilingualReaderV2;
