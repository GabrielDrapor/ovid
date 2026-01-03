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
  const { user, loading: userLoading, login, logout } = useUser();

  useEffect(() => {
    const fetchBooks = async () => {
      try {
        const response = await fetch('/api/books');
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

    fetchBooks();
  }, []);

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
              {showUserMenu && (
                <div className="user-dropdown">
                  <div className="user-info">
                    <span className="user-name">{user.name}</span>
                    <span className="user-email">{user.email}</span>
                  </div>
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
