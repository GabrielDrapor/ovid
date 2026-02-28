import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  onLoadChapter: (chapterNumber: number) => void;
  isLoading: boolean;
  bookUuid?: string;
  onBackToShelf?: () => void;
  // Reading status
  onMarkComplete?: (isCompleted: boolean) => Promise<void>;
  isCompleted?: boolean;
  // Granular progress tracking
  initialXpath?: string;  // XPath to scroll to on initial load
  onProgressChange?: (xpath: string) => void;  // Called when visible element changes
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
  initialXpath,
  onProgressChange,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [showOriginal, setShowOriginal] = useState(true);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isChaptersOpen, setIsChaptersOpen] = useState(false);
  const [paragraphSpacing, setParagraphSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.6);
  const [letterSpacing, setLetterSpacing] = useState(-0.03);
  const [wordSpacing, setWordSpacing] = useState(0);
  const [fontWeight, setFontWeight] = useState(450);
  const [isMarkingComplete, setIsMarkingComplete] = useState(false);
  const [markCompleteError, setMarkCompleteError] = useState<string | null>(null);

  // Store element references for toggling
  // originalHtml preserves formatting (innerHTML), translated is plain text
  // showingOriginal tracks the current state to avoid innerHTML comparison issues
  const elementsRef = useRef<Map<string, { element: HTMLElement; originalHtml: string; translated: string; showingOriginal: boolean }>>(new Map());

  // Track the topmost visible element for progress saving
  const visibleXpathRef = useRef<string | undefined>(undefined);
  const progressCallbackRef = useRef(onProgressChange);
  progressCallbackRef.current = onProgressChange;

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
      updateAllElements(true);
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

    // Always initialize showing original; the separate showOriginal useEffect handles state sync
    updateAllElements(true);
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
    updateAllElements(showOriginal);
  }, [showOriginal, updateAllElements]);

  // Set up IntersectionObserver to track visible elements (after translations applied)
  useEffect(() => {
    if (!translationsReady || elementsRef.current.size === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the topmost visible element
        let topmostXpath: string | undefined;
        let topmostTop = Infinity;

        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const rect = entry.boundingClientRect;
            // Element is visible and closer to the top of viewport
            if (rect.top < topmostTop && rect.top >= -rect.height / 2) {
              topmostTop = rect.top;
              // Find the xpath for this element
              elementsRef.current.forEach((data, xpath) => {
                if (data.element === entry.target) {
                  topmostXpath = xpath;
                }
              });
            }
          }
        });

        // Update visible xpath if changed
        if (topmostXpath && topmostXpath !== visibleXpathRef.current) {
          visibleXpathRef.current = topmostXpath;

          // Debounced callback - wait 1s of stability before reporting
          if (progressTimerRef.current) {
            clearTimeout(progressTimerRef.current);
          }
          progressTimerRef.current = setTimeout(() => {
            if (progressCallbackRef.current && visibleXpathRef.current) {
              progressCallbackRef.current(visibleXpathRef.current);
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

  const showAllOriginal = () => {
    setShowOriginal(true);
    updateAllElements(true);
    setIsMenuOpen(false);
  };

  const showAllTranslated = () => {
    setShowOriginal(false);
    updateAllElements(false);
    setIsMenuOpen(false);
  };

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

  const goToPreviousChapter = () => {
    if (currentChapter > 1 && !isLoading) {
      onLoadChapter(currentChapter - 1);
    }
  };

  const goToNextChapter = () => {
    if (currentChapter < totalChapters && !isLoading) {
      onLoadChapter(currentChapter + 1);
    }
  };

  const scrollToChapter = (chapterNumber: number) => {
    onLoadChapter(chapterNumber);
    setIsChaptersOpen(false);
    setIsMenuOpen(false);
  };

  return (
    <div className="bilingual-reader">
      {/* Inject EPUB CSS styles */}
      {styles && <style dangerouslySetInnerHTML={{ __html: styles }} />}

      {/* Custom styles for V2 reader */}
      <style dangerouslySetInnerHTML={{ __html: `
        .reader-content-v2,
        .reader-content-v2 * {
          font-family: "Literata", "New York", ui-serif, "Times New Roman", Times, serif !important;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          text-rendering: optimizeLegibility;
          font-optical-sizing: auto;
        }
        .reader-content-v2 {
          font-size: 19px;
          line-height: 1.8;
          text-align: justify;
          -webkit-hyphens: auto;
          hyphens: auto;
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
        .reader-content-v2 * {
          line-height: inherit !important;
        }
      `}} />

      <main
        className="reader-content reader-content-v2"
        style={{
          lineHeight: lineHeight,
          letterSpacing: `${letterSpacing}em`,
          wordSpacing: `${wordSpacing}em`,
          fontWeight: fontWeight,
        }}
      >
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>
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
            ref={contentRef}
            dangerouslySetInnerHTML={{ __html: rawHtml }}
          />
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
        <button className="fab" onClick={toggleMenu} aria-label="Menu">
          <span className="fab-dots"></span>
        </button>
        {isMenuOpen && (
          <div className="fab-menu">
            {onBackToShelf && (
              <div className="fab-menu-section">
                <button className="fab-menu-item" onClick={onBackToShelf}>
                  Back to Shelf
                </button>
              </div>
            )}

            {onMarkComplete && (
              <div className="fab-menu-section">
                <button 
                  className={`fab-menu-item ${isCompleted ? 'completed' : ''}`}
                  onClick={async () => {
                    setIsMarkingComplete(true);
                    setMarkCompleteError(null);
                    try {
                      await onMarkComplete(!isCompleted);
                    } catch (err) {
                      const errorMsg = err instanceof Error ? err.message : String(err);
                      setMarkCompleteError(errorMsg);
                      console.error('Error marking book complete:', err);
                    } finally {
                      setIsMarkingComplete(false);
                    }
                  }}
                  disabled={isMarkingComplete}
                  title={markCompleteError || undefined}
                >
                  {isMarkingComplete 
                    ? '...' 
                    : (isCompleted ? '✓ Completed' : 'Mark as Complete')}
                </button>
                {markCompleteError && (
                  <div style={{ fontSize: '12px', color: '#d32f2f', marginTop: '4px' }}>
                    {markCompleteError}
                  </div>
                )}
              </div>
            )}

            <div className="fab-menu-section">
              <div className="fab-menu-header">Navigation</div>
              <button className="fab-menu-item" onClick={() => setIsChaptersOpen(true)}>
                Contents
              </button>
            </div>

            <div className="fab-menu-section">
              <div className="fab-menu-header">Language</div>
              <button className="fab-menu-item" onClick={showAllOriginal}>
                Show All Original
              </button>
              <button className="fab-menu-item" onClick={showAllTranslated}>
                Show All Translated
              </button>
            </div>

            <div className="fab-menu-section">
              <div className="fab-menu-header">
                Paragraph Spacing: {paragraphSpacing}px
              </div>
              <div className="fab-menu-controls">
                <button
                  className="fab-control-btn"
                  onClick={() => adjustParagraphSpacing(-5)}
                >
                  -
                </button>
                <button
                  className="fab-control-btn"
                  onClick={() => adjustParagraphSpacing(5)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="fab-menu-section">
              <div className="fab-menu-header">
                Line Height: {lineHeight.toFixed(1)}
              </div>
              <div className="fab-menu-controls">
                <button
                  className="fab-control-btn"
                  onClick={() => adjustLineHeight(-0.1)}
                >
                  -
                </button>
                <button
                  className="fab-control-btn"
                  onClick={() => adjustLineHeight(0.1)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="fab-menu-section">
              <div className="fab-menu-header">
                Letter Spacing: {letterSpacing.toFixed(2)}em
              </div>
              <div className="fab-menu-controls">
                <button
                  className="fab-control-btn"
                  onClick={() => adjustLetterSpacing(-0.01)}
                >
                  -
                </button>
                <button
                  className="fab-control-btn"
                  onClick={() => adjustLetterSpacing(0.01)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="fab-menu-section">
              <div className="fab-menu-header">
                Word Spacing: {wordSpacing.toFixed(2)}em
              </div>
              <div className="fab-menu-controls">
                <button
                  className="fab-control-btn"
                  onClick={() => adjustWordSpacing(-0.01)}
                >
                  -
                </button>
                <button
                  className="fab-control-btn"
                  onClick={() => adjustWordSpacing(0.01)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="fab-menu-section">
              <div className="fab-menu-header">
                Font Weight: {fontWeight}
              </div>
              <div className="fab-menu-controls">
                <button
                  className="fab-control-btn"
                  onClick={() => adjustFontWeight(-10)}
                >
                  -
                </button>
                <button
                  className="fab-control-btn"
                  onClick={() => adjustFontWeight(10)}
                >
                  +
                </button>
              </div>
            </div>
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
