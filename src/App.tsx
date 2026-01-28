import React, { useState, useEffect } from 'react';
import BilingualReader, { ContentItem } from './components/BilingualReader';
import BookShelf from './components/BookShelf';
import AppV2 from './AppV2';
import { UserProvider } from './contexts/UserContext';
import './App.css';

interface BookContent {
  uuid: string;
  title: string;
  originalTitle: string;
  author: string;
  styles: string;
  currentChapter: number;
  chapterInfo: {
    number: number;
    title: string;
    originalTitle: string;
  };
  content: ContentItem[];
}

function App() {
  const [showOriginalTitle, setShowOriginalTitle] = useState(true);
  const [bookContent, setBookContent] = useState<BookContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentChapter, setCurrentChapter] = useState(1);
  const [bookUuid, setBookUuid] = useState<string | null>(null);
  const [showBookShelf, setShowBookShelf] = useState(false);
  const [isV2Book, setIsV2Book] = useState(false);

  // Sync state from URL
  const syncFromUrl = () => {
    const path = window.location.pathname;
    const hash = window.location.hash;

    // Root path: /
    if (path === '/' || path === '') {
      setShowBookShelf(true);
      setBookUuid(null);
      setBookContent(null);
      setLoading(false);
      setIsV2Book(false);
      return;
    }

    // V2 Book path: /v2/book/:uuid
    const matchV2 = path.match(/^\/v2\/book\/([^\/]+)$/);
    if (matchV2) {
      const uuid = matchV2[1];
      setBookUuid(uuid);
      setShowBookShelf(false);
      setIsV2Book(true);
      setLoading(false);
      return;
    }

    // Book path: /book/:uuid
    const match = path.match(/^\/book\/([^\/]+)$/);
    if (match) {
      const uuid = match[1];
      let chapter = 1;

      // Check for chapter in hash: #chapter-2
      const hashMatch = hash.match(/^#chapter-(\d+)$/);
      if (hashMatch) {
        chapter = parseInt(hashMatch[1], 10);
      } else if (hash.match(/^\d+$/)) {
        // Legacy simplified hash: #2
        chapter = parseInt(hash, 10);
      }

      setBookUuid(uuid);
      setCurrentChapter(isNaN(chapter) ? 1 : chapter);
      setShowBookShelf(false);
      setIsV2Book(false);
      return;
    }

    // Fallback/Error state
    setError('Invalid URL. Expected / or /book/:uuid');
    setLoading(false);
    setShowBookShelf(false);
    setIsV2Book(false);
  };

  // Initial load and event listeners
  useEffect(() => {
    syncFromUrl();

    const handlePopState = () => syncFromUrl();
    window.addEventListener('popstate', handlePopState);
    // Also listen for hashchange if user manually edits hash
    window.addEventListener('hashchange', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handlePopState);
    };
  }, []);

  const loadChapter = async (uuid: string, chapterNumber: number) => {
    setLoading(true);
    try {
      // API supports fetching specific chapters
      const response = await fetch(
        `/api/book/${uuid}/chapter/${chapterNumber}`
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = (await response.json()) as BookContent;
      setBookContent(data);

      // Auto-scroll logic
      setTimeout(() => {
        window.scrollTo(0, 0);
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chapter');
      console.error('Error fetching chapter:', err);
    } finally {
      setLoading(false);
    }
  };

  // React to state changes to load data and save progress
  useEffect(() => {
    if (bookUuid && !showBookShelf) {
      // Save progress
      if (currentChapter) {
        localStorage.setItem(
          `ovid_progress_${bookUuid}`,
          currentChapter.toString()
        );
      }

      // Only load if content missing or chapter changed
      if (
        !bookContent ||
        bookContent.uuid !== bookUuid ||
        bookContent.currentChapter !== currentChapter
      ) {
        loadChapter(bookUuid, currentChapter);
      }
    }
  }, [bookUuid, currentChapter, showBookShelf]);

  const handleSelectBook = (uuid: string) => {
    // Check for saved progress
    const savedChapter = localStorage.getItem(`ovid_progress_${uuid}`);
    const chapterToLoad = savedChapter ? parseInt(savedChapter, 10) : 1;

    // Navigation: Go to V2 book reader
    const url = `/v2/book/${uuid}#chapter-${chapterToLoad}`;
    window.history.pushState({}, '', url);

    // Manually trigger sync because pushState doesn't fire popstate
    syncFromUrl();
  };

  const handleBackToShelf = () => {
    window.history.pushState({}, '', '/');
    syncFromUrl();
  };

  // Show book shelf on root path
  if (showBookShelf) {
    return (
      <UserProvider>
        <div className="App">
          <BookShelf onSelectBook={handleSelectBook} />
        </div>
      </UserProvider>
    );
  }

  // V2 Book reader (XPath-based)
  if (isV2Book && bookUuid) {
    return <AppV2 bookUuid={bookUuid} onBackToShelf={handleBackToShelf} />;
  }

  if (loading && !bookContent) {
    return (
      <div className="App">
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div>Loading book content...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="App">
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div>Error: {error}</div>
          <button
            onClick={() => {
              window.history.pushState({}, '', '/');
              syncFromUrl();
            }}
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  if (!bookContent) return null;

  const epubContent = bookContent.content;
  const author =
    bookContent.author !== 'Unknown Author' ? bookContent.author : '';

  return (
    <div className="App">
      <BilingualReader
        content={epubContent}
        title={bookContent.title}
        author={author}
        styles={bookContent.styles}
        currentChapter={currentChapter}
        onLoadChapter={(n: number) => {
          // Update URL hash without full reload
          const newHash = `#chapter-${n}`;
          if (window.location.hash !== newHash) {
            window.history.pushState({}, '', newHash);
            setCurrentChapter(n);
            // No need to call syncFromUrl() as state update triggers useEffect
          }
        }}
        isLoading={loading}
        setShowOriginalTitle={setShowOriginalTitle}
        bookUuid={bookUuid || undefined}
        onBackToShelf={handleBackToShelf}
      />
    </div>
  );
}

export default App;
