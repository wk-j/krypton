import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        main: 'index.html',
        liveAssist: 'live-assist.html',
      },
    },
  },
  // Spec 301 phase 0. `environmentMatchGlobs` was removed in vitest 4, so the
  // node/DOM split is expressed as two projects instead: the component kernel and
  // the harness components need a DOM, every other suite keeps the `node`
  // environment it was written against.
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'src/ui/**', 'src/acp/components/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['src/ui/**/*.test.ts', 'src/acp/components/**/*.test.ts'],
        },
      },
    ],
  },
});
