# PolyInk

A bilingual reader application that helps you read books in two languages. Built with React and deployed as a Cloudflare Worker with D1 database integration.

## Features

- **Book Shelf**: Browse your bilingual book collection with an elegant card-based interface
- **Bilingual Reading**: Switch between original and translated text by clicking paragraphs
- **Chapter Navigation**: Manual chapter navigation with curved arrow buttons
- **Responsive Design**: Works on both desktop and mobile devices
- **Multiple Languages**: Support for various language pairs (EN-ZH, EN-ES, EN-FR, etc.)

## Getting Started

### Prerequisites

- Node.js (v16 or higher) and npm installed
- Cloudflare account (for deployment)
- Wrangler CLI installed globally: `npm install -g wrangler`

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd polyink
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment configuration:**
   ```bash
   # Copy the example environment file
   cp .env.example .env
   
   # Edit .env and add your configuration:
   # CLOUDFLARE_D1_DATABASE_ID=your-actual-database-id-here
   # OPENAI_API_KEY=sk-your-openai-api-key-here (for book translation)
   # OPENAI_API_BASE_URL=https://api.openai.com/v1 (or OpenAI-compatible API)
   # OPENAI_MODEL=gpt-4o-mini (translation model to use)
   ```

4. **Create local wrangler config:**
   ```bash
   # Copy wrangler.toml to wrangler.toml.local
   cp wrangler.toml wrangler.toml.local
   
   # Edit wrangler.toml.local and replace "your-database-id-here" 
   # with your actual Cloudflare D1 database ID
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
- `npm run import-book` - Import EPUB/TXT books with translation
- `npm run remove-book` - Remove books by UUID (with confirmation)
- `npm run sync-remote-book` - Sync a locally imported book to the remote D1 (ensures schema first)
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

wrangler.toml                 # Cloudflare Workers configuration (safe for commits)
wrangler.toml.local           # Local config with secrets (not committed)
```

### Database Schema

- **books**: Book metadata (title, author, language_pair, uuid)
- **chapters**: Chapter information linked to books
- **content_items**: Individual paragraphs with bilingual text

### Adding New Books

PolyInk includes an automated book import system that supports EPUB and TXT files with automatic translation:

#### Book Import CLI

```bash
# Import EPUB with Chinese translation
npm run import-book -- --file="book.epub" --target="zh" --provider="openai"

# Import TXT with Spanish translation  
npm run import-book -- --file="book.txt" --target="es" --title="Book Title" --author="Author Name"

# Remove a book by UUID (with confirmation prompt)
npm run remove-book -- --uuid="book-uuid-here"

# Sync a locally imported book to remote D1 (ensures schema first)
npm run sync-remote-book -- --uuid="book-uuid-here"

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

- `CLOUDFLARE_D1_DATABASE_ID` - Your D1 database ID for local development
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID (required for remote sync)
- `OPENAI_API_KEY` - OpenAI API key for book translation (optional)
- `OPENAI_API_BASE_URL` - OpenAI API base URL (optional, defaults to https://api.openai.com/v1)
- `OPENAI_MODEL` - Translation model to use (optional, defaults to gpt-4o-mini)

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Ensure tests pass
5. Submit a pull request

## License

ISC License
