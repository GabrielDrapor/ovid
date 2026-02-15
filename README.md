# Ovid

A bilingual reader application that helps you read books in two languages. Built with React and deployed as a Cloudflare Worker with D1 database integration.

## Features

- **Book Shelf**: Browse your bilingual book collection with elegant card-based interface
  - **Two-row layout**: Public books and user books displayed separately
  - **Hover-to-preview**: Hover over books to see preview information
  - **Direct reading**: Click book spine to enter directly without additional steps
- **Bilingual Reading**: Switch between original and translated text by clicking paragraphs
  - **XPath-based architecture**: Precise paragraph-level translation tracking
  - **Reading progress**: Automatic tracking of your reading position within chapters
- **Chapter Navigation**: Automatic scroll-based navigation (scroll to load next/previous chapters) + manual chapter menu
- **Responsive Design**: Works on both desktop and mobile devices with optimized typography
- **Multiple Languages**: Support for various language pairs (EN-ZH, EN-ES, EN-FR, EN-DE, EN-JA, EN-KO, EN-RU)
- **User Authentication**: Google OAuth login for personalized book management
- **Web Upload**: Upload EPUB/TXT files directly with automatic translation in background
- **Book Privacy**: Public books visible to all, private books visible only to owners
- **CJK Typography**: Native Chinese font support (Noto Sans CJK SC) for optimal reading experience

## Getting Started

### Prerequisites

- Node.js (v16 or higher) and npm installed
- Cloudflare account (for deployment)
- Wrangler CLI installed globally: `npm install -g wrangler`

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd ovid
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure the project:**
   ```bash
   # Copy example files to create local configs
   cp .env.example .env
   cp wrangler.toml.example wrangler.toml

   # Edit wrangler.toml and replace "your-database-id-here"
   # with your actual Cloudflare D1 database ID

   # Edit .env if you want to use book translation features
   ```

5. **Set up local database:**
   ```bash
   # Create complete database schema (includes all tables, indexes, and migrations)
   npm run db:local -- --file database/schema.sql
   
   # Add sample data (optional) - includes 4 books with chapters and content
   npm run db:local -- --file database/sample_data.sql
   ```

### Development & Running

1. **Start the local development server:**
   ```bash
   npm run preview
   ```
   
