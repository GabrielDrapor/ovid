import React, { useState, useEffect, useCallback, useRef } from 'react';
import BilingualReaderV2 from './BilingualReaderV2';
import ReaderStatus from './ReaderStatus';
import { fetchWithRetry } from '../utils/fetchWithRetry';
import { useI18n } from '../i18n';
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
  const { t } = useI18n();
  const [chapterContent, setChapterContent] = useState<ChapterContent | null>(
    null
  );
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  // 'invalid': the link was revoked or never existed (the API answers 404).
  // 'book': the chapter list failed. { chapter }: that chapter failed. The
  // last two can be retried.
  const [error, setError] = useState<
    'invalid' | 'book' | { chapter: number } | null
  >(null);
  const [currentChapter, setCurrentChapter] = useState(1);

  const loadChapters = async () => {
    try {
      const response = await fetchWithRetry(
        `/api/shared/${shareToken}/chapters`
      );
      if (response.status === 404) {
        setError('invalid');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setChapters(data as Chapter[]);
    } catch (err) {
      setError((prev) => prev ?? 'book');
    }
  };

  // Load chapters list
  useEffect(() => {
    loadChapters();
  }, [shareToken]);

  const loadChapter = async (chapterNumber: number) => {
    setLoading(true);
    try {
      const response = await fetchWithRetry(
        `/api/shared/${shareToken}/chapter/${chapterNumber}`
      );
      if (response.status === 404) {
        setError('invalid');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setChapterContent(data as ChapterContent);
      setCurrentChapter(chapterNumber);
      window.scrollTo(0, 0);
    } catch (err) {
      // An invalid link wins over a chapter error from the same failure.
      setError((prev) =>
        prev === 'invalid' ? prev : { chapter: chapterNumber }
      );
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadChapter(1);
  }, [shareToken]);

  const handleLoadChapter = useCallback(
    (chapterNumber: number) => {
      return loadChapter(chapterNumber);
    },
    [shareToken]
  );

  if (error === 'invalid') {
    return (
      <ReaderStatus
        title={t.shared.linkInvalid}
        actions={
          <a className="reader-status-btn reader-status-btn-primary" href="/">
            {t.shared.goToLibrary}
          </a>
        }
      >
        {t.shared.linkInvalidMessage}
      </ReaderStatus>
    );
  }

  if (error) {
    return (
      <ReaderStatus
        title={
          error === 'book'
            ? t.shared.loadBookFailed
            : t.shared.loadChapterFailed
        }
        actions={
          <>
            <button
              className="reader-status-btn reader-status-btn-primary"
              onClick={() => {
                setError(null);
                if (error === 'book' || chapters.length === 0) loadChapters();
                loadChapter(error === 'book' ? currentChapter : error.chapter);
              }}
            >
              {t.errors.tryAgain}
            </button>
            <a className="reader-status-btn" href="/">
              {t.shared.goToLibrary}
            </a>
          </>
        }
      >
        {t.book.loadFailedMessage}
      </ReaderStatus>
    );
  }

  if (loading && !chapterContent) {
    return <ReaderStatus>{t.shared.loadingSharedBook}</ReaderStatus>;
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
        onBackToShelf={() => {
          window.location.href = '/';
        }}
      />
    </div>
  );
}

export default SharedBookView;
