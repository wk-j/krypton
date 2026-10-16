// Shared DOM builders for the workspace footer: telemetry icons + the
// canonical `__segment` span.
import { BRANCH_ICON_BODY } from './chrome-icons';

// Footer telemetry icons — monoline SVGs sized to the
// text cell in CSS (currentColor + em → theme-aware, scales with the chrome font,
// no glyph-font dependency so they never fall back to tofu). Each is parsed once
// into a cached node (see `footerIcon()`) and cloned per segment, so the render hot
// path never re-parses markup. viewBox is 0 0 16 16; the base class is baked in.
const FOOTER_ICON_SVG: Record<string, string> = {
  // git branch: three nodes, the right one merging into the trunk. Geometry is
  // shared with the harness composer's branch readout (`chrome-icons.ts`).
  branch:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    BRANCH_ICON_BODY +
    '</svg>',
  // window/layout: a framed pane with a title bar and a vertical split
  layout:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M2.5 6.3 H13.5"/><path d="M8 6.3 V12.5"/></svg>',
  // process: a terminal prompt chevron + caret line
  prompt:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M4 5 L7.5 8 L4 11"/><path d="M9 11 H12.5"/></svg>',
  // throughput: paired up/down transfer arrows
  io:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M5 11.5 V4.5 M3 6.5 L5 4.5 L7 6.5"/><path d="M11 4.5 V11.5 M9 9.5 L11 11.5 L13 9.5"/></svg>',
  // filled status dot — used for the focused-view state and the git dirty marker
  dot:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="3.4"/></svg>',
};

/** Parsed-once SVG icon nodes, cloned per segment so renders never re-parse.
 *  Module-level: there is one footer and nodes are always cloned. */
const iconTemplates = new Map<string, SVGElement>();

/** Clone a cached telemetry icon. `variants` are short tokens mapped to
 * `__icon--<token>` BEM modifiers (e.g. 'fill dot'). Parses each SVG once. */
export function footerIcon(name: string, variants = ''): SVGElement {
  let tpl = iconTemplates.get(name);
  if (!tpl) {
    const holder = document.createElement('div');
    holder.innerHTML = FOOTER_ICON_SVG[name];
    tpl = holder.firstElementChild as SVGElement;
    iconTemplates.set(name, tpl);
  }
  const node = tpl.cloneNode(true) as SVGElement;
  for (const v of variants.split(/\s+/).filter(Boolean)) {
    node.classList.add(`krypton-workspace-footer__icon--${v}`);
  }
  return node;
}

export function footerSegment(text: string, modifiers: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `krypton-workspace-footer__segment ${modifiers
    .split(/\s+/)
    .filter(Boolean)
    .map((m) => `krypton-workspace-footer__segment--${m}`)
    .join(' ')}`;
  el.textContent = text;
  return el;
}
