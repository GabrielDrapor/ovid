# Contributing to Ovid

## Development Setup

```bash
git clone https://github.com/GabrielDrapor/ovid && cd ovid
npm install
cp wrangler.toml.example wrangler.toml  # add your D1 database ID
npm run db:init
npm run preview  # http://localhost:8787
```

## Branch Strategy

- `main` — production, deployed automatically via CI
- Feature branches: `feature/description` or `fix/description`
- Branch off `main`, PR back to `main`

## Pull Request Process

1. Create a feature branch
2. Make your changes
3. Run tests: `npm test` and `npm run test:visual`
4. Run formatter: `npm run format`
5. Open a PR with a clear description of what and why
6. Wait for CI (deploy preview + tests)

## Testing

- **Unit tests**: `npm test` (Vitest)
- **Visual regression**: `npm run test:visual` (Playwright)
- **Manual testing**: `npm run preview` for full-stack local dev

## Code Style

- TypeScript everywhere (frontend, worker, scripts, translator service)
- Prettier for formatting (`npm run format`)
- No `any` types unless unavoidable

## Project Structure

See [CLAUDE.md](CLAUDE.md) for a complete guide to the codebase.

## Deployment

CI handles deployment on push to `main`. Manual deploy: `npm run deploy`.

The translator service (`services/translator/`) deploys separately to Railway.
