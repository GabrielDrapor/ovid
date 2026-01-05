# Ovid

A bilingual reader application that helps you read books in two languages. Built with React and deployed as a Cloudflare Worker with D1 database integration.

## Features

- **Book Shelf**: Browse your bilingual book collection with an elegant card-based interface
- **Bilingual Reading**: Switch between original and translated text by clicking paragraphs
- **Chapter Navigation**: Manual chapter navigation with curved arrow buttons
- **Responsive Design**: Works on both desktop and mobile devices
- **Multiple Languages**: Support for various language pairs (EN-ZH, EN-ES, EN-FR, etc.)
- **User Authentication**: Google OAuth login for personalized book management
- **Web Upload**: Upload EPUB files directly through the web interface (admin only)
- **Book Privacy**: Public books visible to all, private books visible only to owners

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

### Development

1. **Start the local development server:**
   ```bash
   npm run preview
   ```
   
2. **Open your browser to [http://localhost:8787](http://localhost:8787)**

The main page will show your book shelf with available books. Click any book to start reading.

### Available Scripts

- `npm run preview` - Start local development server with Cloudflare Workers
- `npm run build` - Build React application for production
- `npm run deploy` - Deploy to Cloudflare Workers (requires authentication)
- `npm run db:local` - Execute SQL commands on local database
- `npm run db:remote` - Execute SQL commands on remote database
- `yarn import-book` - Import EPUB/TXT books with translation
- `yarn list-books:local` - List all books in local database with timestamps
- `yarn list-books:remote` - List all books in remote database with timestamps
- `yarn remove-book:local` - Remove books from local database by UUID (with confirmation)
- `yarn remove-book:remote` - Remove books from remote database by UUID (with confirmation)
- `yarn sync-remote-book` - Sync a locally imported book to the remote D1 (ensures schema first)
- `npm start` - Start React development server (frontend only)
- `npm test` - Run tests

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

Ovid includes an automated book import system that supports EPUB and TXT files with automatic translation:

#### Book Import CLI

```bash
# Import EPUB with Chinese translation
yarn import-book -- --file="book.epub" --target="zh" --provider="openai"

# Import TXT with Spanish translation
yarn import-book -- --file="book.txt" --target="es" --title="Book Title" --author="Author Name"

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
# Available providers: openai, google, deepl
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

#### Import Process

The import system will:
1. **Parse** the book file (EPUB/TXT) and extract chapters
2. **Translate** all content using your chosen API provider
3. **Import** the bilingual content into your database with a unique UUID
4. **Display** the book automatically in your shelf

**Cost Estimate:** ~$3-15 per average book using OpenAI GPT-4o-mini

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
- `GOOGLE_CLIENT_ID` - Google OAuth client ID (required for authentication)
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret (required for authentication)
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
