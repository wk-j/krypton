// Krypton — ACP Harness thought teletype (spec 232).
//
// Catch-up print head for the rail thought card while phase === 'delta'.
// Pure step + a small DOM painter. The view owns the rAF; this module
// never touches AcpHarnessView.

export const THOUGHT_TELETYPE_FRESH = 10;
export const THOUGHT_TELETYPE_MAX_BEHIND = 16;

export interface ThoughtTeletypeState {
  source: string;
  shown: number;
}

export interface ThoughtTeletypeStepOpts {
  reducedMotion: boolean;
  phase: 'veil' | 'delta' | 'seal' | 'empty';
}

const states = new WeakMap<HTMLElement, ThoughtTeletypeState>();

export function nextCodePointIndex(source: string, shown: number): number {
  if (shown >= source.length) return source.length;
  const hi = source.charCodeAt(shown);
  if (hi >= 0xd800 && hi <= 0xdbff && shown + 1 < source.length) {
    const lo = source.charCodeAt(shown + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return shown + 2;
  }
  return shown + 1;
}

export function splitTeletypePaint(
  source: string,
  shown: number,
): { ghost: string; fresh: string } {
  const end = Math.min(Math.max(0, shown), source.length);
  const split = Math.max(0, end - THOUGHT_TELETYPE_FRESH);
  return { ghost: source.slice(0, split), fresh: source.slice(split, end) };
}

export function stepThoughtTeletype(
  state: ThoughtTeletypeState,
  opts: ThoughtTeletypeStepOpts,
): ThoughtTeletypeState {
  const source = state.source;
  if (opts.reducedMotion || opts.phase !== 'delta') {
    return { source, shown: source.length };
  }
  if (source.length < state.shown) {
    return { source, shown: source.length };
  }
  if (source.length - state.shown > THOUGHT_TELETYPE_MAX_BEHIND) {
    return { source, shown: Math.max(0, source.length - THOUGHT_TELETYPE_FRESH) };
  }
  return { source, shown: nextCodePointIndex(source, state.shown) };
}

export function prefersReducedMotion(
  media: { matchMedia?: (query: string) => { matches: boolean } } = globalThis,
): boolean {
  const fn = media.matchMedia;
  if (typeof fn !== 'function') return false;
  return fn.call(media, '(prefers-reduced-motion: reduce)').matches;
}

export function thoughtTeletypeCatchUpPending(body: HTMLElement): boolean {
  const state = states.get(body);
  return !!state && state.shown < state.source.length;
}

export function clearThoughtTeletype(body: HTMLElement): void {
  states.delete(body);
  body.classList.remove('acp-harness__msg-body--thought-teletype');
}

export function applyThoughtTeletype(
  body: HTMLElement,
  source: string,
  opts: { reducedMotion?: boolean } = {},
): boolean {
  const reducedMotion = opts.reducedMotion ?? prefersReducedMotion();
  const prev = states.get(body) ?? { source: '', shown: 0 };
  const prefix = prev.source.slice(0, prev.shown);
  const rewritten = source.length < prev.shown || !source.startsWith(prefix);
  const next = rewritten || reducedMotion
    ? { source, shown: source.length }
    : stepThoughtTeletype({ source, shown: prev.shown }, { reducedMotion: false, phase: 'delta' });
  states.set(body, next);
  paintThoughtTeletype(body, next, { caret: !reducedMotion });
  return next.shown < next.source.length;
}

export function tickThoughtTeletype(
  body: HTMLElement,
  opts: { reducedMotion?: boolean } = {},
): boolean {
  const state = states.get(body);
  if (!state) return false;
  const reducedMotion = opts.reducedMotion ?? prefersReducedMotion();
  const next = stepThoughtTeletype(state, { reducedMotion, phase: 'delta' });
  states.set(body, next);
  paintThoughtTeletype(body, next, { caret: !reducedMotion });
  return next.shown < next.source.length;
}

export function paintThoughtTeletype(
  body: HTMLElement,
  state: ThoughtTeletypeState,
  opts: { caret: boolean },
): void {
  body.classList.remove(
    'acp-harness__msg-body--thought-veil',
    'acp-harness__msg-body--markdown',
  );
  body.classList.add(
    'acp-harness__msg-body--stream-plain',
    'acp-harness__msg-body--thought-teletype',
  );
  delete body.dataset.peekSrc;
  delete body.dataset.peekLen;
  delete body.dataset.pretext;
  delete body.dataset.rawText;
  delete body.dataset.rowId;

  let ghost = body.querySelector<HTMLElement>(':scope > .acp-harness__thought-ghost');
  let fresh = body.querySelector<HTMLElement>(':scope > .acp-harness__thought-fresh');
  let caret = body.querySelector<HTMLElement>(':scope > .acp-harness__thought-caret');
  if (!ghost || !fresh) {
    body.replaceChildren();
    ghost = document.createElement('span');
    ghost.className = 'acp-harness__thought-ghost';
    fresh = document.createElement('span');
    fresh.className = 'acp-harness__thought-fresh';
    body.append(ghost, fresh);
    caret = null;
  }
  const parts = splitTeletypePaint(state.source, state.shown);
  ghost.textContent = parts.ghost;
  fresh.textContent = parts.fresh;
  if (opts.caret) {
    if (!caret) {
      caret = document.createElement('span');
      caret.className = 'acp-harness__thought-caret';
      caret.setAttribute('aria-hidden', 'true');
      body.appendChild(caret);
    }
  } else if (caret) {
    caret.remove();
  }
}
