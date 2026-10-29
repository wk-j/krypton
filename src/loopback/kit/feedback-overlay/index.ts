// Spec 341 — the `/doc` reader's corner overlays, ported from the two inline
// scripts of the old docs page:
//
// * comments (spec 172): `c` arms a picker, a click anchors a passage, the
//   composer saves a pin (⌘/Ctrl+Enter) or cancels (Esc), `s` POSTs the unsent
//   batch to `/doc-feedback`, `j`/`k` cycle the pins. The anchor is the QUOTED
//   TEXT plus its heading trail, never a DOM selector: the lane edits the
//   source `.md`, not this comrak output. Unsent pins, the open draft and the
//   batch id survive a reload in sessionStorage `kdf:<harness>:<path>`.
// * artifact export (spec 174): `a` (or the pill) POSTs `/doc-artifact`; the
//   harness's active lane writes the artifact.
//
// A 2.5 s `/doc-state` poll reloads the page when the file's hash moves, but
// never while the picker is armed or the composer is open — the reload waits
// for them to close.

import { DisposableBag } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import { button } from '../button';
import { fetchJson, HttpError, postJson } from '../lib/fetch-json';
import { keymap } from '../lib/keymap';
import { poll } from '../lib/poll';
import type { Poller } from '../lib/poll';

import './feedback-overlay.css';

export interface DocPin {
  readonly id: string;
  readonly pinNumber: number;
  readonly body: string;
  readonly quote: string;
  readonly headingPath: readonly string[];
  readonly createdAt: number;
  sent: boolean;
  drifted: boolean;
}

interface Draft {
  quote: string;
  headingPath: string[];
  body: string;
}

interface SavedState {
  pins?: DocPin[];
  pinSeq?: number;
  draft?: Draft | null;
  batchId?: string | null;
}

type ArtifactState = 'ready' | 'sending' | 'queued' | 'error';

export interface FeedbackOverlayOptions {
  readonly harness: string;
  /** The doc's project-relative path, as the `/doc` query carries it. */
  readonly path: string;
  /** The rendered document: passages anchor and resolve inside it only. */
  readonly scope: HTMLElement;
  /** `/doc-state` cadence. Default 2500 ms. */
  readonly pollMs?: number;
  /** What a moved `/doc-state` hash does. Default `location.reload()`. */
  readonly reload?: () => void;
}

const BODY_MAX = 4000;
const QUOTE_MAX = 2000;
const FLASH_MS = 2200;
const ANCHORABLE = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,code,a,strong,em';

function cap(value: string | null | undefined, max: number): string {
  const text = value ?? '';
  return text.length > max ? text.slice(0, max) : text;
}

function randomHex(): string {
  return Math.random().toString(16).slice(2);
}

function displayPath(path: string): string {
  return path.split('/').filter((part) => part && part !== '.').join('/') || path || 'document.md';
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || 'document.md';
}

export class FeedbackOverlay {
  /** The bottom-right dock: composer, artifact pill, comment pill. */
  readonly el: HTMLElement;
  private readonly highlight = el('div', { class: 'lb-feedback__hi', attrs: { hidden: true } });
  private readonly target = el('div', { class: 'lb-feedback__target' });
  private readonly text = el('textarea', {
    class: ['lb-input', 'lb-feedback__text'],
    attrs: { placeholder: 'describe the change…', 'aria-label': 'Comment' },
  });
  private readonly box: HTMLElement;
  private readonly commentPill = el('button', {
    class: 'lb-feedback__pill',
    attrs: { type: 'button', title: 'Comment on a passage of this doc' },
  });
  private readonly artifactPill = el('button', {
    class: 'lb-feedback__pill',
    attrs: { type: 'button', title: 'Generate an HTML artifact from this doc' },
  });
  private readonly bag = new DisposableBag();
  private readonly poller: Poller;
  private readonly feedUrl: string;
  private readonly stateUrl: string;
  private readonly artifactUrl: string;
  private readonly storageKey: string;
  private readonly artifactTitle: string;

