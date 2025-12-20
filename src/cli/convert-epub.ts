#!/usr/bin/env node

import { EPUBParser } from '../utils/epubParser';
import { config } from 'dotenv';
import * as fs from 'fs';
import { Translator } from '../utils/translator';

config();

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error(
      'Usage: npm run convert-epub <input.epub> [--output output.json]'
    );
    process.exit(1);
  }

  const inputPath = args[0];
  let outputPath = 'src/bilingual-content.json';

  const outputIndex = args.indexOf('--output');
  if (outputIndex > -1 && args[outputIndex + 1]) {
    outputPath = args[outputIndex + 1];
  }

  // Skip API key check for demo purposes
  // if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
  //   console.error('Error: Please set GEMINI_API_KEY or OPENAI_API_KEY environment variable');
  //   process.exit(1);
  // }

  try {
    console.log(`Converting ${inputPath} to bilingual JSON...`);

    // Parse EPUB
    console.log(`📖 Extracting content from EPUB...`);
    const epubData = await EPUBParser.parseEPUBToStructured(inputPath);

    if (epubData.content.length === 0) {
      throw new Error('No text content found in EPUB');
    }

    console.log(`📚 Found ${epubData.content.length} structured items`);

    // Initialize translator
    const translator = new Translator();

    // Progress callback
    const onProgress = (progress: number) => {
      const barLength = 40;
      const filledLength = Math.round(barLength * (progress / 100));
      const emptyLength = barLength - filledLength;
      const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
      process.stdout.write(`\rTranslating: [${bar}] ${progress}%`);
    };

    // Translate content
    console.log(`🌏 Translating to Chinese...`);
    const originalTexts = epubData.content.map((item) => item.content);
    const translatedTexts = await translator.translateBatch(originalTexts, {
      sourceLanguage: 'English',
      targetLanguage: 'Chinese',
      onProgress,
    });

    process.stdout.write('\n'); // Newline after progress bar

    // Translate title
    const translatedTitle = await translator.translateText(epubData.title, {
      sourceLanguage: 'English',
      targetLanguage: 'Chinese',
    });

    // Create bilingual content
    const bilingualContent = {
      title: translatedTitle,
      originalTitle: epubData.title,
      author: epubData.author,
      styles: epubData.styles,
      content: epubData.content.map((item, index) => ({
        id: item.id,
        original: item.content,
        translated: translatedTexts[index] || `[Translation failed: ${item.content}]`,
        type: item.type,
        className: item.className,
        tagName: item.tagName,
        styles: item.styles,
      })),
    };

    // Save to file
    fs.writeFileSync(outputPath, JSON.stringify(bilingualContent, null, 2));

    console.log(`✅ Successfully converted and saved to: ${outputPath}`);
    console.log(`📖 Content is ready for the bilingual reader!`);
  } catch (error) {
    console.error('❌ Error converting EPUB:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
