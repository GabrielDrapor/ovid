CREATE TABLE IF NOT EXISTS shelf_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shelf_id TEXT NOT NULL,
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    label TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shelf_id, row, col),
    UNIQUE(shelf_id, sort_order)
);

CREATE TABLE IF NOT EXISTS book_shelf_slots (
    book_id INTEGER PRIMARY KEY,
    slot_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (book_id) REFERENCES books_v2(id) ON DELETE CASCADE,
    FOREIGN KEY (slot_id) REFERENCES shelf_slots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_book_shelf_slots_slot_position
    ON book_shelf_slots(slot_id, position, book_id);
