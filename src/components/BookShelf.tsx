import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useUser } from '../contexts/UserContext';
import './BookShelf.css';

interface Book {
  id: number;
  uuid: string;
  title: string;
  original_title: string;
  author: string;
  language_pair: string;
  book_cover_img_url: string | null;
  book_spine_img_url: string | null;
  user_id: number | null;
  status: string | null; // 'ready' | 'processing' | 'error'
  created_at: string;
  updated_at: string;
}

interface UserBookProgress {
  id: number;
  user_id: number;
  book_uuid: string;
  is_completed: number; // 0 or 1
  reading_progress: number | null;
  completed_at: string | null;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BookShelfProps {
  onSelectBook: (bookUuid: string) => void;
}

const BookShelf: React.FC<BookShelfProps> = ({ onSelectBook }) => {
  const [books, setBooks] = useState<Book[]>([]);
  const [bookProgressMap, setBookProgressMap] = useState<Map<string, UserBookProgress>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredBook, setHoveredBook] = useState<Book | null>(null);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const [mobileSelectedBook, setMobileSelectedBook] = useState<Book | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const [shelfPos, setShelfPos] = useState({ row1Bottom: '52%', row2Bottom: '4%', actionsTop: '48%', actionsLeft: '250px' });
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [uploadError, setUploadError] = useState<{ message: string; required?: number; available?: number } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState<{
    file: File;
    title: string;
    author: string;
    chapters: number;
    characters: number;
    estimatedTokens: number;
    requiredCredits: number;
    availableCredits: number;
    canAfford: boolean;
  } | null>(null);
  const { user, loading: userLoading, login, logout, credits, creditPackages, purchaseCredits, refreshCredits } = useUser();

