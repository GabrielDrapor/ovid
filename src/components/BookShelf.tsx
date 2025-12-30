import React, { useState, useEffect } from 'react';
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
