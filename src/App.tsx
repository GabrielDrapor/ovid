import React, { useState, useEffect } from 'react';
import BookShelf from './components/BookShelf';
import AppV2 from './AppV2';
import SharedBookView from './components/SharedBookView';
import ErrorBoundary from './components/ErrorBoundary';
import { UserProvider } from './contexts/UserContext';
import './App.css';

function App() {
  const [bookUuid, setBookUuid] = useState<string | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [showBookShelf, setShowBookShelf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state from URL
  const syncFromUrl = () => {
    const path = window.location.pathname;

    // Root path: /
    if (path === '/' || path === '') {
      setShowBookShelf(true);
      setBookUuid(null);
      setShareToken(null);
      setError(null);
      return;
    }

    // Shared book path: /shared/:token
    const sharedMatch = path.match(/^\/shared\/([^\/]+)$/);
    if (sharedMatch) {
      setShareToken(sharedMatch[1]);
      setBookUuid(null);
      setShowBookShelf(false);
      setError(null);
      return;
    }

    // Book path: /book/:uuid or /v2/book/:uuid (all use V2 reader now)
    const match = path.match(/^\/(?:v2\/)?book\/([^\/]+)$/);
    if (match) {
      const uuid = match[1];
      setBookUuid(uuid);
      setShareToken(null);
      setShowBookShelf(false);
      setError(null);
      return;
    }

    // Unknown URL — redirect to home
    window.location.replace('/');
    return;
  };

  // Initial load and event listeners
  useEffect(() => {
    syncFromUrl();

    const handlePopState = () => syncFromUrl();
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const handleSelectBook = (uuid: string) => {
    // Navigation: clean URL with just the book UUID
    // Reading progress (chapter/xpath) is restored from localStorage by AppV2
    window.history.pushState({}, '', `/book/${uuid}`);

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
      <ErrorBoundary>
        <UserProvider>
          <div className="App">
            <BookShelf onSelectBook={handleSelectBook} />
          </div>
        </UserProvider>
      </ErrorBoundary>
    );
  }

  // Shared book view (no auth needed)
  if (shareToken) {
    return (
      <ErrorBoundary>
        <SharedBookView shareToken={shareToken} />
      </ErrorBoundary>
    );
  }

  // Error state
  if (error) {
    return (
      <ErrorBoundary>
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
      </ErrorBoundary>
    );
  }

  // V2 Book reader
  if (bookUuid) {
    return (
      <ErrorBoundary>
        <UserProvider>
          <AppV2 bookUuid={bookUuid} onBackToShelf={handleBackToShelf} />
        </UserProvider>
      </ErrorBoundary>
    );
  }

  return null;
}

export default App;
