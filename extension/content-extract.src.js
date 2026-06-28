// Injected on demand into the active tab (doc 177). Bundled by esbuild into
// dist/content.bundle.js (IIFE) because an MV3 content script cannot import npm
// modules at runtime. Runs Defuddle against the live, already-authenticated DOM
// and exposes a single global the popup's follow-up executeScript({func}) calls,
// so the lane never has to re-fetch the URL server-side.
import Defuddle from 'defuddle/full';

// No length cap (doc 177, Open Question #2 resolved): the full extracted page is
// sent so long-form articles arrive intact. A very large page therefore produces
// a large prompt — accepted trade-off for completeness.
// Async (doc 179): the YouTube transcript extractor in Defuddle declares
// prefersAsync() and only fetches captions on the async path, so we must use
// parseAsync() — the sync parse() returns only what is already in the DOM
// (an empty/collapsed transcript panel). Non-YouTube pages return the same
// shape as before. popup.js's executeScript({func}) awaits the returned Promise.
globalThis.__kryptonExtract = async () => {
  try {
    // Mirror obsidian-clipper (src/content.ts): race parseAsync() against an 8s
    // timeout and fall back to the sync parse() if the async path hangs (e.g. a
    // slow/blocked InnerTube fetch, or another extension having corrupted fetch).
    const defuddle = new Defuddle(document, { markdown: true, removeImages: true });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('parseAsync timeout')), 8000)
    );
    const r = await Promise.race([defuddle.parseAsync(), timeout]).catch(() => defuddle.parse());
    return {
      markdown: r.content || '',
      title: r.title || document.title || '',
      author: r.author || '',
      description: r.description || '',
      wordCount: r.wordCount || 0,
    };
  } catch {
    // Defuddle threw (exotic DOM) — let the popup fall back to URL-only.
    return null;
  }
};
