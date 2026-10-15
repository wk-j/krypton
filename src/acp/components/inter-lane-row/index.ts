// Spec 302 §3.11 — `InterLaneRow`.
//
// Lane mail (spec 120). It renders like an agent message — the markdown blocks
// are direct children of the row body, same `--markdown` body class as an
// assistant row — led by one meta line. No wrapper around the text, no tinted
// card; the direction and the closed state live on the wrapper instead.
//
// Static: a mail row is appended whole, never streamed into. The markdown is
// parsed once and cached on the item, exactly as today, so a repaint of a
// neighbouring row costs nothing here.
//
// Ported from `harness-transcript-render.ts:371-377` (the dispatcher branch)
// and `:784-824` (`renderLaneMailBody` + `formatLaneMailMetaLine`). Markup is
// unchanged.

import { el } from '../../../ui/dom';
import { backendLogoId } from '../../harness-lane-identity';
import { md } from '../../harness-markdown';
import type { HarnessTranscriptItem, InterLanePayload } from '../../harness-view-types';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';
import './inter-lane-row.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** spec 120 — the one-line envelope header above the message body. */
export function formatLaneMailMetaLine(payload: InterLanePayload): string {
  const arrow = payload.direction === 'in' ? '←' : '→';
  const rel = payload.direction === 'in' ? 'from' : 'to';
  let line = `${arrow} ${rel} ${payload.peerDisplayName.toLowerCase()} · lane mail`;
  if (payload.channel === 'mention') line += ' · mention';
  if (payload.done) line += ' · closed';
  return line;
}

/**
 * Parse and cache the mail body's markdown on the item, returning the HTML.
 *
 * Called from `bodyDeps()` so the parsed HTML is itself the dependency: the
 * body class (`--markdown` or not) is decided by whether the parse succeeded,
 * and `syncClasses()` runs before `paintBody()`.
 */
function laneMailHtml(item: HarnessTranscriptItem, message: string): string | undefined {
  if (item.markdownSource === message && item.markdownHtml !== undefined) return item.markdownHtml;
  try {
    item.markdownHtml = md.parse(message, { async: false }) as string;
    item.markdownSource = message;
  } catch {
    item.markdownHtml = undefined;
    item.markdownSource = undefined;
  }
  return item.markdownHtml;
}

export class InterLaneRow extends TranscriptRow {
  private readonly meta = el('span', { class: 'acp-harness__lane-mail-meta' });

  constructor(props: RowProps) {
    super(props, false);
  }

  protected wrapperModifiers(next: RowProps): readonly string[] {
    const payload = next.item.interLane;
    if (!payload) return [];
    // `acp-harness__msg--inter_lane` already comes from `item.kind`.
    if (!payload.done) return [`acp-harness__msg--mail-${payload.direction}`];
    return [`acp-harness__msg--mail-${payload.direction}`, 'acp-harness__msg--mail-done'];
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    if (!next.item.interLane) return [];
    return next.item.markdownHtml === undefined ? [] : ['acp-harness__msg-body--markdown'];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const payload = next.item.interLane;
    if (!payload) {
      return [undefined, undefined, undefined, undefined, undefined, next.item.text];
    }
    return [
      // `direction` and `done` also drive `wrapperModifiers()`; they are listed
      // on their own rather than left implicit in the formatted meta line.
      payload.direction,
      payload.done,
      formatLaneMailMetaLine(payload),
      payload.peerBackendId,
      next.item.text,
      laneMailHtml(next.item, next.item.text),
    ];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const payload = next.item.interLane;
    if (!payload) {
      body.textContent = next.item.text;
      return;
    }
    const nodes: Node[] = [];
    if (payload.peerBackendId) {
      // Built node-by-node rather than through `harnessSymbolEl()`: that helper
      // stamps `class="acp-harness__icon"` on the <svg>, and the mail logo is
      // sized by `.acp-harness__lane-mail-logo svg` instead. Keeping the class
      // off keeps the emitted markup identical to today's.
      const logo = el('span', {
        class: `acp-harness__lane-mail-logo acp-harness__lane-mail-logo--${payload.peerBackendId}`,
      });
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', `#${backendLogoId(payload.peerBackendId)}`);
      svg.appendChild(use);
      logo.appendChild(svg);
      nodes.push(logo);
    }
    nodes.push(document.createTextNode(formatLaneMailMetaLine(payload)));
    this.meta.replaceChildren(...nodes);

    const html = next.item.markdownHtml;
    if (html === undefined) body.textContent = next.item.text;
    // The one sanctioned `innerHTML`: already-parsed markdown (spec 302
    // §Explicitly not components).
    else body.innerHTML = html;
    body.prepend(this.meta);
  }
}

export const def: ComponentDef = {
  id: 'inter-lane-row',
  blocks: ['acp-harness__lane-mail-meta', 'acp-harness__lane-mail-logo'],
};
