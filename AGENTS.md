# Repository Guidelines

## Project Structure & Module Organization
- `index.html` hosts the Agent Builder UI; `orchestrator.html` hosts the multi-agent Orchestrator.
- Core logic lives in `js/app.js` (Builder) and `js/orchestrator.js` (Orchestrator).
- The RLM pipeline is in `js/rlm/` (context store, query decomposer, aggregator, REPL).
- Styling is centralized in `css/styles.css`; PWA config is `manifest.json` and `sw.js`.
- Assets are under `images/`; `archive/` contains legacy references only.

## Build, Test, and Development Commands
- Local dev server (preferred):
  - `npx http-server -p 3000`
  - `python -m http.server 3000`
- There is no separate build step; open the local URL to test.

## Coding Style & Naming Conventions
- Use 4-space indentation and match existing formatting in HTML/CSS/JS.
- JavaScript uses ES modules; keep functions in `camelCase` and classes in `PascalCase`.
- Use descriptive IDs/classes in HTML (e.g., `result-requirements`, `kpi-crossrefs`).
- There is no enforced formatter/linter; keep diffs small and consistent.

## Testing Guidelines
- No automated test suite is configured.
- Manual checks to run after changes:
  - Builder: analyze sample code text/PDF/image, verify results + exports.
  - Orchestrator: import 2+ agents, run cross-code queries, validate insights.
  - REPL: run helpers like `get_all_requirements()` in the metrics panel.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and capitalized (e.g., `Fix ...`, `Update ...`).
- PRs should include a concise description, linked issues, and UI screenshots when applicable.
- Note manual testing performed (commands and scenarios).

## Security & Configuration Tips
- API keys are stored in `localStorage` and never checked into the repo.
- Avoid adding server-side dependencies; the app is client-only by design.