2. **Open your browser to [http://localhost:8787](http://localhost:8787)**

#### Using the Reader

**Book Shelf**
- Browse public and your private books in separate sections
- Hover over books to see preview information
- Click book spine to enter directly into reading mode

**Reading Interface**
- **Paragraph Toggle**: Click any paragraph to switch between original and translated text
- **Chapter Navigation**: 
  - Scroll naturally to next/previous chapters
  - Use chapter menu (top-right) to jump to specific chapters
  - Your reading position auto-saves
- **Reading Controls**: Adjust line height, letter spacing, and paragraph spacing for comfort
- **Language Support**: Optimized typography for CJK text (Chinese, Japanese, Korean)

### Available Scripts

**Development & Deployment**
- `npm run preview` - Start local development server with Cloudflare Workers
- `npm run build` - Build React application for production
- `npm run deploy` - Deploy to Cloudflare Workers (requires authentication)
- `npm start` - Start React development server (frontend only)
- `npm test` - Run tests

**Database Operations**
- `npm run db:local -- --file <path.sql>` - Execute SQL file on local database
- `npm run db:remote -- --file <path.sql>` - Execute SQL file on remote database
- `npm run db:local -- "SQL command"` - Execute SQL command on local database
- `npm run db:remote -- "SQL command"` - Execute SQL command on remote database

**Book Management (TypeScript scripts with full type safety)**
- `yarn import-book -- --file="book.epub" --target="zh" --provider="openai"` - Import EPUB/TXT with translation
- `yarn list-books:local` - List all books in local database with timestamps
- `yarn list-books:remote` - List all books in remote database with timestamps
- `yarn remove-book:local -- --uuid="book-uuid"` - Remove books from local database (with confirmation)
- `yarn remove-book:remote -- --uuid="book-uuid"` - Remove books from remote database (with confirmation)
- `yarn sync-remote-book -- --uuid="book-uuid"` - Sync locally imported book to remote D1 (schema-aware)

### Project Structure

```
src/
├── components/
│   ├── BilingualReader.tsx    # Main reading interface
│   ├── BookShelf.tsx          # Book library/shelf component
│   └── *.css                  # Component styles
├── worker/
│   └── index.ts               # Cloudflare Worker backend
└── App.tsx                    # Main React application

database/
├── schema.sql                 # Complete database schema (includes all migrations)
└── sample_data.sql           # Sample book data

wrangler.toml.example         # Cloudflare Workers config template (committed)
wrangler.toml                 # Your local config with real IDs (not committed)
.env.example                  # Environment variables template (committed)
.env                          # Your local environment variables (not committed)
```

### Database Schema

- **books**: Book metadata (title, author, language_pair, uuid)
- **chapters**: Chapter information linked to books
- **content_items**: Individual paragraphs with bilingual text

### Adding New Books

Ovid includes an automated book import system supporting EPUB and TXT files with intelligent translation:

#### Web Upload (Recommended)

1. Log in with Google OAuth
2. Click "Upload Book" button
3. Select EPUB/TXT file and choose target language
4. Translation happens in background while you browse
5. Book appears automatically in your shelf when ready

#### Book Import CLI (Local Development & Batch Import)

```bash
# Import EPUB with Chinese translation
yarn import-book -- --file="book.epub" --target="zh" --provider="openai"

# Import TXT with Spanish translation
yarn import-book -- --file="book.txt" --target="es" --title="Book Title" --author="Author Name"

# Import with custom API endpoint (e.g., local LLM)
yarn import-book -- --file="book.epub" --target="zh" --provider="openai" --api-base="http://localhost:8000/v1"

# List all books in local database
yarn list-books:local

# List all books in remote database
yarn list-books:remote

# Remove a book from local database by UUID (with confirmation prompt)
yarn remove-book:local -- --uuid="book-uuid-here"

# Remove a book from remote database by UUID (with confirmation prompt)
yarn remove-book:remote -- --uuid="book-uuid-here"

# Sync a locally imported book to remote D1 (ensures schema first)
yarn sync-remote-book -- --uuid="book-uuid-here"

# Available target languages: zh (Chinese), es (Spanish), fr (French), de (German), ja (Japanese), ko (Korean), ru (Russian)
# Available providers: openai (recommended), google, deepl
# Typical cost: $3-15 per average book with GPT-4o-mini
```

#### Translation API Setup

**For OpenAI (Recommended):**
Add to your `.env` file:
```bash
OPENAI_API_KEY=sk-your-openai-api-key-here
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

**For OpenAI-Compatible APIs:**
You can use other providers like OpenRouter, Together AI, or local models:
```bash
OPENAI_API_KEY=your-api-key-here
OPENAI_API_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=anthropic/claude-3-haiku
```

**Model Options:**
- `gpt-4o-mini` - Cost-efficient, good quality (recommended)
- `gpt-4o` - Higher quality, more expensive
- `anthropic/claude-3-haiku` - Via OpenRouter
- `meta-llama/llama-3.1-70b-instruct` - Via Together AI

#### Import & Translation Process

The system intelligently processes books:

1. **Parsing**: Extract chapters and paragraphs from EPUB/TXT with XPath tracking
2. **Sequential Translation**: Translate with context awareness for consistency
   - Preserves character voices and narrative style
   - Maintains proper nouns and technical terms
   - Avoids repetitive translations of repeated phrases
3. **Storage**: Import bilingual content with precise XPath mapping for paragraph-level accuracy
4. **Availability**: Book appears in shelf immediately (web upload) or after local confirmation

**Cost Estimates** (OpenAI GPT-4o-mini):
- Novel (80k words): ~$8-12
- Technical book (100k words): ~$12-18
- Short stories (20k words): ~$2-4

**Performance**: 
- Web upload: Non-blocking, translation in background while you read
- CLI import: Sequential processing with progress indicators

#### Manual Database Import

For advanced users, you can also manually import bilingual content:
1. Insert book metadata with a unique UUID
2. Add chapter information and content items
3. Books will automatically appear in the shelf

### Deployment

1. **Authenticate with Cloudflare:**
   ```bash
   wrangler auth login
   ```

2. **Deploy to production:**
   ```bash
   npm run deploy
   ```

### Environment Variables

**For Cloudflare Worker (set via `wrangler secret put` or in `wrangler.toml`):**
- `GOOGLE_OAUTH_CLIENT_ID` - Google OAuth client ID (required for authentication)
- `GOOGLE_OAUTH_CLIENT_SECRET` - Google OAuth client secret (required for authentication)
- `APP_URL` - Application URL, e.g., `https://lib.jrd.pub` (required)
- `OPENAI_API_KEY` - OpenAI API key for web upload translation (required for web upload)
- `OPENAI_API_BASE_URL` - OpenAI API base URL (optional, defaults to https://api.openai.com/v1)
- `OPENAI_MODEL` - Translation model to use (optional, defaults to gpt-4o-mini)

**For local development and CLI scripts (set in `.env`):**
- `CLOUDFLARE_D1_DATABASE_ID` - Your D1 database ID for local development
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID (required for remote operations)
- `CLOUDFLARE_API_TOKEN` - Your Cloudflare API token (required for remote database operations)
- `OPENAI_API_KEY` - OpenAI API key for book translation
- `OPENAI_API_BASE_URL` - OpenAI API base URL (optional)
- `OPENAI_MODEL` - Translation model to use (optional)

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Ensure tests pass
5. Submit a pull request

## License

MIT License - see the [LICENSE](LICENSE) file for details
