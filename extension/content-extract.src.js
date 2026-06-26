// Injected on demand into the active tab (doc 177). Bundled by esbuild into
// dist/content.bundle.js (IIFE) because an MV3 content script cannot import npm
// modules at runtime. Runs Defuddle against the live, already-authenticated DOM
// and exposes a single global the popup's follow-up executeScript({func}) calls,
// so the lane never has to re-fetch the URL server-side.
import Defuddle from 'defuddle/full';

// No length cap (doc 177, Open Question #2 resolved): the full extracted page is
// sent so long-form articles arrive intact. A very large page therefore produces
// a large prompt — accepted trade-off for completeness.
globalThis.__kryptonExtract = () => {
  try {
    const r = new Defuddle(document, { markdown: true, removeImages: true }).parse();
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
