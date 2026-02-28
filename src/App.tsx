import React, { useState, useEffect } from 'react';
import BookShelf from './components/BookShelf';
import AppV2 from './AppV2';
import { UserProvider } from './contexts/UserContext';
import './App.css';

function App() {
  const [bookUuid, setBookUuid] = useState<string | null>(null);
  const [showBookShelf, setShowBookShelf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state from URL
  const syncFromUrl = () => {
    const path = window.location.pathname;

    // Root path: /
    if (path === '/' || path === '') {
      setShowBookShelf(true);
      setBookUuid(null);
      setError(null);
      return;
    }

    // Book path: /book/:uuid or /v2/book/:uuid (all use V2 reader now)
    const match = path.match(/^\/(?:v2\/)?book\/([^\/]+)$/);
    if (match) {
      const uuid = match[1];
      setBookUuid(uuid);
      setShowBookShelf(false);
      setError(null);
      return;
    }

    // Fallback/Error state
    setError('Invalid URL. Expected / or /book/:uuid');
    setShowBookShelf(false);
  };

  // Initial load and event listeners
  useEffect(() => {
    syncFromUrl();

    const handlePopState = () => syncFromUrl();
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('hashchange', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handlePopState);
    };
  }, []);

  const handleSelectBook = (uuid: string) => {
    // Check for saved progress (try new v2 format first, then legacy)
    let chapterToLoad = 1;
    let xpathToLoad: string | undefined;
    
    const savedV2 = localStorage.getItem(`ovid_progress_v2_${uuid}`);
    if (savedV2) {
      try {
        const progress = JSON.parse(savedV2);
        if (progress.chapter >= 1) {
          chapterToLoad = progress.chapter;
          xpathToLoad = progress.xpath;
        }
      } catch { /* ignore */ }
    } else {
      const savedChapter = localStorage.getItem(`ovid_progress_${uuid}`);
      if (savedChapter) {
        chapterToLoad = parseInt(savedChapter, 10) || 1;
      }
    }

    // Navigation: Go to book reader (include xpath in hash if available)
    const xpathPart = xpathToLoad ? `:${encodeURIComponent(xpathToLoad)}` : '';
    const url = `/book/${uuid}#chapter-${chapterToLoad}${xpathPart}`;
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

  // Error state
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

  // V2 Book reader
  if (bookUuid) {
    return (
      <UserProvider>
        <AppV2 bookUuid={bookUuid} onBackToShelf={handleBackToShelf} />
      </UserProvider>
    );
  }

  return null;
}

export default App;
