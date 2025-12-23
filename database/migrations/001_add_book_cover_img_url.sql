-- Migration: Add book_cover_img_url to books table
-- Date: 2025-12-23
-- Description: Adds book_cover_img_url field to store cover image URL/path for shelf page

-- Add book_cover_img_url column to books table
ALTER TABLE books ADD COLUMN book_cover_img_url TEXT;
