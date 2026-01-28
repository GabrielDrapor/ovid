#!/bin/bash
# Import all Sherlock Holmes books with V2 format

ASSETS_BASE="https://assets.ovid.jrd.pub"

# Clear existing V2 data first
echo "🗑️  Clearing existing V2 data..."
npm run db:local -- "DELETE FROM translations_v2;"
npm run db:local -- "DELETE FROM chapters_v2;"
npm run db:local -- "DELETE FROM books_v2;"

echo ""
echo "📚 Starting batch import of Sherlock Holmes books..."
echo ""

# The Adventures of Sherlock Holmes
echo "1/9: The Adventures of Sherlock Holmes"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/advs.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/adve_01.png" \
  --spine="${ASSETS_BASE}/adve_02.png"

# The Case-Book of Sherlock Holmes
echo "2/9: The Case-Book of Sherlock Holmes"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/case.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/case_01.png" \
  --spine="${ASSETS_BASE}/case_02.png"

# The Hound of the Baskervilles
echo "3/9: The Hound of the Baskervilles"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/houn.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/houn_01.png" \
  --spine="${ASSETS_BASE}/houn_02.png"

# His Last Bow
echo "4/9: His Last Bow"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/lstb.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/last_01.png" \
  --spine="${ASSETS_BASE}/last_02.png"

# The Memoirs of Sherlock Holmes
echo "5/9: The Memoirs of Sherlock Holmes"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/mems.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/memo_01.png" \
  --spine="${ASSETS_BASE}/memo_02.png"

# The Return of Sherlock Holmes
echo "6/9: The Return of Sherlock Holmes"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/retn.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/retu_01.png" \
  --spine="${ASSETS_BASE}/retu_02.png"

# The Sign of the Four
echo "7/9: The Sign of the Four"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/sign.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/sign_01.png" \
  --spine="${ASSETS_BASE}/sign_02.png"

# A Study In Scarlet
echo "8/9: A Study In Scarlet"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/stud.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/stud_01.png" \
  --spine="${ASSETS_BASE}/stud_02.png"

# The Valley Of Fear
echo "9/9: The Valley Of Fear"
npx ts-node scripts/import-book-v2.ts \
  --file="sher/vall.epub" \
  --target="zh" \
  --cover="${ASSETS_BASE}/vall_01.png" \
  --spine="${ASSETS_BASE}/vall_02.png"

echo ""
echo "🎉 All books imported!"
