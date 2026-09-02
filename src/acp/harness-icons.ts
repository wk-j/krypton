// Krypton — ACP Harness View: inline SVG symbol defs.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Injected once into the
// harness DOM by buildDOM(); every symbol uses currentColor so callers recolour
// via CSS alone.

// Inline <symbol> defs for the thirteen built-in backends. Geometry is copied
// from docs/prototypes/125-lane-rail-disambiguation.html — keep both sides
// in sync if iterated. All strokes/fills use currentColor so the rail can
// recolor via a single CSS class.
export const BACKEND_LOGO_SVG_DEFS = [
  // claude: 8-spoke asterisk
  '<symbol id="krypton-logo-claude" viewBox="0 0 16 16">' +
    '<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none">' +
    '<line x1="8" y1="2" x2="8" y2="14"/>' +
    '<line x1="2" y1="8" x2="14" y2="8"/>' +
    '<line x1="3.8" y1="3.8" x2="12.2" y2="12.2"/>' +
    '<line x1="3.8" y1="12.2" x2="12.2" y2="3.8"/>' +
    '</g></symbol>',
  // codex/openai: hex ring with dot
  '<symbol id="krypton-logo-codex" viewBox="0 0 16 16">' +
    '<polygon points="8,1.6 13.6,5 13.6,11 8,14.4 2.4,11 2.4,5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>' +
    '</symbol>',
  // opencode: curly braces
  '<symbol id="krypton-logo-opencode" viewBox="0 0 16 16">' +
    '<path d="M6 2 Q3.5 2 3.5 4.5 V7 Q3.5 8 2.2 8 Q3.5 8 3.5 9 V11.5 Q3.5 14 6 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path d="M10 2 Q12.5 2 12.5 4.5 V7 Q12.5 8 13.8 8 Q12.5 8 12.5 9 V11.5 Q12.5 14 10 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</symbol>',
  // pi-acp: pi glyph
  '<symbol id="krypton-logo-pi" viewBox="0 0 16 16">' +
    '<path d="M2.5 5 H13.5 M5 5 V12 Q5 13 6 13 M11 5 V12 Q11 13 12 13 M13 13 L13.5 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</symbol>',
  // droid: robot face
  '<symbol id="krypton-logo-droid" viewBox="0 0 16 16">' +
    '<rect x="2.5" y="3.5" width="11" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="6" cy="7.5" r="1" fill="currentColor"/>' +
    '<circle cx="10" cy="7.5" r="1" fill="currentColor"/>' +
    '<line x1="6.5" y1="10.5" x2="9.5" y2="10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<line x1="8" y1="1.5" x2="8" y2="3.5" stroke="currentColor" stroke-width="1.3"/>' +
    '</symbol>',
  // cursor: isometric cube, filled top face (Anysphere mark)
  '<symbol id="krypton-logo-cursor" viewBox="0 0 16 16">' +
    '<polygon points="8,1.6 13.6,5 13.6,11 8,14.4 2.4,11 2.4,5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M8 1.6 L13.6 5 L8 8.4 L2.4 5 Z" fill="currentColor"/>' +
    '<line x1="8" y1="8.4" x2="8" y2="14.4" stroke="currentColor" stroke-width="1.3"/>' +
    '</symbol>',
  // junie: bracket frame (jetbrains-ish)
  '<symbol id="krypton-logo-junie" viewBox="0 0 16 16">' +
    '<rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5.5 5.5 H10.5 M10.5 5.5 V9.5 Q10.5 11 9 11 H7.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</symbol>',
  // omp: concentric rings (also serves as neutral fallback)
  '<symbol id="krypton-logo-omp" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="0.6" fill="currentColor"/>' +
    '</symbol>',
  // grok/xai: angular bolt (hard-edged, x.ai identity)
  '<symbol id="krypton-logo-grok" viewBox="0 0 16 16">' +
    '<path d="M9.2 1.5 L3.8 8.8 H6.9 L5.8 14.5 L12.2 6.6 H8.8 Z" fill="currentColor"/>' +
    '</symbol>',
  // copilot: rounded goggle/visor head + antenna (GitHub Copilot mascot)
  '<symbol id="krypton-logo-copilot" viewBox="0 0 16 16">' +
    '<path d="M8 5 V3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<rect x="2.5" y="5" width="11" height="7.4" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<ellipse cx="6.2" cy="8.7" rx="0.95" ry="1.5" fill="currentColor"/>' +
    '<ellipse cx="9.8" cy="8.7" rx="0.95" ry="1.5" fill="currentColor"/>' +
    '</symbol>',
  // mimo: "mi" mark in a rounded tile (Xiaomi MiMo-Code)
  '<symbol id="krypton-logo-mimo" viewBox="0 0 16 16">' +
    '<rect x="2" y="2" width="12" height="12" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M4.8 11 V6 H7.6 Q8.8 6 8.8 7.2 V11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<line x1="11.2" y1="6" x2="11.2" y2="11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</symbol>',
  // cline: terminal prompt bracket + caret (CLI coding agent)
  '<symbol id="krypton-logo-cline" viewBox="0 0 16 16">' +
    '<rect x="2" y="2.5" width="12" height="11" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5 6.2 L7.4 8 L5 9.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<line x1="8.6" y1="10.2" x2="11" y2="10.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</symbol>',
].join('');