  const fetchBooks = async () => {
    try {
      const response = await fetch('/api/v2/books');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const booksData = await response.json();
      const booksList = Array.isArray(booksData) ? booksData as Book[] : [];
      setBooks(booksList);
      if (booksData.length > 0 && !hoveredBook) {
        setHoveredBook(booksData[0]);
      }
      setLoading(false);

      // Preload cover images into browser cache
      booksData.forEach((book) => {
        if (book.book_cover_img_url) {
          const img = new Image();
          img.src = book.book_cover_img_url;
        }
      });

      // Fetch all progress in a single request
      if (user && booksData.length > 0) {
        try {
          const progressResponse = await fetch('/api/progress');
          if (progressResponse.ok) {
            const data = await progressResponse.json() as { progress: Record<string, UserBookProgress> };
            const progressMap = new Map<string, UserBookProgress>();
            for (const [uuid, p] of Object.entries(data.progress)) {
              progressMap.set(uuid, p);
            }
            setBookProgressMap(progressMap);
          }
        } catch {
          // Silently skip
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch books');
      console.error('Error fetching books:', err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBooks();
  }, [user]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Dynamically compute shelf positions based on background-size: cover scaling
  useEffect(() => {
    const wall = wallRef.current;
    if (!wall) return;
    const IMG_W = 1248, IMG_H = 864;
    // Shelf board positions in image pixel coordinates
    const ROW1_Y = 411;  // middle board top (where row-1 books sit)
    const ROW2_Y = 832;  // bottom board top (where row-2 books sit)
    const ACT_Y = 418;   // actions vertical position
    const ACT_X = 260;   // actions horizontal position
    const BOOK_H = 312;  // book height in image coordinates
    const update = () => {
      const { width, height } = wall.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const scale = Math.max(width / IMG_W, height / IMG_H);
      // Set CSS variables for proportional scaling
      wall.style.setProperty('--book-height', `${BOOK_H * scale}px`);
      wall.style.setProperty('--shelf-scale', `${scale}`);
      setShelfPos({
        row1Bottom: `${(1 - ROW1_Y * scale / height) * 100}%`,
        row2Bottom: `${(1 - ROW2_Y * scale / height) * 100}%`,
        actionsTop: `${(ACT_Y * scale / height) * 100}%`,
        actionsLeft: `${ACT_X * scale}px`,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(wall);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
        setShowHelpMenu(false);
      }
    };
    if (showHelpMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showHelpMenu]);

  // Drive translation for books that are still processing.
  // Each call to /translate-next translates a chunk of ~25 paragraphs,
  // staying within Cloudflare Workers' 50 subrequest limit.
  const [translationProgress, setTranslationProgress] = useState<Map<string, { phase: string; chaptersCompleted: number; chaptersTotal: number }>>(new Map());
  const translatingRef = useRef<Set<string>>(new Set());
  const pollProcessingBooks = useCallback(async () => {
    const booksList = Array.isArray(books) ? books : [];
    const processingBooks = booksList.filter(b => b.status === 'processing');
    if (processingBooks.length === 0) return;

    let changed = false;
    for (const book of processingBooks) {
      // Don't send a new request while a previous one is still in-flight
      if (translatingRef.current.has(book.uuid)) continue;
      translatingRef.current.add(book.uuid);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);
        const res = await fetch(`/api/book/${book.uuid}/translate-next`, {
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json() as { done?: boolean; error?: string; progress?: { phase: string; chaptersCompleted: number; chaptersTotal: number } };
          if (data.progress) {
            setTranslationProgress(prev => {
              const next = new Map(prev);
              next.set(book.uuid, data.progress!);
              return next;
            });
          }
          if (data.done) {
            changed = true;
            setTranslationProgress(prev => {
              const next = new Map(prev);
              next.delete(book.uuid);
              return next;
            });
          }
        }
      } catch { /* ignore, will retry on next poll */ }
      finally {
        translatingRef.current.delete(book.uuid);
      }
    }
    if (changed) {
      await fetchBooks();
    }
  }, [books]);

  // Fetch initial translation progress for processing books on mount
  const initialProgressFetched = useRef(false);
  useEffect(() => {
    const booksList = Array.isArray(books) ? books : [];
    const processingBooks = booksList.filter(b => b.status === 'processing');
    if (processingBooks.length === 0) return;

    // Fetch current progress from server only once per processing book
    if (!initialProgressFetched.current) {
      initialProgressFetched.current = true;
      processingBooks.forEach(async (book) => {
        try {
          const res = await fetch(`/api/book/${book.uuid}/status`);
          if (res.ok) {
            const data = await res.json() as { status: string; progress?: { phase: string; chaptersCompleted: number; chaptersTotal: number } };
            if (data.progress) {
              setTranslationProgress(prev => {
                const next = new Map(prev);
                next.set(book.uuid, data.progress!);
                return next;
              });
            }
          }
        } catch { /* ignore */ }
      });
    }

    // Drive translation immediately, then every 3s
    pollProcessingBooks();
    const interval = setInterval(pollProcessingBooks, 3000);
    return () => clearInterval(interval);
  }, [books, pollProcessingBooks]);

  const handleFileSelect = async (file: File) => {
    if (!user) {
      alert('Please login to upload books');
      return;
    }

    setEstimating(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('targetLanguage', 'zh');

      const response = await fetch('/api/books/estimate', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string; details?: string };
        throw new Error(errorData.error || 'Failed to estimate');
      }

      const estimateData = await response.json() as {
        title: string;
        author: string;
        chapters: number;
        characters: number;
        estimatedTokens: number;
        requiredCredits: number;
        availableCredits: number;
        canAfford: boolean;
      };

      setEstimate({ ...estimateData, file });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to estimate book');
    } finally {
      setEstimating(false);
    }
  };

  const handleConfirmUpload = async () => {
    if (!estimate) return;

    setUploading(true);
    setUploadProgress('Uploading...');
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append('file', estimate.file);
      formData.append('targetLanguage', 'zh');
      formData.append('sourceLanguage', 'en');

      const response = await fetch('/api/books/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string; required?: number; available?: number; message?: string };

        if (response.status === 402) {
          setUploadError({
            message: errorData.message || 'Insufficient credits',
            required: errorData.required,
            available: errorData.available,
          });
          setUploading(false);
          setUploadProgress('');
          setEstimate(null);
          return;
        }

        throw new Error(errorData.error || 'Upload failed');
      }

      // Close modal immediately - book will appear on shelf in processing state
      setShowUploadModal(false);
      setUploadProgress('');
      setUploading(false);
      setEstimate(null);

      await fetchBooks();
      await refreshCredits();
    } catch (err) {
      setUploadProgress('');
      setUploading(false);
      alert(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const handleCancelEstimate = () => {
    setEstimate(null);
    setUploadError(null);
  };

  const handleDeleteBook = async (bookUuid: string) => {
    if (!confirm('Are you sure you want to remove this book?')) return;
    try {
      const response = await fetch(`/api/book/${bookUuid}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || 'Failed to delete');
      }
      setHoveredBook(null);
      await fetchBooks();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete book');
    }
  };

  if (error) {
    return (
      <div className="bookshelf-error">
        <h2>Unable to load books</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="bookshelf-container">
      <div className="bookshelf-wall" ref={wallRef} style={{ backgroundImage: 'url(/bookcase_bg.jpeg)' }}>
        {(() => {
          const safeBooks = Array.isArray(books) ? books : [];
          const publicBooks = safeBooks.filter(b => !b.user_id);
          const userBooks = safeBooks.filter(b => !!b.user_id);
          const renderBook = (book: Book) => {
            const isProcessing = book.status === 'processing';
            return (
              <div
                key={book.uuid}
                className={`book-spine-wrapper ${isProcessing ? 'processing' : ''}`}
                onMouseEnter={() => { if (!isMobile) { setCoverLoaded(false); setHoveredBook(book); } }}
                onMouseLeave={() => {}}
                onClick={() => {
                  if (isProcessing) return;
                  if (isMobile) {
                    setMobileSelectedBook(book);
                  } else {
                    onSelectBook(book.uuid);
                  }
                }}
              >
                <div className="book-spine-container">
                  {book.book_spine_img_url ? (
                    <img
                      src={book.book_spine_img_url}
                      alt={`${book.title} spine`}
                      className="book-spine-img"
                    />
                  ) : (
                    <div className="book-spine-default" style={{ backgroundColor: stringToColor(book.title) }}>
                      <span className="spine-title">{book.original_title || book.title}</span>
                    </div>
                  )}
                </div>
                {isProcessing && <div className="book-processing-overlay"><div className="processing-spinner"></div></div>}
              </div>
            );
          };
          return (
            <div className="shelf-content" style={{ opacity: loading ? 0 : 1, transition: 'opacity 0.5s ease-in-out' }}>
              {publicBooks.length === 0 && userBooks.length === 0 && !loading && (
                <div className="empty-shelf-guide">
                  <div className="empty-shelf-content">
                    <h2>Welcome to Ovid</h2>
                    <p className="empty-shelf-desc">
                      双语阅读器 — 上传 EPUB，点击段落即可切换原文与翻译
                    </p>
                    <p className="empty-shelf-desc-en">
                      A bilingual reader. Upload any EPUB, tap a paragraph to toggle between original and translation.
                    </p>
                    {user ? (
                      <button className="empty-shelf-upload-btn" onClick={() => setShowUploadModal(true)}>
                        Upload your first book
                      </button>
                    ) : (
                      <button className="empty-shelf-login-btn" onClick={login}>
                        Sign in to get started
                      </button>
                    )}
                  </div>
                </div>
              )}
              {publicBooks.length > 0 && (
                <div className="books-grid" style={{ bottom: shelfPos.row1Bottom }}>
                  {publicBooks.map(renderBook)}
                </div>
              )}
              <div className="shelf-actions" style={{ top: shelfPos.actionsTop, left: shelfPos.actionsLeft }}>
                  {userLoading ? null : user ? (
                    <>
                      <button
                        className="shelf-avatar-btn"
                        onClick={() => setShowUserMenu(!showUserMenu)}
                      >
                        {user.picture ? (
                          <img src={user.picture} alt={user.name} className="user-avatar" />
                        ) : (
                          <div className="user-avatar-placeholder">
                            {user.name?.charAt(0) || user.email.charAt(0)}
                          </div>
                        )}
                      </button>
                      <button
                        className="shelf-upload-btn"
                        onClick={() => setShowUploadModal(true)}
                        title="Upload Book"
                      >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="17 8 12 3 7 8"/>
                          <line x1="12" y1="3" x2="12" y2="15"/>
                        </svg>
                      </button>
                      {showUserMenu && (
                        <div className="shelf-user-dropdown">
                          <div className="user-info">
                            <span className="user-name">{user.name}</span>
                            <span className="user-email">{user.email}</span>
                          </div>
                          <div className="user-credits">
                            <span className="credits-label">Credits</span>
                            <span className="credits-amount">{credits?.toLocaleString() ?? '...'}</span>
                          </div>
                          <button className="buy-credits-btn" onClick={() => { setShowUserMenu(false); setShowCreditsModal(true); }}>
                            Buy Credits
                          </button>
                          <button className="logout-btn" onClick={logout}>
                            Logout
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <button className="shelf-signin-btn" onClick={login}>
                      <svg className="google-icon" viewBox="0 0 24 24" width="16" height="16">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                      <span>Sign in</span>
                    </button>
                  )}
                  <div className="shelf-help-wrapper" ref={helpRef}>
                    <button
                      className="shelf-help-btn"
                      onClick={() => setShowHelpMenu(!showHelpMenu)}
                      title="Help"
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
                      </svg>
                    </button>
                    {showHelpMenu && (
                      <div className="shelf-help-dropdown">
                        <a
                          href="https://github.com/GabrielDrapor/ovid"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shelf-help-item"
                          onClick={() => setShowHelpMenu(false)}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                          </svg>
                          <span>GitHub</span>
                        </a>
                        <a
                          href="https://discord.gg/DBbB7qSXZf"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shelf-help-item"
                          onClick={() => setShowHelpMenu(false)}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                          </svg>
                          <span>Discord</span>
                        </a>
                      </div>
                    )}
                  </div>
              </div>
              {userBooks.length > 0 && (
                <div className="books-grid" style={{ bottom: shelfPos.row2Bottom }}>
                  {userBooks.map(renderBook)}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      <div className="book-preview-sidebar">
        {hoveredBook && (
          <div className="preview-content">
            <div className="preview-cover">
              {hoveredBook.book_cover_img_url ? (
                <img
                  key={hoveredBook.uuid}
                  src={hoveredBook.book_cover_img_url}
                  alt={hoveredBook.title}
                  className={coverLoaded ? 'cover-loaded' : 'cover-loading'}
                  onLoad={() => setCoverLoaded(true)}
                />
              ) : (
                <div className="default-preview-cover">
                  <h3>{hoveredBook.title}</h3>
                  <p>{hoveredBook.author}</p>
                </div>
              )}
            </div>

            <div className="preview-info">
              <h2>{hoveredBook.original_title || hoveredBook.title}</h2>
              {hoveredBook.original_title && hoveredBook.title !== hoveredBook.original_title && (
                <h3 className="translated-title">{hoveredBook.title}</h3>
              )}
              <p className="author">By {hoveredBook.author}</p>

              {hoveredBook.status === 'processing' ? (
                <div className="book-status-processing">
                  <div className="processing-spinner"></div>
                  {(() => {
                    const tp = translationProgress.get(hoveredBook.uuid);
                    if (tp && tp.chaptersTotal > 0) {
                      const pct = Math.round((tp.chaptersCompleted / tp.chaptersTotal) * 100);
                      return (
                        <>
                          <span>Translating... {tp.chaptersCompleted}/{tp.chaptersTotal} chapters ({pct}%)</span>
                          <div className="translation-progress-bar">
                            <div className="translation-progress-fill" style={{ width: `${pct}%` }}></div>
                          </div>
                        </>
                      );
                    }
                    return <span>{tp?.phase === 'glossary' ? 'Extracting glossary...' : 'Translating...'}</span>;
                  })()}
                </div>
              ) : hoveredBook.status === 'error' ? (
                <div className="book-status-error">
                  <span>Translation failed</span>
                </div>
              ) : null}
              {(() => {
                const progress = bookProgressMap.get(hoveredBook.uuid);
                const progressPercent = progress?.is_completed ? 100 : (progress?.reading_progress || 0);
                const statusText = progress?.is_completed 
                  ? '✓ Completed' 
                  : progressPercent > 0 
                    ? `${progressPercent}% read` 
                    : 'Not started';
                return (
                  <>
                    {/* Progress bar - show only for ready books */}
                    {user && hoveredBook.status !== 'processing' && (
                      <div className="progress-section">
                        <div className="progress-bar">
                          <div 
                            className="progress-fill" 
                            style={{ width: `${progressPercent}%` }}
                          ></div>
                        </div>
                        <span className="progress-text">
                          {statusText}
                        </span>
                      </div>
                    )}
                    
                    {/* Remove button - only for user-owned books */}
                    {hoveredBook.user_id && (
                      <button
                        className="remove-book-btn"
                        onClick={(e) => { e.stopPropagation(); handleDeleteBook(hoveredBook.uuid); }}
                        title="Remove Book"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                          <line x1="10" y1="11" x2="10" y2="17"/>
                          <line x1="14" y1="11" x2="14" y2="17"/>
                        </svg>
                        <span>Remove</span>
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Auth is now in shelf-actions on the shelf */}
      </div>

      {/* Mobile floating auth removed - now in shelf-actions */}

      {/* Mobile book bottom sheet */}
      {isMobile && mobileSelectedBook && (
        <>
          <div className="mobile-book-sheet-overlay" onClick={() => setMobileSelectedBook(null)} />
          <div className="mobile-book-sheet">
            <div className="sheet-handle" />
            {mobileSelectedBook.book_cover_img_url && (
              <img src={mobileSelectedBook.book_cover_img_url} alt={mobileSelectedBook.title} className="sheet-cover" />
            )}
            <h2 className="sheet-title">{mobileSelectedBook.original_title || mobileSelectedBook.title}</h2>
            {mobileSelectedBook.original_title && mobileSelectedBook.title !== mobileSelectedBook.original_title && (
              <p className="sheet-translated-title">{mobileSelectedBook.title}</p>
            )}
            <p className="sheet-author">By {mobileSelectedBook.author}</p>

            {(() => {
              const progress = bookProgressMap.get(mobileSelectedBook.uuid);
              const progressPercent = progress?.is_completed ? 100 : (progress?.reading_progress || 0);
              const statusText = progress?.is_completed
                ? '✓ Completed'
                : progressPercent > 0
                  ? `${progressPercent}% read`
                  : 'Not started';
              return user && mobileSelectedBook.status !== 'processing' ? (
                <div className="progress-section">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progressPercent}%` }}></div>
                  </div>
                  <span className="progress-text">{statusText}</span>
                </div>
              ) : null;
            })()}

            {mobileSelectedBook.status === 'processing' ? (
              <div className="sheet-status">
                <div className="processing-spinner" style={{ margin: '0 auto 8px' }}></div>
                {(() => {
                  const tp = translationProgress.get(mobileSelectedBook.uuid);
                  if (tp && tp.chaptersTotal > 0) {
                    const pct = Math.round((tp.chaptersCompleted / tp.chaptersTotal) * 100);
                    return <span>Translating... {tp.chaptersCompleted}/{tp.chaptersTotal} chapters ({pct}%)</span>;
                  }
                  return <span>Translating...</span>;
                })()}
              </div>
            ) : mobileSelectedBook.status === 'error' ? (
              <div className="sheet-status" style={{ color: '#ff6b6b' }}>Translation failed</div>
            ) : (
              <button className="sheet-read-btn" onClick={() => { setMobileSelectedBook(null); onSelectBook(mobileSelectedBook.uuid); }}>
                Read
              </button>
            )}

            {mobileSelectedBook.user_id && (
              <button
                className="remove-book-btn"
                onClick={(e) => { e.stopPropagation(); handleDeleteBook(mobileSelectedBook.uuid); setMobileSelectedBook(null); }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                <span>Remove</span>
              </button>
            )}
          </div>
        </>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="upload-modal-overlay" onClick={() => !uploading && !estimating && !uploadError && !estimate && setShowUploadModal(false)}>
          <div className="upload-modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>Upload Book</h2>
            {uploadError ? (
              <div className="upload-error">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <p className="error-message">{uploadError.message}</p>
                {uploadError.required && uploadError.available !== undefined && (
                  <div className="credit-details">
                    <div className="credit-row">
                      <span>Required:</span>
                      <span className="required">{uploadError.required.toLocaleString()} credits</span>
                    </div>
                    <div className="credit-row">
                      <span>Available:</span>
                      <span className="available">{uploadError.available.toLocaleString()} credits</span>
                    </div>
                    <div className="credit-row">
                      <span>Need:</span>
                      <span className="needed">{(uploadError.required - uploadError.available).toLocaleString()} more credits</span>
                    </div>
                  </div>
                )}
                <div className="error-actions">
                  <button
                    className="buy-credits-btn-primary"
                    onClick={() => { setShowUploadModal(false); setUploadError(null); setShowCreditsModal(true); }}
                  >
                    Buy Credits
                  </button>
                  <button
                    className="cancel-upload-btn"
                    onClick={() => { setShowUploadModal(false); setUploadError(null); }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : estimate ? (
              <div className="estimate-confirmation">
                <div className="book-info">
                  <h3>{estimate.title}</h3>
                  <p className="author">by {estimate.author}</p>
                </div>
                {uploading ? (
                  <div className="upload-progress-inline">
                    <div className="spinner"></div>
                    <p>{uploadProgress}</p>
                  </div>
                ) : (
                  <>
                    <div className="estimate-details">
                      <div className="estimate-row">
                        <span>Chapters:</span>
                        <span>{estimate.chapters}</span>
                      </div>
                      <div className="estimate-row">
                        <span>Characters:</span>
                        <span>{estimate.characters.toLocaleString()}</span>
                      </div>
                      <div className="estimate-row">
                        <span>Estimated tokens:</span>
                        <span>~{estimate.estimatedTokens.toLocaleString()}</span>
                      </div>
                      <div className="estimate-row cost">
                        <span>Translation cost:</span>
                        <span className={estimate.canAfford ? 'affordable' : 'not-affordable'}>
                          {estimate.requiredCredits.toLocaleString()} credits
                        </span>
                      </div>
                      <div className="estimate-row balance">
                        <span>Your balance:</span>
                        <span>{estimate.availableCredits.toLocaleString()} credits</span>
                      </div>
                      {!estimate.canAfford && (
                        <div className="estimate-row needed">
                          <span>Need:</span>
                          <span className="not-affordable">
                            {(estimate.requiredCredits - estimate.availableCredits).toLocaleString()} more credits
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="estimate-actions">
                      {estimate.canAfford ? (
                        <button
                          className="confirm-upload-btn"
                          onClick={handleConfirmUpload}
                        >
                          Confirm & Translate
                        </button>
                      ) : (
                        <button
                          className="buy-credits-btn-primary"
                          onClick={() => { setShowUploadModal(false); setEstimate(null); setShowCreditsModal(true); }}
                        >
                          Buy Credits
                        </button>
                      )}
                      <button
                        className="cancel-upload-btn"
                        onClick={handleCancelEstimate}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : estimating ? (
              <div className="upload-progress">
                <div className="spinner"></div>
                <p>Analyzing book...</p>
              </div>
            ) : uploading ? (
              <div className="upload-progress">
                <div className="spinner"></div>
                <p>{uploadProgress}</p>
              </div>
            ) : (
              <div className="upload-area">
                <div className="current-credits">
                  Your credits: <strong>{credits?.toLocaleString() ?? '...'}</strong>
                </div>
                <input
                  type="file"
                  accept=".epub,.mobi,.azw3"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      handleFileSelect(file);
                    }
                  }}
                  id="epub-file-input"
                  style={{ display: 'none' }}
                />
                <label htmlFor="epub-file-input" className="upload-label">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span>Click to select EPUB file</span>
                  <span className="upload-hint">The book will be automatically translated to Chinese</span>
                  <span className="upload-hint">1 credit = 100 tokens</span>
                </label>
                <button
                  className="cancel-upload-btn"
                  onClick={() => setShowUploadModal(false)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Credits Purchase Modal */}
      {showCreditsModal && (
        <div className="upload-modal-overlay" onClick={() => setShowCreditsModal(false)}>
          <div className="upload-modal-content credits-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Buy Credits</h2>
            <p className="credits-balance">Current balance: <strong>{credits?.toLocaleString() ?? '0'}</strong> credits</p>
            <div className="credit-packages">
              {creditPackages.map((pkg) => (
                <button
                  key={pkg.id}
                  className="credit-package"
                  onClick={() => purchaseCredits(pkg.id)}
                >
                  <span className="package-credits">{pkg.credits.toLocaleString()}</span>
                  <span className="package-label">credits</span>
                  <span className="package-price">${(pkg.price / 100).toFixed(2)}</span>
                </button>
              ))}
            </div>
            <p className="credits-info">Credits are used for book translations. 1 credit = 100 tokens.</p>
            <button
              className="cancel-upload-btn"
              onClick={() => setShowCreditsModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// Helper to generate consistent colors for default spines
function stringToColor(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00ffffff).toString(16).toUpperCase();
  return '#' + '00000'.substring(0, 6 - c.length) + c;
}

export default BookShelf;
