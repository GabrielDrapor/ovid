const { EPub } = require('epub2');
const { DOMParser } = require('@xmldom/xmldom');

const epub = new EPub('./animal_farm.epub');

epub.on('end', () => {
  const mainItem = epub.spine.contents.find((i: any) => i.id === 'html');
  if (mainItem) {
    epub.getChapter(mainItem.id, (err: any, html: string) => {
      if (err) {
        console.log('Error:', err);
        return;
      }

      console.log('HTML first 500 chars:', html?.substring(0, 500));
      console.log('---');

      // Try parsing with DOMParser
      const parser = new DOMParser();
      // Wrap HTML if no body tag
      const wrappedHtml = html.includes('<body') ? html : `<html><body>${html}</body></html>`;
      const doc = parser.parseFromString(wrappedHtml, 'text/html');

      const body = doc.getElementsByTagName('body')[0];
      console.log('Body found:', !!body);

      // Try getting documentElement
      console.log('Document element:', doc.documentElement?.nodeName);

      // Try getting all p tags from doc
      const pTags = doc.getElementsByTagName('p');
      console.log('P tags from doc:', pTags.length);

      // Check childNodes of doc
      console.log('Doc childNodes:', doc.childNodes?.length);
    });
  }
});

epub.parse();
