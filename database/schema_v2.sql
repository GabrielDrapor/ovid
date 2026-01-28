-- Ovid Database Schema V2
-- New architecture: Raw HTML + XPath-based translations

-- Books table (simplified)
CREATE TABLE IF NOT EXISTS books_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    original_title TEXT,
    author TEXT,
    language_pair TEXT NOT NULL, -- e.g., 'en-zh'
    styles TEXT, -- CSS styles from EPUB
    book_cover_img_url TEXT, -- Book cover image URL
    book_spine_img_url TEXT, -- Book spine image URL
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Chapters (stores raw HTML from EPUB for 100% fidelity rendering)
CREATE TABLE IF NOT EXISTS chapters_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    chapter_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    original_title TEXT NOT NULL,
    raw_html TEXT, -- Original EPUB HTML content
    order_index INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (book_id) REFERENCES books_v2 (id) ON DELETE CASCADE,
    UNIQUE(book_id, chapter_number)
);

-- XPath-based translations
CREATE TABLE IF NOT EXISTS translations_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL,
    xpath TEXT NOT NULL, -- XPath to locate the text node
    original_text TEXT NOT NULL, -- Plain text content (for translation)
    original_html TEXT, -- Original innerHTML (preserves em, i, strong, etc.)
    translated_text TEXT NOT NULL,
    order_index INTEGER NOT NULL, -- For maintaining reading order
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chapter_id) REFERENCES chapters_v2 (id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_books_v2_uuid ON books_v2(uuid);
CREATE INDEX IF NOT EXISTS idx_chapters_v2_book ON chapters_v2(book_id, order_index);
CREATE INDEX IF NOT EXISTS idx_translations_v2_chapter ON translations_v2(chapter_id, order_index);
