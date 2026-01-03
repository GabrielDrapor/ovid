-- Ovid Database Schema
-- Complete schema including all migrations consolidated into one file

-- Books table to store book metadata
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    original_title TEXT,
    author TEXT,
    language_pair TEXT NOT NULL, -- e.g., 'en-zh', 'en-es'
    styles TEXT, -- CSS styles from EPUB
    uuid TEXT, -- Unique identifier for each book
    book_cover_img_url TEXT, -- URL or path to book cover image
    book_spine_img_url TEXT, -- URL or path to book spine image
    user_id INTEGER, -- NULL = admin/public book, non-NULL = private user book
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Chapters table to track chapter information
CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    chapter_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    original_title TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE,
    UNIQUE(book_id, chapter_number)
);

-- Content items table to store bilingual content
CREATE TABLE IF NOT EXISTS content_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    chapter_id INTEGER, -- References chapters(id), added by migration
    item_id TEXT NOT NULL, -- original content ID from JSON
    original_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    type TEXT DEFAULT 'paragraph', -- 'title', 'chapter', 'paragraph'
    class_name TEXT,
    tag_name TEXT,
    styles TEXT,
    order_index INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE,
    FOREIGN KEY (chapter_id) REFERENCES chapters (id),
    UNIQUE(book_id, item_id)
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_content_items_book_id ON content_items(book_id);
CREATE INDEX IF NOT EXISTS idx_content_items_order ON content_items(book_id, order_index);
CREATE INDEX IF NOT EXISTS idx_content_items_type ON content_items(book_id, type);
CREATE INDEX IF NOT EXISTS idx_content_items_chapter ON content_items(chapter_id);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, order_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_uuid ON books(uuid);
CREATE INDEX IF NOT EXISTS idx_books_user_id ON books(user_id);

-- Users table for Google OAuth authentication
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    picture TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table for user sessions
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Reading progress table (cloud sync)
CREATE TABLE IF NOT EXISTS reading_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    book_uuid TEXT NOT NULL,
    chapter_number INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    UNIQUE(user_id, book_uuid)
);

-- User-related indexes
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_reading_progress_user ON reading_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_reading_progress_book ON reading_progress(book_uuid);