// Lane-bar telemetry icons — same <symbol>/<use> + currentColor mechanism as the
// backend logos above, sized to the text cell in CSS so they recolour per lane
// accent / status with no glyph-font dependency. Geometry mirrors the approved
// artifact (art-2 — ACP harness lane bar). Injected once in buildDOM().
export const HARNESS_ICON_SVG_DEFS = [
  // status set (row 1 leading glyph) — tinted by state via the symbol's color
  '<symbol id="krypton-icon-status-starting" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-status-idle" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>',
  '<symbol id="krypton-icon-status-busy" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-status-perm" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="8" y1="4.6" x2="8" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.3" r="0.9" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-status-peer" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6 H12 M10 4 L12 6 L10 8"/><path d="M13 10 H4 M6 8 L4 10 L6 12"/></g></symbol>',
  '<symbol id="krypton-icon-status-error" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>',
  // chip + stat glyphs
  '<symbol id="krypton-icon-check" viewBox="0 0 16 16"><path d="M3.5 8.4 L6.4 11.3 L12.5 4.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-warn" viewBox="0 0 16 16"><path d="M8 2.6 L14.6 13.4 H1.4 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="8" y1="6.6" x2="8" y2="9.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.8" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-inbox" viewBox="0 0 16 16"><rect x="2.4" y="4" width="11.2" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.8 5 L8 9 L13.2 5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-gauge" viewBox="0 0 16 16"><path d="M2.8 11.8 A5.6 5.6 0 1 1 13.2 11.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.4"/><path d="M2.8 11.8 A5.6 5.6 0 0 1 5.2 4.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>',
  '<symbol id="krypton-icon-dl" viewBox="0 0 16 16"><path d="M8 3 V12 M4.6 8.5 L8 12 L11.4 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-ul" viewBox="0 0 16 16"><path d="M8 13 V4 M4.6 7.5 L8 4 L11.4 7.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-list" viewBox="0 0 16 16"><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="3.5" y1="5" x2="12.5" y2="5"/><line x1="3.5" y1="8" x2="12.5" y2="8"/><line x1="3.5" y1="11" x2="12.5" y2="11"/></g></symbol>',
  '<symbol id="krypton-icon-tool" viewBox="0 0 16 16"><path d="M11.2 2.4 a2.8 2.8 0 0 0 -3.5 3.5 L2.8 10.8 a1.25 1.25 0 0 0 1.8 1.8 L9.5 7.5 a2.8 2.8 0 0 0 3.5 -3.5 L11 6 L9.4 6 L9.4 4.4 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></symbol>',
].join('');

const SYMBOL_DEFS_ID = 'krypton-harness-symbol-defs';

/** Inject the backend-logo + lane-bar icon `<symbol>` defs into the document,
 *  once. Document-level rather than per view (spec 218) for two reasons: a
 *  window's status-bar lane strip is rendered into `.krypton-window__footer`,
 *  which sits outside the harness view's subtree and still needs
 *  `<use href="#krypton-logo-*"/>` to resolve, and two harness panes used to
 *  inject the same ids twice — where a duplicate id silently resolves to
 *  whichever copy came first. Safe to call from any surface at any time. */
export function ensureHarnessSymbolDefs(): void {
  if (document.getElementById(SYMBOL_DEFS_ID)) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.id = SYMBOL_DEFS_ID;
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.setAttribute('aria-hidden', 'true');
  defs.style.position = 'absolute';
  defs.innerHTML = `<defs>${BACKEND_LOGO_SVG_DEFS}${HARNESS_ICON_SVG_DEFS}</defs>`;
  document.body.appendChild(defs);
}

/** Lane-bar telemetry icon — references a HARNESS_ICON_SVG_DEFS symbol. The svg
 * inherits currentColor so it recolours with its container (lane accent/status). */
export function harnessIcon(id: string, cls = ''): string {
  return `<svg class="acp-harness__icon${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#krypton-icon-${id}"/></svg>`;
}


