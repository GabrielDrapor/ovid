#!/bin/bash

# Batch import Sherlock Holmes books from ./sher directory
# Excludes stud.epub and skips already imported books

set -e

SHER_DIR="./sher"
TARGET_LANG="zh"

# Get list of already imported books (original_title from books_v2)
echo "Checking for already imported books..."
IMPORTED_TITLES=$(npm run db:local -- "SELECT original_title FROM books_v2;" 2>&1 | grep -o '"original_title": "[^"]*"' | sed 's/"original_title": "//g' | sed 's/"//g' | sort -u)

echo "Already imported:"
echo "$IMPORTED_TITLES"
echo ""

# Helper function to extract title from EPUB (macOS compatible)
get_epub_title() {
  local epub_file="$1"
  # Use unzip to extract the OPF file and grep for title
  local title=$(unzip -p "$epub_file" "*.opf" 2>/dev/null | grep -o '<dc:title>[^<]*</dc:title>' | sed 's/<dc:title>//;s/<\/dc:title>//' | head -1)
  if [ -z "$title" ]; then
    # Fallback: try content.opf specifically
    title=$(unzip -p "$epub_file" "OEBPS/content.opf" 2>/dev/null | grep -o '<dc:title>[^<]*</dc:title>' | sed 's/<dc:title>//;s/<\/dc:title>//' | head -1)
  fi
  echo "$title"
}

# Find all epub files except stud.epub
for epub in "$SHER_DIR"/*.epub; do
  filename=$(basename "$epub")

  # Skip stud.epub
  if [ "$filename" = "stud.epub" ]; then
    echo "⏭️  Skipping $filename (excluded)"
    continue
  fi

  # Get the book title from EPUB metadata
  book_title=$(get_epub_title "$epub")

  if [ -z "$book_title" ]; then
    echo "⚠️  Could not extract title from $filename, will import anyway"
  else
    # Check if this book is already imported
    if echo "$IMPORTED_TITLES" | grep -qiF "$book_title"; then
      echo "⏭️  Skipping $filename - \"$book_title\" already imported"
      continue
    fi
  fi

  echo "=========================================="
  echo "Importing: $filename ($book_title)"
  echo "=========================================="

  yarn import-book -- --file="$epub" --target="$TARGET_LANG"

  echo ""
  echo "✅ Completed: $filename"
  echo ""
done

echo "=========================================="
echo "All books processed!"
echo "=========================================="
