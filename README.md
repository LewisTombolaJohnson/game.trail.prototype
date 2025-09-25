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

This repo is configured to deploy from the `docs/` folder on the `main` branch.

1. Build the project:
  ```bash
  npm run deploy
  ```
2. Commit the generated `docs/` directory:
  ```bash
  git add docs
  git commit -m "Build: deploy to pages"
  git push origin main
  ```
3. In the GitHub repository settings ( Settings > Pages ), set:
  - Source: Deploy from a branch
  - Branch: `main` / `/docs`
4. After it processes, access: `https://<your-username>.github.io/game.trail.prototype/`

If paths 404, confirm the `base` in `vite.config.ts` matches the repo name.

## License
MIT