  private pins: DocPin[] = [];
  private pinSeq = 0;
  private draft: Draft | null = null;
  private batchId: string | null = null;
  private armed = false;
  private disabled = false;
  private cycleIdx = -1;
  private lastHash: string | null = null;
  private pendingReload = false;
  private flashMsg: string | null = null;
  private flashTimer: number | undefined;
  private highlightTimer: number | undefined;

  private artifactState: ArtifactState = 'ready';
  private artifactBatch: string | null = null;
  private artifactTimer: number | undefined;

  constructor(private readonly options: FeedbackOverlayOptions) {
    const query = `harness=${encodeURIComponent(options.harness)}&path=${encodeURIComponent(options.path)}`;
    this.feedUrl = `/doc-feedback?${query}`;
    this.stateUrl = `/doc-state?${query}`;
    this.artifactUrl = `/doc-artifact?${query}`;
    this.storageKey = `kdf:${options.harness}:${options.path}`;
    this.artifactTitle = `Docs artifact · ${basename(displayPath(options.path))}`;

    this.box = el(
      'div',
      { class: 'lb-feedback__box', attrs: { hidden: true } },
      this.target,
      this.text,
      el(
        'div',
        { class: 'lb-feedback__row' },
        el('span', { class: 'lb-feedback__keys', text: '⌘↵ save · esc cancel' }),
        el(
          'span',
          { class: 'lb-feedback__actions' },
          button('cancel', { variant: 'ghost', onClick: () => this.cancelComposer() }),
          button('save', { onClick: () => this.saveComposer() }),
        ),
      ),
    );
    this.el = el('div', { class: 'lb-feedback' }, this.box, this.artifactPill, this.commentPill);
    document.body.append(this.el, this.highlight);
    this.bag.add(() => {
      this.el.remove();
      this.highlight.remove();
      window.clearTimeout(this.flashTimer);
      window.clearTimeout(this.highlightTimer);
      window.clearTimeout(this.artifactTimer);
    });

    this.restore();
    this.bindEvents();
    this.bindKeys();

    // Reconcile restored pins against the current DOM: drifted = quote gone.
    for (const pin of this.pins) pin.drifted = !this.resolveByQuote(pin.quote);
    if (this.draft) this.openComposer();
    this.renderPill();
    this.setArtifact('ready', 'press a');

    this.poller = poll<{ hash?: string } | null>({
      intervalMs: options.pollMs ?? 2500,
      load: (signal) => this.loadState(signal),
      apply: (state) => this.onState(state),
    });
    this.bag.add(() => this.poller.dispose());
  }

  dispose(): void {
    this.bag.dispose();
  }

  // ── persisted state ────────────────────────────────────────────────────

