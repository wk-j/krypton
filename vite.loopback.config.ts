import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const repoRoot = import.meta.dirname;

// Spec 330: modules the hook server's fixed loopback pages share with the app.
// Those pages are inline HTML (`include_str!`), so a renderer they need is
// bundled here and served from the embedded `dist/loopback/` in release builds;
// debug builds redirect to the Vite dev server instead.
export default defineConfig({
  publicDir: false,
  build: {
    target: 'esnext',
    outDir: resolve(repoRoot, 'dist/loopback'),
    emptyOutDir: true,
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    lib: {
      entry: resolve(repoRoot, 'src/acp/loopback-cell-grid.ts'),
      formats: ['es'],
      fileName: () => 'cell-grid.js',
      cssFileName: 'cell-grid',
    },
  },
});
