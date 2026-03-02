#!/usr/bin/env python3
"""
Fix raw_html for an existing book in D1:
1. Strip internal <a> links (keep inner content)
2. Remove broken <img> tags with relative src (no R2 source available)
"""

import json
import subprocess
import re
import sys

BOOK_ID = 27  # Dorian Gray

def d1_query(sql, is_json=True):
    cmd = [
        "npx", "wrangler", "d1", "execute", "ovid-db", "--remote",
        "--command", sql
    ]
    if is_json:
        cmd.append("--json")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd="/data/workspace/ovid")
    if result.returncode != 0:
        print(f"ERROR: {result.stderr}", file=sys.stderr)
        return None
    if is_json:
        return json.loads(result.stdout)
    return result.stdout

def strip_internal_links(html):
    """Remove <a> tags with internal hrefs, keep inner content."""
    # Match <a ...href="(non-http)..."...>content</a>
    def replace_link(m):
        href = m.group(1)
        content = m.group(2)
        if href.startswith('http://') or href.startswith('https://'):
            return m.group(0)  # Keep external links
        return content  # Unwrap internal links
    
    return re.sub(r'<a\s[^>]*href="([^"]*)"[^>]*>(.*?)</a>', replace_link, html, flags=re.DOTALL)

def remove_broken_images(html):
    """Remove <img> tags with relative src (no R2 available)."""
    def replace_img(m):
        src = m.group(1)
        if src.startswith('http://') or src.startswith('https://'):
            return m.group(0)  # Keep absolute URLs
        return ''  # Remove broken relative images
    
    return re.sub(r'<img[^>]*src="([^"]*)"[^>]*/?\s*>', replace_img, html)

# Get all chapters with raw_html
data = d1_query(f"SELECT id, chapter_number, raw_html FROM chapters_v2 WHERE book_id = {BOOK_ID} AND raw_html IS NOT NULL")
if not data:
    sys.exit(1)

chapters = data[0]['results']
print(f"Found {len(chapters)} chapters with raw_html")

updates = []
for ch in chapters:
    html = ch['raw_html']
    if not html:
        continue
    
    new_html = strip_internal_links(html)
    new_html = remove_broken_images(new_html)
    
    if new_html != html:
        updates.append((ch['id'], ch['chapter_number'], new_html))
        removed_links = html.count('<a ') - new_html.count('<a ')
        removed_imgs = html.count('<img') - new_html.count('<img')
        print(f"  Chapter {ch['chapter_number']} (id={ch['id']}): -{removed_links} links, -{removed_imgs} images")

print(f"\n{len(updates)} chapters need updating")

if not updates:
    print("Nothing to fix!")
    sys.exit(0)

# Apply updates
for ch_id, ch_num, new_html in updates:
    # Escape single quotes for SQL
    escaped = new_html.replace("'", "''")
    sql = f"UPDATE chapters_v2 SET raw_html = '{escaped}' WHERE id = {ch_id}"
    print(f"  Updating chapter {ch_num} (id={ch_id})... ", end="", flush=True)
    result = d1_query(sql, is_json=False)
    if result is not None:
        print("OK")
    else:
        print("FAILED")

print("\nDone!")