  private restore(): void {
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.storageKey) ?? 'null') as SavedState | null;
      if (!saved) return;
      this.pins = (saved.pins ?? []).filter((pin) => !pin.sent);
      this.pinSeq = saved.pinSeq ?? this.pins.length;
      this.draft = saved.draft ?? null;
      this.batchId = saved.batchId ?? null;
    } catch {
      /* unreadable state starts fresh */
    }
  }

  private persist(): void {
    try {
      const state: SavedState = { pins: this.pins, pinSeq: this.pinSeq, draft: this.draft, batchId: this.batchId };
      sessionStorage.setItem(this.storageKey, JSON.stringify(state));
    } catch {
      /* storage full or disabled */
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.bag.listen(document, 'mousemove', (event) => this.onMove(event as MouseEvent), { capture: true });
    this.bag.listen(document, 'click', (event) => this.onClick(event as MouseEvent), { capture: true });
    this.bag.listen(
      window,
      'scroll',
      () => {
        if (this.armed) this.highlight.hidden = true;
      },
      { capture: true, passive: true },
    );
    this.bag.listen(this.commentPill, 'click', () => {
      if (this.disabled) return;
      if (this.armed) this.disarm();
      else this.arm();
    });
    this.bag.listen(this.artifactPill, 'click', () => this.requestArtifact());
    this.bag.listen(this.text, 'input', () => {
      if (!this.draft) return;
      this.draft.body = this.text.value;
      this.persist();
    });
  }

  private bindKeys(): void {
    const keys = keymap();
    const group = 'Doc comments';
    this.bag.add(keys.addModal(() => this.composerOpen()));
    this.bag.add(
      keys.bindAll([
        { key: 'c', label: 'Comment on a passage', group, run: () => this.arm() },
        { key: 's', label: 'Send unsent comments', group, run: () => this.sendBatch() },
        { key: 'j', label: 'Next comment pin', group, run: () => this.cyclePins(1) },
        { key: 'k', label: 'Previous comment pin', group, run: () => this.cyclePins(-1) },
        { key: 'Escape', label: 'Stop picking', group, when: () => this.armed, run: () => this.disarm() },
        {
          key: 'a',
          label: 'Generate an HTML artifact from this doc',
          group,
          run: (event) => {
            if (this.armed || this.inCommentOverlay(event.target)) return false;
            this.requestArtifact();
          },
        },
        {
          key: 'Escape',
          label: 'Cancel the comment',
          group,
          modal: true,
          inInput: true,
          when: () => this.composerOpen(),
          run: () => this.cancelComposer(),
        },
        {
          key: 'Enter',
          mod: true,
          label: 'Save the comment',
          group,
          modal: true,
          inInput: true,
          when: () => this.composerOpen(),
          run: () => this.saveComposer(),
        },
      ]),
    );
  }

  // ── picking ────────────────────────────────────────────────────────────

  private inOverlay(node: Element): boolean {
    return this.el.contains(node) || node === this.highlight;
  }

  /** The comment pill and composer (not the artifact pill). */
  private inCommentOverlay(target: EventTarget | null): boolean {
    return target instanceof Node && (this.box.contains(target) || this.commentPill.contains(target));
  }

  private pickable(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null;
    if (this.inOverlay(target) || !this.options.scope.contains(target)) return null;
    return target;
  }

  private onMove(event: MouseEvent): void {
    if (!this.armed) return;
    const node = this.pickable(event.target);
    if (node) this.showHighlight(node);
    else this.highlight.hidden = true;
  }

  private onClick(event: MouseEvent): void {
    if (!this.armed) return;
    const node = this.pickable(event.target);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    this.armed = false;
    let selection = '';
    try {
      selection = String(window.getSelection() ?? '').trim();
    } catch {
      /* no selection API */
    }
    const quote = selection || (node.textContent ?? '').trim();
    this.draft = { quote: cap(quote, QUOTE_MAX), headingPath: this.headingPathFor(node), body: '' };
    this.openComposer();
  }

  private arm(): void {
    if (this.disabled) return;
    this.armed = true;
    this.renderPill();
  }

  private disarm(): void {
    this.armed = false;
    this.highlight.hidden = true;
    this.renderPill();
    this.maybeDeferredReload();
  }

  /** The nearest preceding heading plus its higher-level ancestors. */
  private headingPathFor(node: Element): string[] {
    const headText = (h: Element): string => cap((h.textContent ?? '').trim(), 120);
    const heads = [...this.options.scope.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const preceding = heads.filter(
      (h) => h === node || (node.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
    );
    if (preceding.length === 0) return [];
    let index = preceding.length - 1;
    let level = Number(preceding[index].tagName.slice(1));
    const path = [headText(preceding[index])];
    for (index -= 1; index >= 0 && level > 1; index--) {
      const lv = Number(preceding[index].tagName.slice(1));
      if (lv < level) {
        path.unshift(headText(preceding[index]));
        level = lv;
      }
    }
    return path;
  }

  /** The most specific (shortest-text) element containing `quote`. */
  private resolveByQuote(quote: string | null | undefined): Element | null {
    const needle = (quote ?? '').trim();
    if (!needle) return null;
    let best: Element | null = null;
    let bestLen = Infinity;
    for (const node of this.options.scope.querySelectorAll(ANCHORABLE)) {
      const text = node.textContent ?? '';
      if (text.includes(needle) && text.length < bestLen) {
        best = node;
        bestLen = text.length;
      }
    }
    return best;
  }

  private showHighlight(node: Element): void {
    const rect = node.getBoundingClientRect();
    Object.assign(this.highlight.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    this.highlight.hidden = false;
  }

  private flashHighlight(node: Element): void {
    this.showHighlight(node);
    window.clearTimeout(this.highlightTimer);
    this.highlightTimer = window.setTimeout(() => {
      if (!this.armed) this.highlight.hidden = true;
    }, 1200);
  }

  // ── composer ───────────────────────────────────────────────────────────

  private composerOpen(): boolean {
    return !this.box.hidden;
  }

  private openComposer(): void {
    const draft = this.draft;
    if (!draft) return;
    const head = draft.headingPath.join(' › ');
    this.target.textContent = (head ? `${head}  ` : '') + (draft.quote ? `“${cap(draft.quote, 48)}”` : '');
    this.text.value = draft.body;
    this.box.hidden = false;
    this.highlight.hidden = true;
    const anchor = this.resolveByQuote(draft.quote);
    if (anchor) this.showHighlight(anchor);
    this.renderPill();
    this.text.focus();
  }

  private closeComposer(): void {
    this.box.hidden = true;
    this.renderPill();
  }

  private saveComposer(): void {
    const draft = this.draft;
    if (!draft) {
      this.closeComposer();
      return;
    }
    const body = cap(this.text.value.trim(), BODY_MAX);
    if (!body) {
      this.flash('comment is empty');
      return;
    }
    this.pinSeq += 1;
    this.pins.push({
      id: `d-${Date.now()}-${randomHex().slice(0, 6)}`,
      pinNumber: this.pinSeq,
      body,
      quote: draft.quote,
      headingPath: draft.headingPath,
      createdAt: Date.now(),
      sent: false,
      drifted: false,
    });
    this.draft = null;
    this.persist();
    this.closeComposer();
    this.highlight.hidden = true;
    this.maybeDeferredReload();
  }

  private cancelComposer(): void {
    this.draft = null;
    this.persist();
    this.closeComposer();
    this.highlight.hidden = true;
    this.maybeDeferredReload();
  }

  // ── send the unsent batch (idempotent on batchId) ──────────────────────

  private sendBatch(): void {
    if (this.disabled) return;
    const unsent = this.pins.filter((pin) => !pin.sent && !pin.drifted);
    if (unsent.length === 0) {
      this.flash('nothing to send');
      return;
    }
    this.batchId ??= `b-${Date.now()}-${randomHex()}`;
    this.persist();
    const payload = {
      batchId: this.batchId,
      comments: unsent.map((pin) => ({
        id: pin.id,
        pinNumber: pin.pinNumber,
        body: pin.body,
        quote: pin.quote,
        headingPath: pin.headingPath,
        createdAt: pin.createdAt,
      })),
    };
    this.flash('sending…');
    postJson<unknown>(this.feedUrl, payload).then(
      () => {
        for (const pin of unsent) pin.sent = true;
        this.batchId = null;
        this.persist();
        this.flash(`queued ${payload.comments.length} ✓`);
      },
      (error: unknown) => {
        if (!(error instanceof HttpError)) this.flash('offline — press s to retry');
        else if (error.status === 409) this.flash('no active lane — open one in this harness');
        else if (error.status === 404) {
          this.disabled = true;
          this.flash('doc no longer available');
        } else if (error.status === 413) this.flash('too large — trim a comment');
        else if (error.status === 503) this.flash('queued — retrying, press s');
        else this.flash(`send failed (${error.status})`);
      },
    );
  }

  private cyclePins(direction: number): void {
    if (this.pins.length === 0) return;
    this.cycleIdx = (this.cycleIdx + direction + this.pins.length) % this.pins.length;
    const pin = this.pins[this.cycleIdx];
    const anchor = this.resolveByQuote(pin.quote);
    if (anchor) {
      anchor.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      this.flashHighlight(anchor);
    }
    this.flash(`pin #${pin.pinNumber}: ${cap(pin.body, 40)}`);
  }

  // ── pills ──────────────────────────────────────────────────────────────

  private flash(message: string): void {
    this.flashMsg = message;
    this.renderPill();
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashMsg = null;
      this.renderPill();
    }, FLASH_MS);
  }

  private renderPill(): void {
    const unsent = this.pins.filter((pin) => !pin.sent).length;
    const drifted = this.pins.filter((pin) => pin.drifted).length;
    let main: string;
    let sub: string;
    if (this.disabled) {
      main = '✦ doc no longer available';
      sub = 'the file or harness is gone';
    } else if (this.armed) {
      main = '✦ click a passage';
      sub = 'esc to cancel';
    } else {
      main = `✦ doc comments (${this.pins.length})`;
      const bits = ['c add'];
      if (unsent > 0) bits.push(`s send ${unsent}`);
      if (this.pins.length > 0) bits.push('j/k cycle');
      sub = bits.join(' · ');
    }
    if (this.flashMsg) sub = this.flashMsg;
    else if (drifted > 0) sub += ` · ${drifted} drifted`;
    this.commentPill.disabled = this.disabled;
    setChildren(this.commentPill, [
      el('b', { class: 'lb-feedback__main', text: main }),
      el('span', { class: 'lb-feedback__sub', text: sub }),
    ]);
  }

  private setArtifact(state: ArtifactState, detail: string): void {
    this.artifactState = state;
    window.clearTimeout(this.artifactTimer);
    this.artifactPill.dataset.state = state;
    const label = state === 'queued' ? 'queued' : state === 'sending' ? 'sending…' : state === 'error' ? 'retry' : 'artifact';
    setChildren(this.artifactPill, [
      el('b', { class: 'lb-feedback__main', text: label }),
      el('span', { class: 'lb-feedback__sub', text: detail }),
    ]);
  }

  private requestArtifact(): void {
    if (this.artifactState === 'sending' || this.artifactState === 'queued') return;
    this.artifactBatch ??= `da-${Date.now()}-${randomHex()}`;
    this.setArtifact('sending', this.artifactTitle);
    postJson<unknown>(this.artifactUrl, { batchId: this.artifactBatch, title: this.artifactTitle }).then(
      () => {
        this.artifactBatch = null;
        this.setArtifact('queued', 'active lane will create it');
        this.artifactTimer = window.setTimeout(() => this.setArtifact('ready', 'press a'), FLASH_MS);
      },
      (error: unknown) => {
        if (!(error instanceof HttpError)) this.setArtifact('error', 'press a to retry');
        else if (error.status === 409) this.setArtifact('error', 'no active lane');
        else if (error.status === 404) this.setArtifact('error', 'doc unavailable');
        else if (error.status === 413) this.setArtifact('error', 'title too long');
        else if (error.status === 503) this.setArtifact('error', 'press a to retry');
        else this.setArtifact('error', `failed ${error.status}`);
      },
    );
  }

  // ── live reload ────────────────────────────────────────────────────────

  private async loadState(signal: AbortSignal): Promise<{ hash?: string } | null> {
    if (this.disabled) return null;
    try {
      return await fetchJson<{ hash?: string }>(this.stateUrl, { signal });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 404) {
        this.disabled = true;
        this.renderPill();
        this.poller.dispose();
      }
      return null;
    }
  }

  private onState(state: { hash?: string } | null): void {
    if (!state?.hash) return;
    if (this.lastHash === null) {
      this.lastHash = state.hash;
      return;
    }
    if (state.hash === this.lastHash) return;
    this.lastHash = state.hash;
    this.pendingReload = true;
    this.maybeDeferredReload();
  }

  /** Reload once the hash moved, but never under the picker or the composer. */
  private maybeDeferredReload(): void {
    if (!this.pendingReload || this.armed || this.composerOpen()) return;
    (this.options.reload ?? (() => location.reload()))();
  }
}
