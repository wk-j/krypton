// Spec 341 — the markdown reading surface. CSS only: Rust renders the markup
// (`<article class="lb-prose">`); importing this module brings the sheet.
// Spec 361: no component — React never renders reader bodies.

import './prose.css';

export const PROSE_CLASS = 'lb-prose';
