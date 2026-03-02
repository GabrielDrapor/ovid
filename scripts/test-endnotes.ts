/**
 * Test script: extract endnotes from the "How to Win the Premier League" EPUB
 */
import * as fs from 'fs';
import JSZip from 'jszip';
import { isEndnotePage, extractEndnotes, findNoteRefsInHTML } from '../src/utils/endnote-extractor';

async function main() {
  const epubPath = '/data/workspace/books/How to Win the Premier Leag_ (z-library.sk, 1lib.sk, z-lib.sk) (Ian Graham).epub';
  
  const buffer = fs.readFileSync(epubPath);
  const zip = new JSZip();
  const zipContent = await zip.loadAsync(buffer);

  // Get all HTML files
  const htmlFiles = Object.keys(zipContent.files).filter(f => f.match(/\.(x?html?)$/i));
  
  console.log(`📦 Found ${htmlFiles.length} HTML files\n`);

  // Phase 1: Detect endnote pages
  const endnoteFiles = new Set<string>();
  const endnotePages: { file: string; html: string }[] = [];

  for (const filePath of htmlFiles) {
    const html = await zipContent.files[filePath].async('text');
    if (isEndnotePage(html, filePath)) {
      endnoteFiles.add(filePath);
      endnotePages.push({ file: filePath, html });
      console.log(`📝 Endnote page detected: ${filePath}`);
    }
  }

  if (endnotePages.length === 0) {
    console.log('❌ No endnote pages detected');
    return;
  }

  // Phase 2: Extract endnote entries
  console.log('\n--- Endnote Entries ---\n');
  
  let totalEntries = 0;
  for (const page of endnotePages) {
    const entries = extractEndnotes(page.html, page.file);
    totalEntries += entries.length;
    console.log(`📄 ${page.file}: ${entries.length} entries`);
    
    // Show first 5 entries as sample
    for (const entry of entries.slice(0, 5)) {
      console.log(`  [${entry.label}] ${entry.anchorId ? '#' + entry.anchorId : '(no anchor)'} ${entry.section ? '(' + entry.section + ')' : ''}`);
      console.log(`    ${entry.text.substring(0, 120)}${entry.text.length > 120 ? '...' : ''}`);
      console.log(`    ← back: ${entry.backRef}`);
    }
    if (entries.length > 5) {
      console.log(`  ... and ${entries.length - 5} more`);
    }
  }

  // Phase 3: Find note references in text chapters
  console.log('\n--- Note References in Text ---\n');
  
  let totalRefs = 0;
  for (const filePath of htmlFiles) {
    if (endnoteFiles.has(filePath)) continue;
    
    const html = await zipContent.files[filePath].async('text');
    const refs = findNoteRefsInHTML(html, filePath, endnoteFiles);
    
    if (refs.length > 0) {
      totalRefs += refs.length;
      console.log(`📖 ${filePath}: ${refs.length} refs`);
      for (const ref of refs.slice(0, 3)) {
        console.log(`  [${ref.label}] → ${ref.targetFile}#${ref.targetAnchorId}`);
      }
      if (refs.length > 3) console.log(`  ... and ${refs.length - 3} more`);
    }
  }

  console.log(`\n✅ Summary: ${endnotePages.length} endnote pages, ${totalEntries} entries, ${totalRefs} refs in text`);
}

main().catch(console.error);
