import React, { useState, useEffect, useCallback, useRef } from 'react';
import BilingualReaderV2 from './components/BilingualReaderV2';
import './App.css';

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
  original_html?: string;
  translated_text: string;
}

interface ChapterContent {
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
  rawHtml: string;
  translations: Translation[];
}

interface AppV2Props {
  bookUuid: string;
  onBackToShelf: () => void;
}

// Granular reading progress: chapter + xpath position
interface ReadingProgress {
  chapter: number;
  xpath?: string;  // XPath of the element in view
  timestamp: number;
}

const PROGRESS_KEY = (uuid: string) => `ovid_progress_v2_${uuid}`;

// Get initial progress from URL hash or localStorage
const getInitialProgress = (uuid: string): ReadingProgress => {
  // First, check URL hash (e.g., #chapter-5 or #chapter-5:/body[1]/p[3])
  const hash = window.location.hash;
  const hashMatch = hash.match(/^#chapter-(\d+)(?::(.+))?$/);
  if (hashMatch) {
    const chapter = parseInt(hashMatch[1], 10);
    const xpath = hashMatch[2] ? decodeURIComponent(hashMatch[2]) : undefined;
    if (chapter >= 1) {
      return { chapter, xpath, timestamp: Date.now() };
    }
  }

  // Fall back to localStorage (new format)
  const saved = localStorage.getItem(PROGRESS_KEY(uuid));
  if (saved) {
    try {
      const progress = JSON.parse(saved) as ReadingProgress;
      if (progress.chapter >= 1) return progress;
    } catch {
      // Ignore parse errors
    }
  }

  // Fall back to old format for migration
  const oldSaved = localStorage.getItem(`ovid_progress_${uuid}`);
  if (oldSaved) {
    const chapter = parseInt(oldSaved, 10);
    if (chapter >= 1) return { chapter, timestamp: Date.now() };
  }

  return { chapter: 1, timestamp: Date.now() };
};

function AppV2({ bookUuid, onBackToShelf }: AppV2Props) {
  const [chapterContent, setChapterContent] = useState<ChapterContent | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize from saved progress
  const initialProgress = useRef(getInitialProgress(bookUuid));
  const [currentChapter, setCurrentChapter] = useState(initialProgress.current.chapter);
  const [targetXpath, setTargetXpath] = useState<string | undefined>(initialProgress.current.xpath);

  // Track current visible xpath for saving
  const currentXpathRef = useRef<string | undefined>(undefined);

  // Track book completion status
  const [isCompleted, setIsCompleted] = useState(false);

  // Mark book as complete/incomplete
  const handleMarkComplete = useCallback(async (completed: boolean) => {
    try {
      const response = await fetch(`/api/book/${bookUuid}/mark-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isCompleted: completed }),
      });
      if (response.ok) {
        setIsCompleted(completed);
      }
    } catch (err) {
      console.error('Error marking book:', err);
    }
  }, [bookUuid]);

  // Save progress to localStorage and URL
  const saveProgress = useCallback((chapter: number, xpath?: string) => {
    const progress: ReadingProgress = {
      chapter,
      xpath,
      timestamp: Date.now(),
    };
    localStorage.setItem(PROGRESS_KEY(bookUuid), JSON.stringify(progress));

    // Update URL hash
    const xpathPart = xpath ? `:${encodeURIComponent(xpath)}` : '';
    const newHash = `#chapter-${chapter}${xpathPart}`;
    if (window.location.hash !== newHash) {
      window.history.replaceState(null, '', newHash);
    }
  }, [bookUuid]);

  // Called by reader when visible element changes
  const handleProgressChange = useCallback((xpath: string) => {
    currentXpathRef.current = xpath;
    // Debounced save - only save every 2 seconds to avoid excessive writes
    saveProgress(currentChapter, xpath);
  }, [currentChapter, saveProgress]);

  // Load chapters list
  useEffect(() => {
    const loadChapters = async () => {
      try {
        const response = await fetch(`/api/v2/book/${bookUuid}/chapters`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        setChapters(data as Chapter[]);
      } catch (err) {
        console.error('Error fetching chapters:', err);
      }
    };

    loadChapters();
  }, [bookUuid]);

  // Load chapter content
  const loadChapter = async (chapterNumber: number, scrollToXpath?: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v2/book/${bookUuid}/chapter/${chapterNumber}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setChapterContent(data as ChapterContent);
      setCurrentChapter(chapterNumber);

      // Set target xpath for scroll (or clear it for new chapter)
      setTargetXpath(scrollToXpath);

      // Save progress - xpath will be updated when reader reports visible element
      saveProgress(chapterNumber, scrollToXpath);

      // If no target xpath, scroll to top
      if (!scrollToXpath) {
        setTimeout(() => {
          window.scrollTo(0, 0);
        }, 100);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chapter');
      console.error('Error fetching chapter:', err);
    } finally {
      setLoading(false);
    }
  };

  // Initial chapter load - include xpath from saved progress
  useEffect(() => {
    loadChapter(initialProgress.current.chapter, initialProgress.current.xpath);
  }, [bookUuid]);

  // Wrapper for manual chapter navigation (no xpath) - must be before early returns
  const handleLoadChapter = useCallback((chapterNumber: number) => {
    loadChapter(chapterNumber);
  }, [bookUuid]);

  if (error) {
    return (
      <div className="App">
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div>Error: {error}</div>
          <button onClick={onBackToShelf}>Go Home</button>
        </div>
      </div>
    );
  }

  if (loading && !chapterContent) {
    return (
      <div className="App">
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div>Loading book content...</div>
        </div>
      </div>
    );
  }

  if (!chapterContent) return null;

  return (
    <div className="App">
      <BilingualReaderV2
        rawHtml={chapterContent.rawHtml}
        translations={chapterContent.translations}
        styles={chapterContent.styles}
        title={chapterContent.title}
        author={chapterContent.author}
        currentChapter={currentChapter}
        totalChapters={chapters.length}
        chapters={chapters}
        onLoadChapter={handleLoadChapter}
        isLoading={loading}
        bookUuid={bookUuid}
        onBackToShelf={onBackToShelf}
        onMarkComplete={handleMarkComplete}
        isCompleted={isCompleted}
        initialXpath={targetXpath}
        onProgressChange={handleProgressChange}
      />
    </div>
  );
}

export default AppV2;
