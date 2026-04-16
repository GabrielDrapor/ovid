import React, { useState, useEffect, useCallback, useRef } from 'react';
import BilingualReaderV2 from './components/BilingualReaderV2';
import { useUser } from './contexts/UserContext';
import { fetchWithRetry } from './utils/fetchWithRetry';
import { getLocalProgress, mergeProgress, PROGRESS_KEY, type ReadingProgress, type CloudProgress } from './utils/reading-progress';
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

// Fetch cloud progress and merge with local — cloud wins if newer
const fetchAndMergeProgress = async (uuid: string): Promise<ReadingProgress> => {
  const local = getLocalProgress(uuid);

  try {
    const response = await fetch(`/api/book/${uuid}/progress`);
    if (!response.ok) return local;

    const data = await response.json() as { progress: CloudProgress | null };
    const { merged, source } = mergeProgress(local, data.progress);

    // Update localStorage if cloud won
    if (source === 'cloud') {
      localStorage.setItem(PROGRESS_KEY(uuid), JSON.stringify(merged));
    }

    return merged;
  } catch {
    return local;
  }
};

function AppV2({ bookUuid, onBackToShelf }: AppV2Props) {
  const [chapterContent, setChapterContent] = useState<ChapterContent | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize from local progress first, then merge with cloud
  const initialProgress = useRef(getLocalProgress(bookUuid));
  const [currentChapter, setCurrentChapter] = useState(initialProgress.current.chapter);
  const [targetXpath, setTargetXpath] = useState<string | undefined>(initialProgress.current.xpath);


  // Track current visible xpath and intra-chapter fraction for saving
  const currentXpathRef = useRef<string | undefined>(undefined);
  const chapterFractionRef = useRef<number>(0);

  // Debounce timer for progress API updates
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Track book completion status
  const [isCompleted, setIsCompleted] = useState(false);

  // Share state
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [bookOwnerId, setBookOwnerId] = useState<number | null>(null);
  const { user } = useUser();

  // Calculate reading progress percentage (chapter-granular + intra-chapter fraction)
  const calculateProgress = useCallback((fraction?: number) => {
    if (chapters.length === 0) return 0;
    const f = fraction ?? chapterFractionRef.current;
    // completedChapters + fraction through current chapter, divided by total
    return Math.min(100, Math.round(((currentChapter - 1 + f) / chapters.length) * 100));
  }, [currentChapter, chapters.length]);

  // Mark book as complete/incomplete and update progress
  const handleMarkComplete = useCallback(async (completed: boolean) => {
    try {
      const progressPercent = calculateProgress();
      const response = await fetch(`/api/book/${bookUuid}/mark-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          isCompleted: completed,
          readingProgress: completed ? 100 : progressPercent 
        }),
      });
      
      if (response.ok) {
        const data = await response.json();
        setIsCompleted(completed);
        console.log('Book marked complete:', data);
      } else {
        const errData = await response.text();
        console.error(`Mark complete failed: ${response.status}`, errData);
        throw new Error(`HTTP ${response.status}: ${errData}`);
      }
    } catch (err) {
      console.error('Error marking book complete:', err);
      // Re-throw so BilingualReaderV2 can show error to user
      throw err;
    }
  }, [bookUuid, calculateProgress]);

  // Save progress to localStorage only (URL stays clean as /book/{uuid})
  const saveProgress = useCallback((chapter: number, xpath?: string) => {
    // When xpath is not provided, preserve the existing saved xpath
    // only if we're on the same chapter (avoids stale xpath from a different chapter)
    if (!xpath) {
      const existing = localStorage.getItem(PROGRESS_KEY(bookUuid));
      if (existing) {
        try {
          const prev = JSON.parse(existing) as ReadingProgress;
          if (prev.chapter === chapter && prev.xpath) {
            xpath = prev.xpath;
          }
        } catch { /* ignore */ }
      }
    }
    const progress: ReadingProgress = {
      chapter,
      xpath,
      timestamp: Date.now(),
    };
    localStorage.setItem(PROGRESS_KEY(bookUuid), JSON.stringify(progress));
  }, [bookUuid]);

  // Called by reader when visible element changes
  const handleProgressChange = useCallback((xpath: string, chapterFraction: number) => {
    currentXpathRef.current = xpath;
    chapterFractionRef.current = chapterFraction;
    // Save to localStorage immediately
    saveProgress(currentChapter, xpath);

    // Debounced API update - save chapter + xpath to backend every 5 seconds
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    progressTimerRef.current = setTimeout(() => {
      const progressPercent = calculateProgress(chapterFraction);
      fetch(`/api/book/${bookUuid}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          readingProgress: progressPercent,
          chapterNumber: currentChapter,
          paragraphXpath: xpath,
        }),
      }).catch(err => console.error('Error saving progress to backend:', err));
    }, 5000);
  }, [currentChapter, saveProgress, bookUuid, calculateProgress]);

  // Load chapters list
  useEffect(() => {
    const loadChapters = async () => {
      try {
        const response = await fetchWithRetry(`/api/v2/book/${bookUuid}/chapters`);
        if (response.status === 404) {
          // Book not found or not accessible — redirect to home
          window.location.replace('/');
          return;
        }
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        setChapters(data as Chapter[]);
      } catch (err) {
        console.error('Error fetching chapters:', err);
      }
    };

    const loadCompletion = async () => {
      try {
        const response = await fetch(`/api/book/${bookUuid}/progress`);
        if (response.ok) {
          const data = await response.json();
          if (data.progress?.is_completed) {
            setIsCompleted(true);
          }
        }
      } catch (err) {
        console.error('Error fetching completion status:', err);
      }
    };

    const loadShareStatus = async () => {
      try {
        const response = await fetch(`/api/book/${bookUuid}/share`);
        if (response.ok) {
          const data = await response.json() as { token: string | null };
          setShareToken(data.token);
        }
      } catch (err) {
        // Not owner or not logged in — ignore
      }
    };

    // Fetch book metadata to know the owner
    const loadBookMeta = async () => {
      try {
        const response = await fetch('/api/books');
        if (response.ok) {
          const books = await response.json() as Array<{ uuid: string; user_id: number | null }>;
          const book = books.find((b: any) => b.uuid === bookUuid);
          if (book) setBookOwnerId(book.user_id);
        }
      } catch {
        // ignore
      }
    };

    loadChapters();
    loadCompletion();
    loadShareStatus();
    loadBookMeta();
  }, [bookUuid]);

  // Load chapter content
  const loadChapter = async (chapterNumber: number, scrollToXpath?: string) => {
    // Cancel any pending progress save from the previous chapter
    // to prevent stale chapter data from overwriting the new chapter
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setLoading(true);
    try {
      const response = await fetchWithRetry(`/api/v2/book/${bookUuid}/chapter/${chapterNumber}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setChapterContent(data as ChapterContent);
      setCurrentChapter(chapterNumber);

      // Auto-update reading progress in database (fire-and-forget)
      // Use PUT progress endpoint to avoid resetting completion status
      // When entering a chapter, fraction is 0 (top of chapter)
      chapterFractionRef.current = 0;
      if (chapters.length > 0) {
        const progressPercent = Math.min(100, Math.round(((chapterNumber - 1) / chapters.length) * 100));
        fetch(`/api/book/${bookUuid}/progress`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            readingProgress: progressPercent,
            chapterNumber: chapterNumber,
            paragraphXpath: scrollToXpath || null,
          }),
        }).catch(err => console.error('Error updating progress:', err));
      }

      // Set target xpath for scroll (or clear it for new chapter)
      setTargetXpath(scrollToXpath);

      // Only save progress with xpath when we actually have one;
      // don't overwrite good progress with empty/undefined xpath
      if (scrollToXpath) {
        saveProgress(chapterNumber, scrollToXpath);
      } else {
        // Save chapter number only, preserving any existing xpath via
        // a fresh save without xpath (the reader observer will update it soon)
        saveProgress(chapterNumber);
      }

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

  // Initial chapter load — merge cloud progress, then load
  useEffect(() => {
    const init = async () => {
      const merged = await fetchAndMergeProgress(bookUuid);
      initialProgress.current = merged;
      
      // If cloud had a different chapter/xpath, update state before loading
      if (merged.chapter !== currentChapter || merged.xpath !== targetXpath) {
        setCurrentChapter(merged.chapter);
        setTargetXpath(merged.xpath);
      }
      
      await loadChapter(merged.chapter, merged.xpath);
    };
    init();
  }, [bookUuid]);

  // Flush current reading position to localStorage AND backend on page exit or tab hide
  useEffect(() => {
    const flushProgress = () => {
      if (currentXpathRef.current) {
        saveProgress(currentChapter, currentXpathRef.current);
        
        // Also flush to backend using sendBeacon for reliability
        const progressPercent = chapters.length > 0
          ? Math.min(100, Math.round(((currentChapter - 1 + chapterFractionRef.current) / chapters.length) * 100))
          : 0;
        const payload = JSON.stringify({
          readingProgress: progressPercent,
          chapterNumber: currentChapter,
          paragraphXpath: currentXpathRef.current,
        });
        // sendBeacon is reliable even during page unload (sends POST)
        // Backend accepts both PUT and POST for progress updates
        navigator.sendBeacon(
          `/api/book/${bookUuid}/progress`,
          new Blob([payload], { type: 'application/json' })
        );
      }
    };

    const handleBeforeUnload = () => flushProgress();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushProgress();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
      }
    };
  }, [currentChapter, saveProgress, bookUuid, chapters.length]);

  const isOwner = !!(user && bookOwnerId && user.id === bookOwnerId);

  const handleShare = useCallback(async () => {
    const response = await fetch(`/api/book/${bookUuid}/share`, { method: 'POST' });
    if (response.ok) {
      const data = await response.json() as { token: string; url: string };
      setShareToken(data.token);
      // Auto-copy to clipboard
      try {
        await navigator.clipboard.writeText(data.url);
      } catch { /* clipboard may fail */ }
    } else {
      throw new Error('Failed to create share link');
    }
  }, [bookUuid]);

  const handleRevokeShare = useCallback(async () => {
    const response = await fetch(`/api/book/${bookUuid}/share`, { method: 'DELETE' });
    if (response.ok) {
      setShareToken(null);
    } else {
      throw new Error('Failed to revoke share');
    }
  }, [bookUuid]);

  // Wrapper for manual chapter navigation (no xpath) - must be before early returns.
  // Returns the Promise so the reader can await it inside document.startViewTransition().
  const handleLoadChapter = useCallback((chapterNumber: number) => {
    return loadChapter(chapterNumber);
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
        isOwner={isOwner}
        shareToken={shareToken}
        onShare={handleShare}
        onRevokeShare={handleRevokeShare}
        initialXpath={targetXpath}
        onProgressChange={handleProgressChange}
      />
    </div>
  );
}

export default AppV2;
