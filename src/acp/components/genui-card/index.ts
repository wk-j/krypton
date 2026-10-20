// Spec 309 — the sealed transcript card for a `krypton-ui` fence.
//
// Decoration is block-level fail-closed: a fence that does not compile keeps
// its `pre` and gains a one-line error carrying the first diagnostic, so the
// source stays readable. A fence that compiles is replaced by a static card;
// everything interactive happens in the panel the card opens.
//
// While the reply streams, the fence is collapsed instead of painted: see
// `updateLiveUiFences` at the bottom of this file.

import './genui-card.css';

import { el } from '../../../ui/dom';
import type { CallExpr, Program } from '../../genui/ast';
import { walkProgram } from '../../genui/ast';
import { COMPONENT_BY_NAME, tableHas } from '../../genui/catalog';
import { compile, uiSourceHash } from '../../genui/compile';
import { UI_MAX_PER_ITEM } from '../../genui/limits';
import type { UiFenceEntry } from '../../genui/types';
import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** The first statement that renders, when it is a component call. */
function firstRoot(program: Program): CallExpr | null {
  for (const stmt of program.stmts) {
    if (stmt.t === 'root') return stmt.value.t === 'call' ? stmt.value : null;
  }
  return null;
}

/** The outermost `Card`'s title literal, else the first root's component name. */
function cardTitle(program: Program): string {
  const root = firstRoot(program);
  if (root === null) return 'Interactive UI';
  if (root.callee === 'Card') {
    const title = root.args.find((arg) => arg.name === null || arg.name === 'title');
    if (title !== undefined && title.value.t === 'lit' && typeof title.value.v === 'string') return title.value.v;
  }
  return root.callee;
}

/**
 * What the spec contains, counted off the catalog: `chart · table · 2 inputs`.
 * `walkProgram` runs off a stack, so the data parts are re-sorted by where
 * they appear in the source rather than by the order they were visited.
 */
