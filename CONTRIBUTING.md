# Contributing to Ovid

## Development Setup

```bash
git clone https://github.com/GabrielDrapor/ovid && cd ovid
yarn install
cp wrangler.toml.example wrangler.toml  # add your D1 database ID
yarn db:init
yarn preview  # http://localhost:8787
```

## Branch Strategy

- `main` — production, deployed automatically via CI
- Feature branches: `feature/description` or `fix/description`
- Branch off `main`, PR back to `main`

## Pull Request Process

1. Create a feature branch off the latest `main` (`git fetch origin && git pull` first)
2. Make your changes
3. Run tests: `yarn test` and `yarn test:visual`
4. Run formatter: `yarn format`
5. Rebase on `origin/main` before pushing — main moves fast
6. Open a PR with a clear description of what and why
7. Wait for CI (deploy preview + tests)

> Note: the `visual-tests` CI job is temporarily disabled (`if: false` in
> `.github/workflows/test.yml`) while the shelf UX churns — still run
> `yarn test:visual` locally for reader/classic-shelf changes.

## Testing

- **Unit tests**: `yarn test` (Vitest)
- **Visual regression**: `yarn test:visual` (Playwright)
- **Manual testing**: `yarn preview` for full-stack local dev

## Code Style

- TypeScript everywhere (frontend, worker, scripts, translator service)
- Prettier for formatting (`yarn format`)
- No `any` types unless unavoidable

## Project Structure

See [CLAUDE.md](CLAUDE.md) for a complete guide to the codebase.

## Deployment

CI handles deployment on push to `main`. Manual deploy: `yarn deploy`.

The translator service (`services/translator/`) deploys separately to Railway.
