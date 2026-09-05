# Repository Guidelines

## Project Structure & Module Organization

This is a Vite 6 + React 18 + TypeScript global asset dashboard with QDII fund estimates and offline company reports.
It uses a local Flask backend to fetch upstream public data and persist raw responses plus historical series to SQLite.

- `src/main.tsx` mounts the app, and `src/App.tsx` owns dashboard composition and sorting.
- `src/components/` contains reusable UI pieces such as `Header`, `IndexCards`, `FundCard`, and `HoldingsTable`; keep each component's CSS in its adjacent `*.module.css`.
- `src/hooks/useQuotes.ts` reads the worker's compact fund-card snapshot. Do not reintroduce a separate browser estimator.
- `src/http.ts` applies one timeout to response headers and body consumption.
- `src/api.ts` handles upstream data fetching and parsing.
- `src/constants.ts` stores index and fund holding configuration.
- `src/marketHours.ts` contains market session logic in Beijing time.
- `backend/server.py` defines the local Flask data backend for `/api/sina`, `/api/dashboard`, `/api/overview`, `/api/fundnav`, `/api/fundhistory`, `/api/fundholdings`, `/api/fundestimates`, `/api/fundreturns`, `/api/markethistory`, `/api/marketreturns`, `/api/marketstates`, and `/api/datahealth`.
- `backend/estimation.py` contains date-aligned fund return, benchmark residual, and calibration-gate calculations.
- `backend/performance.py` contains distribution/split-aware historical performance calculations; `backend/fund_disclosures.py` parses disclosure metadata without executing upstream JavaScript.
- `backend/worker.py` owns scheduled fetching and snapshot publication. Normal page reads must not fetch missing histories synchronously.
- `data/` is local runtime storage for SQLite and raw upstream responses; it is intentionally git-ignored.
- `demo/` stores screenshots used by the README; update them when visible dashboard output changes.

## Build, Test, and Development Commands

- `npm install` installs dependencies from `package-lock.json`.
- `npm run backend:setup` creates `.venv` and installs Python backend dependencies from `requirements.txt`.
- `npm run backend` starts the Flask data backend at `http://127.0.0.1:8000`.
- `npm run backend:worker` starts the independent data refresh worker.
- `npm run backend:backfill` incrementally fetches configured fund NAV history and index/asset daily history into SQLite.
- `npm run dev` starts Vite, usually at `http://localhost:5173`, and proxies `/api/*` to the Python backend.
- `npm run build` runs `tsc` and produces the production bundle in `dist/`.
- `npm run preview` serves the production build locally for final inspection.

- `npm test` runs Python backend tests, Vitest unit/component tests, and frontend logic regression tests.
- `npm run test:e2e` runs desktop/mobile Playwright checks. Tests use temporary data directories and must never clear the development or production database.
- `npm run data:companies:audit` validates offline company data; `npm run data:companies:sources -- --write` updates exact SEC report links without changing financial figures.

Run `npm test` and `npm run build` before submitting changes. Use Playwright when changing layout, loading behavior, or navigation.

## Coding Style & Naming Conventions

Use TypeScript with `strict` mode and React function components. Keep component filenames in PascalCase, for example `FundCard.tsx`, and hooks in camelCase with a `use` prefix, for example `useQuotes.ts`. Prefer shared interfaces and types from `src/types.ts`.

CSS uses CSS Modules. Name module files after the component they style, and keep global resets or app-wide variables in `src/index.css`.

## Testing Guidelines

Use Python `unittest` for migrations, upstream parsing, snapshot contracts, calendars, and estimation; use Vitest for frontend calculations and components. Add regression cases for missing values, dividends/splits, market-local dates versus Beijing timestamps, and cache refresh failures. Any destructive test setup must assert that its database lives in a temporary test directory. Schema changes require a migration and a migration test; never edit deployed migrations retroactively.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style messages such as `feat: ...`, `fix: ...`, and `docs: ...`. Keep subjects short and imperative.

Commit messages should include a concise subject plus a body that lists the main user-visible or technical changes. For feature/release commits, include 3-6 bullet points covering the important behavior, data-source, UI, documentation, screenshot, and version changes as applicable; avoid vague subjects such as only `release vX.Y.Z`.

Use `taifu <taifu@taifua.com>` as the Git author. Agent-assisted commits must include `Co-Authored-By: Codex (GPT-5.6 Sol) <noreply@openai.com>` in the commit message body.

Pull requests should include a concise summary, verification performed, and screenshots when UI output changes. Link related issues when applicable, and call out data-source or proxy changes because production deployments must mirror `vite-sina-proxy.ts`.

## Security & Configuration Tips

Do not hard-code secrets or private API keys. This project relies on public market data endpoints through the local Python backend; route new upstreams through `backend/server.py` and document production reverse-proxy needs.
