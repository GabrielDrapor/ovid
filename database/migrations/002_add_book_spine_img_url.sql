-- Migration: Add book_spine_img_url to books table
-- Date: 2025-12-29
-- Description: Adds book_spine_img_url field to store spine image URL/path for shelf page

-- Add book_spine_img_url column to books table
ALTER TABLE books ADD COLUMN book_spine_img_url TEXT;
