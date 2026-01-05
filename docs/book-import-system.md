# Book Import System Design - Ovid

## Overview
A comprehensive system to import books (EPUB, TXT, etc.) and automatically generate bilingual content.

## Import Pipeline

### Phase 1: Book Processing
1. **File Upload & Parsing**
   - Accept EPUB, PDF, TXT files
   - Extract metadata (title, author, language)
   - Parse chapter structure
   - Extract paragraph-level content

### Phase 2: Content Preparation
2. **Text Processing**
   - Clean HTML/markup
   - Identify chapter boundaries
   - Split into translatable segments
   - Preserve formatting metadata

### Phase 3: Translation
3. **Automatic Translation**
   - Integration with translation APIs:
     - Google Translate API
     - DeepL API
     - OpenAI GPT API
   - Batch processing for efficiency
   - Quality scoring and review

### Phase 4: Database Import
4. **Database Integration**
   - Generate UUID for book
   - Insert book metadata
   - Create chapter records
   - Import bilingual content items
   - Preserve original formatting

## Implementation Options

### Option A: CLI Tool (Implemented ✅)
```bash
yarn import-book -- --file="book.epub" --target="zh" --provider="openai"
```

### Option B: Web Interface (Implemented ✅)
The web upload feature is available for admin users:
- **Access**: Only visible to admin user (diary.sjr@gmail.com)
- **Authentication**: Requires Google OAuth login
- **Endpoint**: `POST /api/books/upload`
- **Features**:
  - EPUB file upload via drag-and-drop or file picker
  - Automatic translation to Chinese (default)
  - Book is associated with the uploading user (private by default)
  - Uses BookProcessor for EPUB parsing and translation

```typescript
// Web upload implementation (src/worker/index.ts)
POST /api/books/upload
Content-Type: multipart/form-data
- file: EPUB file
- targetLanguage: "zh" (default)
- sourceLanguage: "en" (default)

// Response
{
  "success": true,
  "bookUuid": "generated-uuid",
  "message": "Book uploaded and processed successfully"
}
```

### Option C: API Endpoint (Legacy Design)
```typescript
POST /api/books/import
{
  "file": "base64_content",
  "metadata": {
    "title": "Book Title",
    "author": "Author Name",
    "source_lang": "en",
    "target_lang": "zh"
  },
  "translation_provider": "openai"
}
```

## Translation Providers

### 1. OpenAI GPT-4
**Pros:** 
- High quality literary translations
- Context-aware
- Maintains style and tone

**Implementation:**
```typescript
async function translateWithOpenAI(text: string, sourceLang: string, targetLang: string) {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{
      role: "system",
      content: `Translate the following ${sourceLang} text to ${targetLang}. Maintain literary style and cultural context.`
    }, {
      role: "user", 
      content: text
    }],
    temperature: 0.3
  });
  return response.choices[0].message.content;
}
```

### 2. Google Translate API
**Pros:**
- Fast and reliable
- Supports many languages
- Cost-effective

**Implementation:**
```typescript
async function translateWithGoogle(text: string, sourceLang: string, targetLang: string) {
  const [translation] = await translate.translate(text, {
    from: sourceLang,
    to: targetLang
  });
  return translation;
}
```

### 3. DeepL API
**Pros:**
- High quality translations
- Good for European languages
- Preserves formatting

## File Processing

### EPUB Processing
```typescript
import * as epub from 'epub2';

async function processEPUB(filePath: string) {
  return new Promise((resolve, reject) => {
    const book = epub.createBook(filePath, (err) => {
      if (err) return reject(err);
      
      const metadata = {
        title: book.title,
        author: book.creator,
        language: book.language
      };
      
      const chapters = book.spine.contents.map(chapter => ({
        id: chapter.id,
        href: chapter.href,
        title: chapter.title
      }));
      
      resolve({ metadata, chapters });
    });
  });
}
```

## Database Schema Integration

### Books Table
```sql
INSERT INTO books (title, original_title, author, language_pair, styles, uuid) 
VALUES (?, ?, ?, ?, ?, ?);
```

### Chapters Table
```sql
INSERT INTO chapters (book_id, chapter_number, title, original_title, order_index)
VALUES (?, ?, ?, ?, ?);
```

### Content Items Table
```sql
INSERT INTO content_items (book_id, chapter_id, item_id, original_text, translated_text, type, tag_name, order_index)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);
```

## Error Handling & Quality Control

### Translation Quality Checks
- Length ratio validation (translated vs original)
- Language detection verification
- Special character preservation
- Formatting consistency

### Retry Logic
- Failed translation retry with exponential backoff
- Alternative provider fallback
- Manual review queue for problematic segments

## Cost Estimation

### Per Book (300 pages, ~150k words)
- **OpenAI GPT-4**: ~$15-30
- **Google Translate**: ~$3-6  
- **DeepL**: ~$6-12

### Optimization Strategies
- Batch processing for API efficiency
- Caching for repeated phrases
- Progressive enhancement (translate on-demand)
- User contribution system

## Implementation Priority

### Phase 1: MVP ✅
1. ✅ Basic EPUB parsing
2. ✅ OpenAI integration
3. ✅ Database import
4. ✅ CLI interface

### Phase 2: Enhancement ✅
5. ✅ Multiple translation providers (OpenAI-compatible APIs)
6. ✅ Web interface (admin-only EPUB upload)
7. ✅ Quality control
8. ✅ Error handling

### Phase 3: Advanced ✅
9. ✅ Batch processing (concurrent translation)
10. ✅ Progress tracking
11. ⬚ Preview system (not yet implemented)
12. ✅ Cost optimization (configurable models)

### Phase 4: User Management ✅
13. ✅ Google OAuth authentication
14. ✅ User-specific book ownership
15. ✅ Public/private book visibility

## Technical Requirements

### Dependencies
```json
{
  "epub2": "^3.0.2",
  "openai": "^4.0.0",
  "@google-cloud/translate": "^8.0.0",
  "deepl-node": "^1.0.0",
  "uuid": "^9.0.0",
  "pdf-parse": "^1.1.1"
}
```

### Environment Variables
```bash
OPENAI_API_KEY=sk-...
GOOGLE_TRANSLATE_API_KEY=...
DEEPL_API_KEY=...
```

### API Rate Limits
- OpenAI: 3,500 requests/minute
- Google Translate: 300,000 characters/minute
- DeepL: 500,000 characters/month (free tier)

This system would transform Ovid from a reader into a complete bilingual book creation platform!