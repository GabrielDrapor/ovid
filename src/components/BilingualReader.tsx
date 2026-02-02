/**
 * @deprecated This is the V1 BilingualReader component.
 * Use BilingualReaderV2 instead, which uses XPath-based translations
 * and preserves original EPUB HTML formatting.
 * This file will be removed in a future version.
 */
import React, { useState, useEffect, useRef } from 'react';
import './BilingualReader.css';

export interface ContentItem {
  id: string;
  original: string;
  translated: string;
  type?: 'title' | 'chapter' | 'paragraph';
  className?: string;
  tagName?: string;
  styles?: string;
}

interface Chapter {
  id: number;
  chapter_number: number;
  title: string;
  original_title: string;
  order_index: number;
}

interface BilingualReaderProps {
  content: ContentItem[];
  title: string;
  author: string;
  styles?: string;
  currentChapter: number;
  onLoadChapter: (chapterNumber: number) => void;
  isLoading: boolean;
  setShowOriginalTitle: (value: boolean) => void;
  bookUuid?: string;
  onBackToShelf?: () => void;
}

const BilingualReader: React.FC<BilingualReaderProps> = ({
  content,
  title,
  author,
  styles,
  currentChapter,
  onLoadChapter,
  isLoading,
  setShowOriginalTitle,
  bookUuid,
  onBackToShelf,
}) => {
  const [showOriginal, setShowOriginal] = useState<{ [key: string]: boolean }>(
    {}
  );
  const [togglingItems, setTogglingItems] = useState<{ [key: string]: boolean }>(
    {}
  );

  // Initialize showOriginal state to show original text by default when content changes
  useEffect(() => {
    const originalState = content.reduce(
      (acc, item) => {
        acc[item.id] = true; // Default to showing original text
        return acc;
      },
      {} as { [key: string]: boolean }
    );
    setShowOriginal(originalState);
  }, [content]);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isChaptersOpen, setIsChaptersOpen] = useState(false);
  const [paragraphSpacing, setParagraphSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.6);
  const [letterSpacing, setLetterSpacing] = useState(0);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [totalChapters, setTotalChapters] = useState(12);
  const readerContentRef = useRef<HTMLDivElement>(null);

  const toggleLanguage = (id: string) => {
    // Start the toggle animation
    setTogglingItems((prev) => ({ ...prev, [id]: true }));

    // After a brief delay, switch the text and end animation
    setTimeout(() => {
      setShowOriginal((prev) => ({
        ...prev,
        [id]: !prev[id],
      }));
      // End the toggling state after the text has switched
      setTimeout(() => {
        setTogglingItems((prev) => ({ ...prev, [id]: false }));
      }, 50);
    }, 150);
  };

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  const showAllOriginal = () => {
    const allOriginal = content.reduce(
      (acc, item) => {
        acc[item.id] = true;
        return acc;
      },
      {} as { [key: string]: boolean }
    );
    setShowOriginal(allOriginal);
    setShowOriginalTitle(true);
    setIsMenuOpen(false);
  };

  const showAllTranslated = () => {
    const allTranslated = content.reduce(
      (acc, item) => {
        acc[item.id] = false;
        return acc;
      },
      {} as { [key: string]: boolean }
    );
    setShowOriginal(allTranslated);
    setShowOriginalTitle(false);
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

  // Fetch chapters from API
  useEffect(() => {
    const fetchChapters = async () => {
      if (!bookUuid) return;

      try {
        const response = await fetch(`/api/book/${bookUuid}/chapters`);
        if (response.ok) {
          const chaptersData = (await response.json()) as Chapter[];
          setChapters(chaptersData);
          setTotalChapters(chaptersData.length);
        }
      } catch (error) {
        console.error('Failed to fetch chapters:', error);
      }
    };

    fetchChapters();
  }, [bookUuid]);

  // Navigation functions for manual chapter switching
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

  const toggleChapters = () => {
    setIsChaptersOpen(!isChaptersOpen);
    setIsMenuOpen(false);
  };

  return (
    <div className="bilingual-reader">
      {/* Inject EPUB CSS styles */}
      {styles && <style dangerouslySetInnerHTML={{ __html: styles }} />}

      <main
        ref={readerContentRef}
        className="reader-content"
        style={{
          lineHeight: lineHeight,
          letterSpacing: `${letterSpacing}em`,
        }}
      >
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>
            Loading chapter...
          </div>
        )}

        {/* Previous Chapter Button at top - only show for chapters > 1 */}
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

        {!isLoading &&
          content.map((item) => {
            const text = showOriginal[item.id]
              ? item.original
              : item.translated;
            const isChinese = /[\u4e00-\u9fff]/.test(text);

            // Combine original EPUB classes with reader classes
            let itemClass = 'paragraph toggleable-text';
            if (item.type === 'title') {
              itemClass = 'title-text toggleable-text';
            } else if (item.type === 'chapter') {
              itemClass = 'chapter-text toggleable-text';
            } else {
              itemClass += isChinese ? ' chinese-text' : ' english-text';
            }

            // Add toggle animation class
            if (togglingItems[item.id]) {
              itemClass += ' toggling';
            }

            // Add translated/original text style class
            if (showOriginal[item.id]) {
              itemClass += ' original-text-style';
            } else {
              itemClass += ' translated-text-style';
            }

            // Add original EPUB className if available
            if (item.className) {
              itemClass += ` ${item.className}`;
            }

            // Create inline styles combining reader and EPUB styles
            const combinedStyles: React.CSSProperties = {};
            if (item.styles) {
              // Parse inline styles if available
              const inlineStyles = item.styles
                .split(';')
                .reduce((acc, style) => {
                  const [property, value] = style
                    .split(':')
                    .map((s) => s.trim());
                  if (property && value) {
                    // Convert CSS property names to camelCase for React
                    const camelProp = property.replace(/-([a-z])/g, (g) =>
                      g[1].toUpperCase()
                    );
                    acc[camelProp] = value;
                  }
                  return acc;
                }, {} as any);
              Object.assign(combinedStyles, inlineStyles);
            }

            // Determine the appropriate HTML element based on original tagName or type
            const TagName = (item.tagName ||
              (item.type === 'title'
                ? 'h2'
                : item.type === 'chapter'
                  ? 'h3'
                  : 'p')) as keyof JSX.IntrinsicElements;

            const element = React.createElement(
              TagName,
              {
                className: itemClass,
                style: combinedStyles,
                onClick: () => toggleLanguage(item.id),
                dangerouslySetInnerHTML: { __html: text },
              },
              null
            );

            return (
              <div
                key={item.id}
                id={`paragraph-${item.id}`}
                className={`paragraph-container ${item.type || 'paragraph'}-container`}
                style={{ marginBottom: `${paragraphSpacing}px` }}
              >
                {element}
              </div>
            );
          })}

        {/* Next Chapter Button at bottom - only show if not on last chapter */}
        {!isLoading && currentChapter < totalChapters && (
          <div className="chapter-navigation-bottom">
            <button
              className="nav-button next-button"
              onClick={goToNextChapter}
              title={currentChapter === 1 ? 'Start reading' : 'Next Chapter'}
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

            <div className="fab-menu-section">
              <div className="fab-menu-header">Navigation</div>
              <button className="fab-menu-item" onClick={toggleChapters}>
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
                  ×
                </button>
              </div>
              <div className="chapters-list">
                {chapters.map((chapter) => {
                  return (
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
                  );
                })}
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

export default BilingualReader;
