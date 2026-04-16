import React, { useState, useEffect, useCallback, useRef } from 'react';
import BilingualReaderV2 from './BilingualReaderV2';
import { fetchWithRetry } from '../utils/fetchWithRetry';
import '../App.css';

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

function SharedBookView({ shareToken }: SharedBookViewProps) {
  const [chapterContent, setChapterContent] = useState<ChapterContent | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentChapter, setCurrentChapter] = useState(1);

  // Load chapters list
  useEffect(() => {
    const loadChapters = async () => {
      try {
        const response = await fetchWithRetry(`/api/shared/${shareToken}/chapters`);
        if (response.status === 404) {
          setError('This shared link is no longer valid.');
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setChapters(data as Chapter[]);
      } catch (err) {
        setError('Failed to load book.');
      }
    };
    loadChapters();
  }, [shareToken]);

  const loadChapter = async (chapterNumber: number) => {
    setLoading(true);
    try {
      const response = await fetchWithRetry(`/api/shared/${shareToken}/chapter/${chapterNumber}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setChapterContent(data as ChapterContent);
      setCurrentChapter(chapterNumber);
      window.scrollTo(0, 0);
    } catch (err) {
      setError('Failed to load chapter.');
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadChapter(1);
  }, [shareToken]);

  const handleLoadChapter = useCallback((chapterNumber: number) => {
    return loadChapter(chapterNumber);
  }, [shareToken]);

  if (error) {
    return (
      <div className="App">
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <div>{error}</div>
          <a href="/" style={{ color: '#666', marginTop: '20px', display: 'inline-block' }}>Go to Library</a>
        </div>
      </div>
    );
  }

  if (loading && !chapterContent) {
    return (
      <div className="App">
        <div style={{ textAlign: 'center', padding: '50px' }}>Loading shared book...</div>
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
        onBackToShelf={() => { window.location.href = '/'; }}
      />
    </div>
  );
}

export default SharedBookView;