function cardSummary(program: Program): string {
  const data: { name: string; line: number; column: number }[] = [];
  let inputs = 0;
  walkProgram(program, (expr) => {
    if (expr.t !== 'call' || !tableHas(COMPONENT_BY_NAME, expr.callee)) return;
    const component = COMPONENT_BY_NAME[expr.callee];
    if (component.params.some((param) => param.kind === 'binding')) {
      inputs += 1;
      return;
    }
    if (component.group !== 'Data') return;
    const seen = data.find((entry) => entry.name === component.name);
    if (seen === undefined) data.push({ name: component.name, line: expr.line, column: expr.column });
    else if (expr.line < seen.line || (expr.line === seen.line && expr.column < seen.column)) {
      seen.line = expr.line;
      seen.column = expr.column;
    }
  });
  data.sort((a, b) => a.line - b.line || a.column - b.column);
  const parts = data.slice(0, 3).map((entry) => entry.name.toLowerCase());
  if (inputs > 0) parts.push(`${inputs} input${inputs === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' · ') : 'interactive UI';
}

/** Decoration stays inside the AssistantRow paint, after pure markdown is cached. */
export function decorateUiFences(body: HTMLElement, item: HarnessTranscriptItem): void {
  const prior = item.uiFences ?? [];
  const entries: UiFenceEntry[] = [];
  let candidates = 0;
  for (const code of body.querySelectorAll<HTMLElement>('pre > code')) {
    if (!code.classList.contains('krypton-ui') && !code.classList.contains('language-krypton-ui')) continue;
    if (++candidates > UI_MAX_PER_ITEM) break;
    const pre = code.parentElement;
    if (!pre) continue;
    const source = (code.textContent ?? '').replace(/\n$/, '');
    const index = candidates - 1;
    let entry = prior.find((candidate) => candidate.index === index && candidate.source === source);
    if (entry === undefined) {
      const { program, diagnostics } = compile(source);
      const failure = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (program === null || failure !== undefined) {
        const reason = failure === undefined ? 'spec did not compile' : `line ${failure.line}: ${failure.message}`;
        pre.before(el('div', { class: 'acp-genui-card__error', text: `UI unavailable: ${reason}. Source is shown below.` }));
        continue;
      }
      entry = {
        index,
        source,
        sourceHash: uiSourceHash(source),
        title: cardTitle(program),
        summary: cardSummary(program),
        hintLabel: null,
        program,
        diagnostics,
      };
    }
    entries.push(entry);
    const card = el('div', { class: 'acp-genui-card' });
    // Match the SVG preview's Full HD width cap in device pixels.
    const pixelRatio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    card.style.maxWidth = `${Math.round(1920 / pixelRatio)}px`;
    const button = el('button', {
      class: 'acp-genui-card__open',
      attrs: {
        type: 'button',
        'data-genui-index': String(index),
        'aria-expanded': 'false',
        'aria-label': `Open interactive UI: ${entry.title}`,
      },
    });
    button.append(
      el('span', { class: 'acp-genui-card__title', text: entry.title }),
      el('span', { class: 'acp-genui-card__summary', text: entry.summary }),
      el('span', { class: 'acp-genui-card__hint', text: entry.hintLabel ?? '' }),
    );
    // spec 310: the seat for the view's single live panel. Rebuilt empty on
    // every re-decoration; the view re-appends the panel node right after.
    card.append(button, el('div', { class: 'acp-genui-card__panel', attrs: { 'data-genui-slot': String(index) } }));
    pre.replaceWith(card);
  }
  if (entries.length) item.uiFences = entries;
  else delete item.uiFences;
}

export function patchUiHints(body: HTMLElement, item: HarnessTranscriptItem): void {
  for (const entry of item.uiFences ?? []) {
    const button = body.querySelector<HTMLElement>(`[data-genui-index="${entry.index}"] .acp-genui-card__hint`);
    if (button) button.textContent = entry.hintLabel ?? '';
  }
}

/** The streaming stand-in, removed at seal. Same block as the real card, so
 *  the swap does not move the rows under it. */
const LIVE_CARD = 'acp-genui-card--live';

/**
 * Spec 309 revision — collapse a `krypton-ui` fence while it streams.
 *
 * A spec is a program the user has no use for as text: streaming it paints
 * tens of lines of source that seal then replaces with a one-line card. This
 * puts that card's place-holder in early — a strip naming the fence and its
 * growing line count — and the sheet hides the fence's own `pre` while the
 * body is `--stream-live`.
 *
 * Nothing is compiled and no control is mounted (spec 309 Out of Scope: no
 * partial-prefix compilation, no UI while streaming) — the strip is text.
 * Like the spec 283 live svg card it is a SIBLING inserted before the
 * parser-owned `pre`: smd only ever appends into the nodes it holds, so the
 * `pre`/`code` are never wrapped or moved. Called after each `parser_write`.
 */
export function updateLiveUiFences(body: HTMLElement): void {
  let candidates = 0;
  // Live bodies are always smd: the whole info string is the class.
  for (const code of body.querySelectorAll<HTMLElement>('pre > code.krypton-ui')) {
    if (++candidates > UI_MAX_PER_ITEM) break;
    const pre = code.parentElement;
    if (!pre) continue;
    let strip = pre.previousElementSibling;
    if (!(strip instanceof HTMLElement) || !strip.classList.contains(LIVE_CARD)) {
      strip = el(
        'div',
        { class: `acp-genui-card ${LIVE_CARD}` },
        el('span', { class: 'acp-genui-card__title', text: 'interactive UI' }),
        el('span', { class: 'acp-genui-card__summary' }),
      );
      pre.before(strip);
    }
    const summary = strip.querySelector<HTMLElement>('.acp-genui-card__summary');
    // The growing count is the liveness signal; an `infinite` animation here
    // would be one more thing seal has to be trusted to remove.
    const lines = (code.textContent ?? '').replace(/\n$/, '').split('\n').length;
    if (summary) summary.textContent = `receiving spec · ${lines} line${lines === 1 ? '' : 's'}`;
  }
}

/** Seal hand-off: drop the strips before the body is captured into
 *  `markdownHtml`, so the cache stays pure markdown and `decorateUiFences`
 *  builds the real card against a `pre` with nothing in front of it. */
export function clearLiveUiFences(body: HTMLElement): void {
  for (const strip of Array.from(body.querySelectorAll(`.${LIVE_CARD}`))) strip.remove();
}

/**
 * Spec 310 — seat the one live panel node in this body, or clear it.
 *
 * Returns whether `target` found its slot: a `false` from every mounted row
 * is how the view learns the open fence is gone (row disposed, lane switched,
 * source re-streamed) and collapses. Called outside `paint()`, like
 * `patchUiHints` — the card's open state is not in `AssistantRow.bodyDeps`.
 */
export function syncUiPanel(
  body: HTMLElement,
  target: { readonly index: number; readonly panel: HTMLElement } | null,
): boolean {
  let mounted = false;
  for (const card of body.querySelectorAll<HTMLElement>('.acp-genui-card')) {
    const slot = card.querySelector<HTMLElement>('[data-genui-slot]');
    const open = target !== null && slot?.dataset.genuiSlot === String(target.index);
    if (open && slot) {
      if (target.panel.parentElement !== slot) slot.appendChild(target.panel);
      mounted = true;
    }
    card.classList.toggle('acp-genui-card--open', open);
    card.querySelector<HTMLElement>('[data-genui-index]')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  return mounted;
}

export const def: ComponentDef = { id: 'genui-card', blocks: ['acp-genui-card'] };
