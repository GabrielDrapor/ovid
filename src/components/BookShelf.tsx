import React, { useState, useEffect } from 'react';
import './BookShelf.css';

interface Book {
  id: number;
  uuid: string;
  title: string;
  original_title: string;
  author: string;
  language_pair: string;
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

  if (loading) {
    return (
      <div className="bookshelf">
        <div className="bookshelf-loading">
          <div className="loading-spinner"></div>
          <p>Loading your library...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bookshelf">
        <div className="bookshelf-error">
          <h2>Unable to load books</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (books.length === 0) {
    return (
      <div className="bookshelf">
        <div className="bookshelf-empty">
          <h2>Your Library is Empty</h2>
          <p>
            Add some books to get started with your bilingual reading journey.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bookshelf">
      <header className="bookshelf-header">
        <h1>Ovid Library</h1>
        <p>Your bilingual reading collection</p>
      </header>

      <div className="books-grid">
        {books.map((book) => (
          <div
            key={book.uuid}
            className="book-card"
            onClick={() => onSelectBook(book.uuid)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onSelectBook(book.uuid);
              }
            }}
          >
            <div className="book-cover">
              <div className="book-spine"></div>
              <div className="book-front">
                <div className="book-title-section">
                  <h3 className="book-title">{book.title}</h3>
                  <h4 className="book-original-title">{book.original_title}</h4>
                </div>
                <div className="book-meta">
                  <p className="book-author">{book.author}</p>
                  <span className="language-pair">
                    {book.language_pair.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>
            <div className="book-info">
              <h3>{book.title}</h3>
              <p>{book.original_title}</p>
              <span className="author">by {book.author}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default BookShelf;
