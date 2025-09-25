import { defineConfig } from 'vite';

// Vite configuration tailored for GitHub Pages deployment.
// base must match the repository name so assets resolve under the project page URL.
export default defineConfig({
  base: '/game.trail.prototype/',
  publicDir: 'assets', // copy existing assets folder as-is
  build: {
    outDir: 'docs',      // GitHub Pages can serve from /docs on main
    emptyOutDir: true,
    sourcemap: false
  }
});
