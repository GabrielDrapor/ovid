-- Migration: Persist the per-book "show translation" toggle across devices.
-- 1 = show original (default), 0 = show translation.
ALTER TABLE user_book_progress ADD COLUMN show_original INTEGER NOT NULL DEFAULT 1;
