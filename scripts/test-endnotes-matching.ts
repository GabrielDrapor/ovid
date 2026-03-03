/**
 * Test: verify that note refs in text can be matched to extracted endnote entries
 */
import * as fs from 'fs';
import JSZip from 'jszip';
import { isEndnotePage, extractEndnotes, findNoteRefsInHTML, EndnoteEntry } from '../src/utils/endnote-extractor';

async function main() {
  const epubPath = '/data/workspace/books/How to Win the Premier Leag_ (z-library.sk, 1lib.sk, z-lib.sk) (Ian Graham).epub';
  
  const buffer = fs.readFileSync(epubPath);
  const zip = new JSZip();
  const zipContent = await zip.loadAsync(buffer);
  const htmlFiles = Object.keys(zipContent.files).filter(f => f.match(/\.(x?html?)$/i));

  // Phase 1: Detect endnote pages
  const endnoteFiles = new Set<string>();
  const endnotePages: { file: string; html: string }[] = [];
  for (const filePath of htmlFiles) {
    const html = await zipContent.files[filePath].async('text');
    if (isEndnotePage(html, filePath)) {
      endnoteFiles.add(filePath);
      endnotePages.push({ file: filePath, html });
    }
  }

  // Phase 2: Extract entries and build backRef index
  // Key: "targetFile#targetAnchor" from the note's backRef → entry
  // But we need a different approach: notes link BACK to text, text links TO notes page
  // The matching needs to be by section + label number
  
  const allEntries: EndnoteEntry[] = [];
  for (const page of endnotePages) {
    allEntries.push(...extractEndnotes(page.html, page.file));
  }

  // Build index by backRef target (the text location the note points back to)
  // backRef format: "index_split_004.html#id_p8" 
  const entriesByBackRef = new Map<string, EndnoteEntry>();
  for (const entry of allEntries) {
    if (entry.backRef) {
      entriesByBackRef.set(entry.backRef, entry);
    }
  }

  // Phase 3: Try to match refs
  let matched = 0;
  let unmatched = 0;

  for (const filePath of htmlFiles) {
    if (endnoteFiles.has(filePath)) continue;
    const html = await zipContent.files[filePath].async('text');
    const refs = findNoteRefsInHTML(html, filePath, endnoteFiles);

    for (const ref of refs) {
      // The ref points to notes page: "index_split_025.html#id_p277"
      // The entry's backRef points back to text: "index_split_011.html#id_p116"  
      // We need to match by: same section + same label
      
      // Approach: find entry whose backRef file matches this chapter, with matching label
      const sourceFileBase = filePath.split('/').pop() || filePath;
      const matchingEntry = allEntries.find(e => {
        if (!e.backRef) return false;
        const entryTargetFile = e.backRef.split('#')[0];
        return entryTargetFile === sourceFileBase && e.label === ref.label;
      });

      if (matchingEntry) {
        matched++;
      } else {
        unmatched++;
        console.log(`❌ Unmatched: [${ref.label}] in ${filePath} → ${ref.targetFile}#${ref.targetAnchorId}`);
      }
    }
  }

  console.log(`\n✅ Matched: ${matched}, ❌ Unmatched: ${unmatched}`);
  
  // Show a few matched examples
  console.log('\n--- Sample Matches ---');
  let shown = 0;
  for (const filePath of htmlFiles) {
    if (endnoteFiles.has(filePath) || shown >= 5) continue;
    const html = await zipContent.files[filePath].async('text');
    const refs = findNoteRefsInHTML(html, filePath, endnoteFiles);
    const sourceFileBase = filePath.split('/').pop() || filePath;
    
    for (const ref of refs.slice(0, 1)) {
      const entry = allEntries.find(e => {
        if (!e.backRef) return false;
        return e.backRef.split('#')[0] === sourceFileBase && e.label === ref.label;
      });
      if (entry) {
        console.log(`[${ref.label}] in ${filePath}:`);
        console.log(`  Note: ${entry.text.substring(0, 100)}...`);
        console.log(`  Section: ${entry.section}`);
        shown++;
      }
    }
  }
}

main().catch(console.error);
