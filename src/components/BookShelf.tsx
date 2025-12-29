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
  const booksGridRef = React.useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const handleScroll = () => {
      if (!booksGridRef.current) return;

      const container = booksGridRef.current;
      const containerRect = container.getBoundingClientRect();
      const containerCenter = containerRect.left + containerRect.width / 2;

      const bookCards = container.querySelectorAll('.book-card');
      bookCards.forEach((card) => {
        const cardRect = card.getBoundingClientRect();
        const cardCenter = cardRect.left + cardRect.width / 2;
        const distance = Math.abs(containerCenter - cardCenter);
        const maxDistance = containerRect.width / 2;

        // Calculate scale: 1.0 at center, down to 0.7 at edges
        const normalizedDistance = Math.min(distance / maxDistance, 1);
        const scale = 1 - (normalizedDistance * 0.3); // 1.0 to 0.7

        (card as HTMLElement).style.transform = `scale(${scale})`;
      });
    };

    const container = booksGridRef.current;
    if (container) {
      handleScroll(); // Initial scale
      container.addEventListener('scroll', handleScroll);
      window.addEventListener('resize', handleScroll);
    }

    return () => {
      if (container) {
        container.removeEventListener('scroll', handleScroll);
        window.removeEventListener('resize', handleScroll);
      }
    };
  }, [books]);

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

      <div className="books-grid" ref={booksGridRef}>
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
            <div
              className={`book-cover ${!book.book_cover_img_url ? 'default-cover' : ''}`}
              style={
                book.book_cover_img_url
                  ? {
                      backgroundImage: `url(${book.book_cover_img_url})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      backgroundRepeat: 'no-repeat'
                    }
                  : undefined
              }
            >
              {!book.book_cover_img_url && (
                <div className="default-cover-content">
                  <svg className="book-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 19.5C4 18.837 4.26339 18.2011 4.73223 17.7322C5.20107 17.2634 5.83696 17 6.5 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M6.5 2H20V22H6.5C5.83696 22 5.20107 21.7366 4.73223 21.2678C4.26339 20.7989 4 20.163 4 19.5V4.5C4 3.83696 4.26339 3.20107 4.73223 2.73223C5.20107 2.26339 5.83696 2 6.5 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <div className="default-cover-text">
                    <h3 className="default-cover-title">{book.title}</h3>
                    {book.original_title && book.original_title !== book.title && (
                      <h4 className="default-cover-original-title">{book.original_title}</h4>
                    )}
                    <p className="default-cover-author">{book.author}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default BookShelf;
