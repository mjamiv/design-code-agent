# Repository Guidelines

## Project Structure & Module Organization
The app is a static site. Entry points live at `index.html` (Agent Builder), `orchestrator.html` (multi-agent analysis), and `northstar-overview.html`. Core logic is in `js/app.js` and `js/orchestrator.js`, with RLM modules under `js/rlm/` (e.g., `js/rlm/index.js`, `js/rlm/memory-store.js`). Styles are centralized in `css/styles.css`. Static assets live in `images/` and `flowcharts/`; `sw.js` and `manifest.json` support the PWA. `archive/` contains legacy/backups and should not be treated as active code.

## Build, Test, and Development Commands
There is no build step; serve the repo as static files:
```bash
npx http-server -p 3000
```
If `npx` is blocked, you can use:
```bash
python -m http.server 3000
```
Open `http://localhost:3000` to run the UI. If you change service worker behavior, update `CACHE_VERSION` in `sw.js` so clients refresh correctly.

## Coding Style & Naming Conventions
Use 4-space indentation in HTML/CSS/JS and keep semicolons in JavaScript. Prefer `const`/`let`, single quotes for strings, and small, composable helpers in modules. File names are kebab-case for pages/assets (e.g., `northstar-overview.html`) and hyphenated module names under `js/rlm/` (e.g., `query-decomposer.js`).

## Testing Guidelines
No automated test framework is configured. Validate changes manually:
- Load the UI, upload agents, and run a few prompts.
- For RLM changes, check the metrics panel and memory debug output.
- For latency work, verify hybrid mode responds before diagnostics, confirm model tiering in metrics, and review stage timing breakdowns in the metrics panel/CSV.
- For retrieval changes, verify retrieval cache hit rate in the memory debug panel.
- For test runs, confirm the prompt set label appears in the test analytics summary and HTML export.
- For UI changes, verify both `index.html` and `orchestrator.html` layouts.

## Commit & Pull Request Guidelines
Commit messages are short, imperative, and sentence case (e.g., `Fix metrics aggregation`). Keep commits scoped to a single logical change. PRs should include a brief summary, testing notes (commands or manual steps), and screenshots/GIFs for UI changes. Link related issues when applicable.

## Security & Configuration Tips
API keys are stored in browser localStorage; never commit secrets. The app runs fully client-side, so avoid adding server dependencies unless they are explicitly archived or documented.

## Latest Improvements

- Normalized GPT-5 model routing so fallback telemetry and warnings treat versioned outputs (e.g., `gpt-5-mini-2025-08-07`) as the same family; the UI only calls out real tier shifts and records the actual API model once per family.
