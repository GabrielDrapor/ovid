import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../contexts/ThemeContext';
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
  initialXpath?: string;  // XPath to scroll to on initial load
  onProgressChange?: (xpath: string, chapterFraction: number) => void;  // Called when visible element changes; chapterFraction is 0–1
  // Show translation / show original toggle persistence
  initialShowOriginal?: boolean;
  onShowOriginalChange?: (showOriginal: boolean) => void;
}

/**
 * Scope EPUB CSS rules under .epub-content to prevent them from
 * leaking to the reader's own layout elements (nav buttons, menus, etc.)
 */
function scopeEpubStyles(css: string): string {
  return css.replace(
    /([^{}@]+)\{/g,
    (match, selectors: string) => {
      // Don't scope @-rules (media queries, keyframes, etc.)
      if (selectors.trim().startsWith('@')) return match;
      const scoped = selectors
        .split(',')
        .map((s: string) => {
          s = s.trim();
          if (!s) return s;
          // Skip body/html — remap to .epub-content itself
          if (/^(body|html)$/i.test(s)) return '.epub-content';
          return `.epub-content ${s}`;
        })
        .join(', ');
      return `${scoped} {`;
    }
  );
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
}) => {
  const { theme, toggleTheme } = useTheme();
  const contentRef = useRef<HTMLDivElement>(null);
  const [showOriginal, setShowOriginal] = useState(initialShowOriginal ?? true);
  const showOriginalRef = useRef(showOriginal);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isChaptersOpen, setIsChaptersOpen] = useState(false);
  const [paragraphSpacing, setParagraphSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.6);
  const [letterSpacing, setLetterSpacing] = useState(-0.03);
  const [wordSpacing, setWordSpacing] = useState(0);
  const [fontWeight, setFontWeight] = useState(450);
  const [fontSize, setFontSize] = useState(19);
  const [isMarkingComplete, setIsMarkingComplete] = useState(false);
  const [markCompleteError, setMarkCompleteError] = useState<string | null>(null);
  const [isTypographyOpen, setIsTypographyOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [showOnboardingTooltip, setShowOnboardingTooltip] = useState(false);

  // Store element references for toggling
  // originalHtml preserves formatting (innerHTML), translated is plain text
  // showingOriginal tracks the current state to avoid innerHTML comparison issues
  const elementsRef = useRef<Map<string, { element: HTMLElement; originalHtml: string; translated: string; showingOriginal: boolean }>>(new Map());

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
      'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'li', 'blockquote', 'pre', 'td', 'th', 'dt', 'dd',
      'figcaption', 'article', 'section', 'aside', 'header', 'footer'
    ]);

    // First, try to match by data-xpath attribute (for fallback reconstructed HTML)
    const elementsWithXpath = contentRef.current.querySelectorAll('[data-xpath]');
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
      // Switch to translated (plain text)
      data.element.textContent = data.translated;
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
        data.element.textContent = data.translated;
      }
      data.showingOriginal = showOrig;
    });
  }, []);

  // Intercept clicks on internal <a> links in the content area
  // EPUB books often have internal links (TOC anchors, cross-references) that
  // would cause navigation away from the reader if clicked
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleLinkClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a');
      if (!target) return;

      const href = target.getAttribute('href');
      if (!href) return;

      // Allow external links (http/https) to open normally
      if (href.startsWith('http://') || href.startsWith('https://')) return;

      // Block all internal links (EPUB cross-references, anchors, etc.)
      e.preventDefault();
      e.stopPropagation();
    };

    container.addEventListener('click', handleLinkClick);
    return () => container.removeEventListener('click', handleLinkClick);
  }, [rawHtml]);

  // Apply translations when content changes
  useEffect(() => {
    if (rawHtml && translations.length > 0) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        applyTranslations();
        // Signal that translations are ready for observer setup
        setTranslationsReady((c) => c + 1);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [rawHtml, translations, applyTranslations]);

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
          const elementIndex = Array.from(elementsRef.current.keys()).indexOf(topmostXpath);
          const chapterFraction = totalElements > 1
            ? elementIndex / (totalElements - 1)
            : 0;

          // Debounced callback - wait 1s of stability before reporting
          if (progressTimerRef.current) {
            clearTimeout(progressTimerRef.current);
          }
          const capturedFraction = chapterFraction;
          progressTimerRef.current = setTimeout(() => {
            if (progressCallbackRef.current && visibleXpathRef.current) {
              progressCallbackRef.current(visibleXpathRef.current, capturedFraction);
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
  const [tooltipPos, setTooltipPos] = useState<{ top: number; right: number } | null>(null);
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
    const timer = setTimeout(() => document.addEventListener('click', handler), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handler);
    };
  }, [showOnboardingTooltip, dismissOnboarding]);

  // Scroll to initial xpath after translations are applied
  useEffect(() => {
    if (!translationsReady || !initialXpath || elementsRef.current.size === 0) return;

    const data = elementsRef.current.get(initialXpath);
    if (data?.element) {
      // Small delay to ensure layout is complete
      setTimeout(() => {
        data.element.scrollIntoView({ behavior: 'auto', block: 'start' });
        // Offset a bit from the very top for better UX
        window.scrollBy(0, -20);
      }, 150);
    }
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
        startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> };
      };
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  }, [goToPreviousChapter, goToNextChapter, isMenuOpen, isChaptersOpen, isTypographyOpen]);

  return (
    <div className="bilingual-reader">
      {/* Inject EPUB CSS styles — scoped to .epub-content to prevent leaking */}
      {styles && <style dangerouslySetInnerHTML={{ __html: scopeEpubStyles(styles) }} />}

      {/* Custom styles for V2 reader */}
      <style dangerouslySetInnerHTML={{ __html: `
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
          background-color: var(--paper-soft);
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
      `}} />

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
          <div style={{ textAlign: 'center', padding: 'var(--space-sm)', color: 'var(--ink-faint)', fontStyle: 'italic' }}>
            Loading chapter...
          </div>
        )}

        {/* Previous Chapter Button */}
        {!isLoading && currentChapter > 1 && (
          <div className="chapter-navigation-top">
            <button
              className="nav-button prev-button"
              onClick={goToPreviousChapter}
              title="Previous Chapter"
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
            style={tooltipPos ? {
              position: 'absolute',
              top: tooltipPos.top,
              right: tooltipPos.right,
              left: 'auto',
              transform: 'translateY(-50%)',
            } : undefined}
          >
            <div className="onboarding-tooltip-arrow" />
            <span>点击段落切换翻译</span>
            <span className="onboarding-tooltip-en">Tap to toggle translation</span>
          </div>
        )}

        {/* Next Chapter Button */}
        {!isLoading && currentChapter < totalChapters && (
          <div className="chapter-navigation-bottom">
            <button
              className="nav-button next-button"
              onClick={goToNextChapter}
              title="Next Chapter"
            >
              ↷
            </button>
          </div>
        )}
      </main>

      <div className="fab-container">
        {/* Backdrop for mobile bottom sheet */}
        {isMenuOpen && (
          <div className="fab-backdrop" onClick={() => { setIsMenuOpen(false); setIsTypographyOpen(false); }} />
        )}
        <button className="fab" onClick={toggleMenu} aria-label="Menu">
          <span className="fab-dots"></span>
        </button>
        {isMenuOpen && (
          <div className="fab-menu">
            {/* Primary actions */}
            {onBackToShelf && (
              <button className="fab-menu-item" onClick={onBackToShelf}>
                Back to Shelf
              </button>
            )}
            <button
              className="fab-menu-item"
              onClick={() => {
                const next = !showOriginal;
                setShowOriginal(next);
                updateAllElements(next);
                onShowOriginalChange?.(next);
              }}
            >
              {showOriginal ? 'Show Translation' : 'Show Original'}
            </button>
            <button className="fab-menu-item" onClick={() => { setIsChaptersOpen(true); setIsMenuOpen(false); }}>
              Chapters
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
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    setMarkCompleteError(errorMsg);
                  } finally {
                    setIsMarkingComplete(false);
                  }
                }}
                disabled={isMarkingComplete}
              >
                {isMarkingComplete ? '...' : (isCompleted ? '✓ Read' : 'Mark as Read')}
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
                {isSharing ? '...' : 'Share'}
              </button>
            )}
            {isOwner && shareToken && (
              <>
                <button
                  className="fab-menu-item"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/shared/${shareToken}`);
                    setShareCopied(true);
                    setTimeout(() => setShareCopied(false), 2000);
                  }}
                >
                  {shareCopied ? '✓ Copied!' : 'Copy Share Link'}
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
                  {isSharing ? '...' : 'Revoke Share'}
                </button>
              </>
            )}

            {/* Divider */}
            <div className="fab-divider" />

            {/* Theme toggle */}
            <button
              className="fab-menu-item"
              onClick={toggleTheme}
            >
              <span>{theme === 'light' ? 'Dark Mode' : 'Light Mode'}</span>
            </button>

            {/* Typography section - collapsible */}
            <button
              className="fab-menu-item fab-section-toggle"
              onClick={() => setIsTypographyOpen(!isTypographyOpen)}
            >
              <span>Typography</span>
              <span className={`fab-chevron ${isTypographyOpen ? 'open' : ''}`}>›</span>
            </button>

            {isTypographyOpen && (
              <div className="fab-typography-panel">
                <div className="fab-typo-row">
                  <span className="fab-typo-label">Font Size</span>
                  <div className="fab-menu-controls">
                    <button className="fab-control-btn" onClick={() => adjustFontSize(-1)}>-</button>
                    <span className="fab-typo-value">{fontSize}</span>
                    <button className="fab-control-btn" onClick={() => adjustFontSize(1)}>+</button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">Paragraph Gap</span>
                  <div className="fab-menu-controls">
                    <button className="fab-control-btn" onClick={() => adjustParagraphSpacing(-5)}>-</button>
                    <span className="fab-typo-value">{paragraphSpacing}</span>
                    <button className="fab-control-btn" onClick={() => adjustParagraphSpacing(5)}>+</button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">Line Height</span>
                  <div className="fab-menu-controls">
                    <button className="fab-control-btn" onClick={() => adjustLineHeight(-0.1)}>-</button>
                    <span className="fab-typo-value">{lineHeight.toFixed(1)}</span>
                    <button className="fab-control-btn" onClick={() => adjustLineHeight(0.1)}>+</button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">Letter Spacing</span>
                  <div className="fab-menu-controls">
                    <button className="fab-control-btn" onClick={() => adjustLetterSpacing(-0.01)}>-</button>
                    <span className="fab-typo-value">{letterSpacing.toFixed(2)}</span>
                    <button className="fab-control-btn" onClick={() => adjustLetterSpacing(0.01)}>+</button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">Word Spacing</span>
                  <div className="fab-menu-controls">
                    <button className="fab-control-btn" onClick={() => adjustWordSpacing(-0.01)}>-</button>
                    <span className="fab-typo-value">{wordSpacing.toFixed(2)}</span>
                    <button className="fab-control-btn" onClick={() => adjustWordSpacing(0.01)}>+</button>
                  </div>
                </div>
                <div className="fab-typo-row">
                  <span className="fab-typo-label">Font Weight</span>
                  <div className="fab-menu-controls">
                    <button className="fab-control-btn" onClick={() => adjustFontWeight(-10)}>-</button>
                    <span className="fab-typo-value">{fontWeight}</span>
                    <button className="fab-control-btn" onClick={() => adjustFontWeight(10)}>+</button>
                  </div>
                </div>
                <button
                  className="fab-reset-btn"
                  onClick={resetTypography}
                >
                  Reset to Default
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
                <h3>Contents</h3>
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
