CREATE TABLE IF NOT EXISTS book_shelves (
    shelf_id TEXT NOT NULL,
    book_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (shelf_id, book_id),
    FOREIGN KEY (book_id) REFERENCES books_v2(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_book_shelves_shelf_position
    ON book_shelves(shelf_id, position, book_id);

CREATE INDEX IF NOT EXISTS idx_book_shelves_book
    ON book_shelves(book_id);
