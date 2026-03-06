import React, { useState, useEffect, useCallback, useRef } from 'react';
import BilingualReaderV2 from './components/BilingualReaderV2';
import { fetchWithRetry } from './utils/fetchWithRetry';
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

interface SharedBookViewProps {
  shareToken: string;
}

const PROGRESS_KEY = (token: string) => `ovid_shared_progress_${token}`;

function SharedBookView({ shareToken }: SharedBookViewProps) {
  const [chapterContent, setChapterContent] = useState<ChapterContent | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Restore progress from localStorage
  const savedChapter = useRef(() => {
    try {
      const saved = localStorage.getItem(PROGRESS_KEY(shareToken));
      if (saved) {
        const ch = parseInt(saved, 10);
        if (ch >= 1) return ch;
      }
    } catch {}
    return 1;
  });
  const [currentChapter, setCurrentChapter] = useState(savedChapter.current());

  // Load chapters
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetchWithRetry(`/api/shared/${shareToken}/chapters`);
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setChapters(await res.json() as Chapter[]);
      } catch (err) {
        console.error('Error loading shared chapters:', err);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    load();
  }, [shareToken]);

  const loadChapter = async (chapterNumber: number) => {
    setLoading(true);
    try {
      const res = await fetchWithRetry(`/api/shared/${shareToken}/chapter/${chapterNumber}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ChapterContent;
      setChapterContent(data);
      setCurrentChapter(chapterNumber);
      localStorage.setItem(PROGRESS_KEY(shareToken), String(chapterNumber));
      if (chapterNumber !== currentChapter) {
        setTimeout(() => window.scrollTo(0, 0), 100);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadChapter(savedChapter.current());
  }, [shareToken]);

  const handleLoadChapter = useCallback((n: number) => loadChapter(n), [shareToken]);

  if (notFound) {
    return (
      <div className="App" style={{ textAlign: 'center', padding: '80px 20px' }}>
        <h2>This shared link is no longer available</h2>
        <p style={{ color: '#666', marginTop: '12px' }}>The book owner may have revoked sharing.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="App" style={{ textAlign: 'center', padding: '50px' }}>
        <div>Error: {error}</div>
      </div>
    );
  }

  if (loading && !chapterContent) {
    return (
      <div className="App" style={{ textAlign: 'center', padding: '50px' }}>
        Loading shared book...
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
        bookUuid={chapterContent.uuid}
      />
    </div>
  );
}

export default SharedBookView;
