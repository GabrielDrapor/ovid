import React, { useState, useEffect } from 'react';
import BilingualReader, { ContentItem } from './components/BilingualReader';
import BookShelf from './components/BookShelf';
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

  const loadChapter = async (chapterNumber: number) => {
    if (!bookUuid) {
      setError('No book UUID found');
      return;
    }
    
    setLoading(true);
    try {
      const response = await fetch(`/api/book/${bookUuid}/chapter/${chapterNumber}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json() as BookContent;
      setBookContent(data);
      setCurrentChapter(chapterNumber);
      
      // Small delay then scroll to appropriate position
      setTimeout(() => {
        // If loading next chapter, scroll to a safe position from top
        // If loading previous chapter, scroll to a safe position from bottom
        if (chapterNumber > currentChapter) {
          window.scrollTo(0, 100); // Start a bit from top when going forward
        } else if (chapterNumber < currentChapter) {
          // Scroll to near bottom when going backward
          const scrollHeight = document.documentElement.scrollHeight;
          const clientHeight = window.innerHeight;
          window.scrollTo(0, scrollHeight - clientHeight - 100);
        } else {
          window.scrollTo(0, 0); // Default to top
        }
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chapter');
      console.error('Error fetching chapter:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Extract book UUID from URL: /book/:uuid or /book/:uuid/chapter/:number
    const match = window.location.pathname.match(/^\/book\/([^\/]+)(?:\/chapter\/(\d+))?$/);
    if (match) {
      const uuid = match[1];
      const chapterFromUrl = match[2] ? parseInt(match[2], 10) : 1;
      setCurrentChapter(isNaN(chapterFromUrl) ? 1 : chapterFromUrl);
      setBookUuid(uuid);
      setShowBookShelf(false);
      return;
    }
    if (window.location.pathname === '/' || window.location.pathname === '') {
      // Root path - show book shelf
      setShowBookShelf(true);
      setLoading(false);
      return;
    }
    setError('Invalid book URL. Expected format: /book/:uuid or /book/:uuid/chapter/:number');
    setLoading(false);
  }, []);

  useEffect(() => {
    // Load chapter when book UUID or currentChapter changes
    if (bookUuid && !showBookShelf) {
      loadChapter(currentChapter || 1);
    }
  }, [bookUuid, showBookShelf, currentChapter]);

  const handleSelectBook = (uuid: string) => {
    setBookUuid(uuid);
    setShowBookShelf(false);
    setBookContent(null);
    setCurrentChapter(1);
    setError(null);
    setLoading(true);
    
    // Update URL to reflect book and chapter 1; effect will load content
    try {
      window.history.pushState({}, '', `/book/${uuid}/chapter/1`);
    } catch {}
  };

  // Show book shelf on root path
  if (showBookShelf) {
    return (
      <div className="App">
        <BookShelf onSelectBook={handleSelectBook} />
      </div>
    );
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

  if (error || !bookContent) {
    return (
      <div className="App">
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div>Error: {error || 'Failed to load book content'}</div>
        </div>
      </div>
    );
  }

  const epubContent = bookContent.content;
  const author = bookContent.author !== 'Unknown Author' ? bookContent.author : '';

  return (
    <div className="App">
      <BilingualReader
        content={epubContent}
        title={bookContent.title}
        author={author}
        styles={bookContent.styles}
        currentChapter={currentChapter}
        onLoadChapter={(n: number) => {
          // Update URL on chapter navigation and let effect trigger load
          if (bookUuid) {
            try {
              window.history.replaceState({}, '', `/book/${bookUuid}/chapter/${n}`);
            } catch {}
          }
          setCurrentChapter(n);
        }}
        isLoading={loading}
        setShowOriginalTitle={setShowOriginalTitle}
        bookUuid={bookUuid || undefined}
      />
    </div>
  );
}

export default App;
