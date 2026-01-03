-- Migration: Add user_id to books table
-- NULL user_id means admin/public books visible to all users
-- Non-NULL user_id means private books visible only to that user

ALTER TABLE books ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_books_user_id ON books(user_id);
