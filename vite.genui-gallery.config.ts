import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const repoRoot = import.meta.dirname;

export default defineConfig({
  root: resolve(repoRoot, 'genui-gallery'),
  base: '/genui-gallery/',
  build: {
    target: 'esnext',
    outDir: resolve(repoRoot, 'dist/genui-gallery'),
    emptyOutDir: false,
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
