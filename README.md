# Trail Map Game (Pixi.js + TypeScript)

A browser-based Candy Crush style trail / level progression map implemented with **Pixi.js** for rendering and **TypeScript** for structure. Click the current (or completed) level to open a modal; completing the level advances progress. Progress persists via `localStorage`.

## Tech Stack
- Pixi.js 8
- TypeScript 5
- Vite (dev server + build)
- Minimal DOM overlay for modal & controls

## Features
- 30 level nodes placed on a winding path (procedural positions)
- Level states: current, unlocked (next), completed, locked
- Animated token tween to new level
- Accessible reset button & modal structure
- Persistent progress (localStorage key: `trailProgressV2`)

## Scripts
```bash
npm install          # install dependencies
npm run dev          # start Vite dev server
npm run build        # production build (dist/)
npm run preview      # preview production build
npm run typecheck    # run TypeScript only
npm run deploy       # build into docs/ for GitHub Pages
```

## Running (Quick Start)
```bash
npm install
npm run dev
# Open the printed local URL (usually http://localhost:5173)
```

## File Structure
```
index.html
package.json
vite.config.(auto)  # (implicit default, none custom yet)
tsconfig.json
src/
  main.ts          # Pixi application logic
  styles.css       # UI & modal styles
```

## Progress Data
Stored as JSON: `{ "current": number }` under key `trailProgressV2`.
Reset via the Reset button or clearing site data.

## Possible Enhancements
- Stars / score per level (expand data schema)
- Multiple worlds w/ paging & scroll transitions
- Zoom & pan (Pixi interaction + wheel)
- Particle effects on completion
- Save migration from previous version key
- Minimap overlay

## Deployment (GitHub Pages)

Automated GitHub Pages deployment is configured via the workflow at `.github/workflows/pages.yml`.

How it works:
1. On every push to `main`, the action installs deps, runs `npm run build`, and uploads the `docs/` folder as the Pages artifact.
2. The deploy job publishes that artifact to the GitHub Pages environment.
3. The `.nojekyll` file in `docs/` ensures asset paths with leading underscores are not processed by Jekyll.

Manual trigger:
- You can also run it from the Actions tab with the "Run workflow" button.

Local test before pushing:
```bash
npm run deploy   # builds into docs/
npm run preview  # optional preview of production bundle
```

Expected URL pattern:
```
https://<your-username>.github.io/<repository-name>/
```
For this repo: `https://<your-username>.github.io/game.trail.prototype/`

If you later change the repo name, update the `base` option in `vite.config.ts` so relative asset URLs resolve correctly on Pages.

## License
MIT
