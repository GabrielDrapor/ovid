import React, { useState, useEffect } from 'react';
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

function AppV2({ bookUuid, onBackToShelf }: AppV2Props) {
  const [chapterContent, setChapterContent] = useState<ChapterContent | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentChapter, setCurrentChapter] = useState(1);

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
  const loadChapter = async (chapterNumber: number) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v2/book/${bookUuid}/chapter/${chapterNumber}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setChapterContent(data as ChapterContent);
      setCurrentChapter(chapterNumber);

      // Scroll to top
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

  // Initial chapter load
  useEffect(() => {
    loadChapter(currentChapter);
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
        onLoadChapter={loadChapter}
        isLoading={loading}
        bookUuid={bookUuid}
        onBackToShelf={onBackToShelf}
      />
    </div>
  );
}

export default AppV2;
