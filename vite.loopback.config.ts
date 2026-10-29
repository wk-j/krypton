import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { defineConfig } from 'vite';

const repoRoot = import.meta.dirname;
const entriesDir = resolve(repoRoot, 'src/loopback/entries');

// Spec 341: every loopback page is one entry of this build. Rust serves
// `/app/assets/<entry>.js` from `dist/app/` in release builds; debug builds
// redirect it to `src/loopback/entries/<entry>.ts` on the dev server. The entry
// set is the directory listing — there is no second list to keep in sync.
const input = Object.fromEntries(
  readdirSync(entriesDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => [basename(name, '.ts'), resolve(entriesDir, name)]),
);

export default defineConfig({
  publicDir: false,
  build: {
    target: 'esnext',
    outDir: resolve(repoRoot, 'dist/app'),
    emptyOutDir: true,
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // One stylesheet for every page: `/app/assets/app.css`.
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input,
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith('.css')) ? 'app.css' : 'chunks/[name]-[hash][extname]'),
      },
    },
  },
});
