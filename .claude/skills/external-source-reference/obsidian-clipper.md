# Obsidian Clipper Reference

Local repo: `/Users/wk/Source/obsidian-clipper` — git HEAD `48228dc` at time of writing.

Use this when Krypton work needs prior art for browser clipping, page extraction, Markdown
conversion, template variables/filters/logic, highlights, reader mode, or handing generated
notes to Obsidian.

## What It Is

Obsidian Web Clipper is the official browser extension for capturing web pages and highlights as
durable Markdown files. It targets Chromium, Firefox, and Safari, and also exposes CLI/API builds.

Core dependencies and concepts:

- `defuddle` extracts readable page content and converts HTML to Markdown.
- `webextension-polyfill` normalizes browser extension APIs.
- `linkedom` provides DOM parsing for the CLI path.
- The template engine supports variables, filters, `if`/`elseif`/`else`, `for`, `set`, and
  whitespace control.
- Obsidian delivery can be done through local file output, Obsidian CLI, or Obsidian URI.

## Entry Points

| Area | Files |
|------|-------|
| Extension lifecycle/background routing | `src/background.ts`, `src/content.ts` |
| Programmatic clipping API | `src/api.ts` |
| CLI wrapper and template-directory matching | `src/cli.ts`, `src/utils/cli-utils.ts` |
| Content extraction and variable initialization | `src/utils/content-extractor.ts`, `src/utils/shared.ts` |
| Template parser/compiler/renderer | `src/utils/parser.ts`, `src/utils/template-compiler.ts`, `src/utils/renderer.ts`, `src/utils/filters.ts` |
| Obsidian note creation and handoff | `src/utils/obsidian-note-creator.ts`, `src/utils/cli-utils.ts` |
| Highlight capture/export | `src/utils/highlighter.ts`, `src/utils/highlighter-overlays.ts`, `src/core/highlights.ts` |
| Reader mode | `src/core/reader-view.ts`, `src/utils/reader.ts`, `src/reader-script.ts`, `src/reader.scss` |
| Settings/templates UI | `src/core/settings.ts`, `src/core/popup.ts`, `src/managers/template-manager.ts`, `src/managers/template-ui.ts` |
| Types | `src/types/types.ts` |
| Build/package targets | `package.json`, `webpack.config.js`, `scripts/build-cli.mjs`, `scripts/build-api.mjs`, `src/manifest.*.json` |
| User-facing behavior docs | `docs/Introduction to Obsidian Web Clipper.md`, `docs/Clip web pages.md`, `docs/Templates.md`, `docs/Variables.md`, `docs/Filters.md`, `docs/Logic.md`, `docs/Highlight web pages.md` |

## Commands

```sh
npm run build          # Build Chromium, Firefox, and Safari extension outputs
npm run dev:chrome     # Watch-build Chromium extension
npm run dev:firefox    # Watch-build Firefox extension
npm run dev:safari     # Watch-build Safari extension
npm test               # Vitest suite
npm run build:cli      # Build obsidian-clipper CLI bundle
npm run build:api      # Build programmatic API bundle
```

## Patterns To Study

### Programmatic clipping flow

`src/api.ts` is the cleanest environment-agnostic path. The caller supplies HTML, URL, a template,
and a `DocumentParser`; the API parses content with `defuddle`, converts content to Markdown,
builds variables, compiles the note name/properties/body, and returns a `ClipResult`.

Use this as the first reference for non-extension import or capture flows because it avoids direct
browser and Node assumptions.

### Template engine

Template logic lives in `src/utils/parser.ts`, `src/utils/template-compiler.ts`, and
`src/utils/renderer.ts`. It is useful prior art for user-authored Markdown templates with:

- variable interpolation and filters
- conditional blocks
- loops
- assignments
- async selector variables
- deferred prompt-like values

Read tests beside those files before copying behavior; they document edge cases more precisely
than the README.

### Browser extension extraction

`src/utils/content-extractor.ts` coordinates extraction from an active tab, retries Safari stale
content-script failures, handles selected HTML, merges highlights, converts content to Markdown,
and builds the variable map.

For cross-browser extension behavior, also read `src/utils/browser-polyfill.ts`,
`src/utils/browser-detection.ts`, and the three `src/manifest.*.json` files.

### Obsidian handoff

`src/utils/obsidian-note-creator.ts` and `src/utils/cli-utils.ts` are the key files for creating
notes and opening them in Obsidian. Check both when designing vault handoff, URI construction,
file output, or CLI integration.

## Cautions

- Treat this repo as read-only prior art for Krypton work.
- Confirm behavior against source before relying on this reference; the project is active and the
  checked-out HEAD can move.
- The README and docs describe user behavior; `src/api.ts` and the tests are better for stable
  implementation contracts.
