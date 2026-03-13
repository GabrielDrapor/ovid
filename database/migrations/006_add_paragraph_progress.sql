-- Migration: Add paragraph-level progress tracking for cross-device sync
-- Adds chapter_number and paragraph_xpath to user_book_progress table

ALTER TABLE user_book_progress ADD COLUMN chapter_number INTEGER;
ALTER TABLE user_book_progress ADD COLUMN paragraph_xpath TEXT;
