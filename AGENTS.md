# Repository Guidelines

## Project Structure & Module Organization

This is a Vite 5 + React 18 + TypeScript app for estimating QDII fund net values from live market data.
It uses a local Flask backend to fetch upstream public data and persist raw responses plus historical series to SQLite.

- `src/main.tsx` mounts the app, and `src/App.tsx` owns dashboard composition and sorting.
- `src/components/` contains reusable UI pieces such as `Header`, `IndexCards`, `FundCard`, and `HoldingsTable`; keep each component's CSS in its adjacent `*.module.css`.
- `src/hooks/useQuotes.ts` coordinates quote, NAV, and estimate loading.
- `src/api.ts` handles upstream data fetching and parsing.
- `src/constants.ts` stores index and fund holding configuration.
- `src/marketHours.ts` contains market session logic in Beijing time.
- `backend/server.py` defines the local Flask data backend for `/api/sina`, `/api/fundnav`, `/api/fundhistory`, `/api/markethistory`, and `/api/marketintraday`.
- `data/` is local runtime storage for SQLite and raw upstream responses; it is intentionally git-ignored.
- `demo/` stores screenshots used by the README; update them when visible dashboard output changes.

## Build, Test, and Development Commands

- `npm install` installs dependencies from `package-lock.json`.
- `npm run backend:setup` creates `.venv` and installs Python backend dependencies from `requirements.txt`.
- `npm run backend` starts the Flask data backend at `http://127.0.0.1:8000`.
- `npm run backend:backfill` incrementally fetches configured fund NAV history and index/asset daily history into SQLite.
- `npm run dev` starts Vite, usually at `http://localhost:5173`, and proxies `/api/*` to the Python backend.
- `npm run build` runs `tsc` and produces the production bundle in `dist/`.
- `npm run preview` serves the production build locally for final inspection.

There is no dedicated test or lint script. Use `npm run build` as the required verification before submitting changes.

## Coding Style & Naming Conventions

Use TypeScript with `strict` mode and React function components. Keep component filenames in PascalCase, for example `FundCard.tsx`, and hooks in camelCase with a `use` prefix, for example `useQuotes.ts`. Prefer shared interfaces and types from `src/types.ts`.

CSS uses CSS Modules. Name module files after the component they style, and keep global resets or app-wide variables in `src/index.css`.

## Testing Guidelines

No test framework is configured yet. For logic-heavy changes, especially in `src/api.ts`, `src/marketHours.ts`, or estimation calculations in `src/hooks/useQuotes.ts`, add focused tests if a test setup is introduced. Until then, verify with `npm run build` and manually check expanded holdings and market status labels.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style messages such as `feat: ...`, `fix: ...`, and `docs: ...`. Keep subjects short and imperative.

Commit messages should include a concise subject plus a body that lists the main user-visible or technical changes. For feature/release commits, include 3-6 bullet points covering the important behavior, data-source, UI, documentation, screenshot, and version changes as applicable; avoid vague subjects such as only `release vX.Y.Z`.

Use `taifu <taifu@taifua.com>` as the Git author. Agent-assisted commits must include `Co-Authored-By: Codex (GPT-5.5) <noreply@openai.com>` in the commit message body.

Pull requests should include a concise summary, verification performed, and screenshots when UI output changes. Link related issues when applicable, and call out data-source or proxy changes because production deployments must mirror `vite-sina-proxy.ts`.

## Security & Configuration Tips

Do not hard-code secrets or private API keys. This project relies on public market data endpoints through the local Python backend; route new upstreams through `backend/server.py` and document production reverse-proxy needs.
