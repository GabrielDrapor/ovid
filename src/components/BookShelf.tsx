import React, { useState, useEffect } from 'react';
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
  created_at: string;
  updated_at: string;
}

interface BookShelfProps {
  onSelectBook: (bookUuid: string) => void;
}

const BookShelf: React.FC<BookShelfProps> = ({ onSelectBook }) => {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
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
      const booksData = (await response.json()) as Book[];
      setBooks(booksData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch books');
      console.error('Error fetching books:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBooks();
  }, []);

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
    setUploadProgress('Translating book...');
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

      const result = await response.json() as { success: boolean; bookUuid: string; creditsUsed?: number };
      setUploadProgress(`Success! Used ${result.creditsUsed?.toLocaleString() || 0} credits.`);

      await fetchBooks();
      await refreshCredits();

      setTimeout(() => {
        setShowUploadModal(false);
        setUploadProgress('');
        setUploading(false);
        setUploadError(null);
        setEstimate(null);
      }, 2000);
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
      <div
        className="bookshelf-wall"
        style={{ backgroundImage: 'url(/bookcase_bg.jpeg)' }}
      >
        {!loading && books.length === 0 ? (
          <div className="bookshelf-empty">
            {/* Empty State, effectively just the background with a message if needed */}
          </div>
        ) : (
          <div className="books-grid" style={{ opacity: loading ? 0 : 1, transition: 'opacity 0.5s ease-in-out' }}>
            {books.map((book) => (
              <div
                key={book.uuid}
                className={`book-spine-container ${selectedBook?.uuid === book.uuid ? 'selected' : ''}`}
                onClick={() => setSelectedBook(book)}
              >
                {book.book_spine_img_url ? (
                  <img
                    src={book.book_spine_img_url}
                    alt={`${book.title} spine`}
                    className="book-spine-img"
                  />
                ) : (
                  <div className="book-spine-default" style={{ backgroundColor: stringToColor(book.title) }}>
                    <span className="spine-title">{book.title}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`book-preview-sidebar ${selectedBook ? 'open' : ''}`}>
        {selectedBook ? (
          <div className="preview-content">
            <button className="close-preview" onClick={() => setSelectedBook(null)}>×</button>

            <div className="preview-cover">
              {selectedBook.book_cover_img_url ? (
                <img src={selectedBook.book_cover_img_url} alt={selectedBook.title} />
              ) : (
                <div className="default-preview-cover">
                  <h3>{selectedBook.title}</h3>
                  <p>{selectedBook.author}</p>
                </div>
              )}
            </div>

            <div className="preview-info">
              <h2>{selectedBook.title}</h2>
              {selectedBook.original_title && <h3>{selectedBook.original_title}</h3>}
              <p className="author">By {selectedBook.author}</p>

              <button
                className="enter-book-btn"
                onClick={() => onSelectBook(selectedBook.uuid)}
              >
                Start Reading
              </button>
            </div>
          </div>
        ) : (
          <div className="preview-placeholder">
            <p>Select a book to view details</p>
          </div>
        )}

        {/* User auth button at bottom of sidebar */}
        <div className="user-auth-container">
          {userLoading ? null : user ? (
            <div className="user-menu-wrapper">
              <button
                className="user-avatar-btn"
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
                className="upload-book-btn-icon"
                onClick={() => setShowUploadModal(true)}
                title="Upload Book"
              >
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </button>
              {showUserMenu && (
                <div className="user-dropdown">
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
            </div>
          ) : (
            <button className="google-login-btn" onClick={login}>
              <svg className="google-icon" viewBox="0 0 24 24" width="18" height="18">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              <span>Sign in with Google</span>
            </button>
          )}
        </div>
      </div>

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="upload-modal-overlay" onClick={() => !uploading && !estimating && !uploadError && !estimate && setShowUploadModal(false)}>
          <div className="upload-modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>Upload EPUB Book</h2>
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
                  accept=".epub"
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
