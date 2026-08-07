// Krypton — Quick Overview Dialog
//
// One global modal whose only job is to render a pluggable `OverviewSource`.
// The dialog owns the shell, scrolling, keyboard handling, lifecycle, and
// cancellation; a source owns the title, the body, and any extra actions.
// Read-only by design: editing is an explicit escalation through a source
// action (a file source maps Enter to "open in Helix").
//
// See docs/210-quick-overview-dialog.md.

import hljs from 'highlight.js';
// Every other hljs stylesheet import lives in a lazily-imported view, so a peek
// opened before any of those views would render uncoloured markup. This module
// is eagerly loaded from main.ts, so import the theme here.
import 'highlight.js/styles/github-dark.css';

import type { Compositor } from './compositor';
import { previewMarked } from './file-preview';

// ─── Source contract ──────────────────────────────────────────────

/** What the dialog renders. A source is loaded once per open. */
export interface OverviewSource {
  /** Header text, rendered verbatim — paths keep their real casing. */
  readonly title: string;
  /** Right-aligned header meta, e.g. 'typescript · 21.4K · 745 lines'. */
  readonly meta?: string;
  /** Produce the body. Rejections render as an error notice, never a crash. */
  load(signal: AbortSignal): Promise<OverviewBody>;
  /** Source keys, dispatched before the built-ins and listed in the footer. */
  readonly actions?: OverviewAction[];
}

export type OverviewBody =
  | { kind: 'code'; text: string; lang: string | null; truncated?: boolean }
  | { kind: 'markdown'; text: string; basePath: string }
  | { kind: 'notice'; text: string }
  | { kind: 'element'; el: HTMLElement };

export interface OverviewAction {
  /** Single lowercase character, or 'Enter'. */
  readonly key: string;
  /** Footer label, lowercase. */
  readonly label: string;
  run(): void | Promise<void>;
  /** Close the dialog after `run()`. Default true. */
  readonly closes?: boolean;
}

/** Built-in footer hints, always shown after the source's own actions. */
const BUILTIN_HINTS: Array<[string, string]> = [
  ['esc', 'close'],
  ['j/k', 'scroll'],
  ['^d/^u', 'half page'],
  ['g/G', 'top/bottom'],
];

const FALLBACK_LINE_HEIGHT = 18;

export class QuickOverview {
  private compositor: Compositor;
  private onCloseCallback: () => void;

  private overlay: HTMLElement;
  private titleEl: HTMLElement;
  private metaEl: HTMLElement;
  private bodyEl: HTMLElement;
  private footerEl: HTMLElement;

  private visible = false;
  private source: OverviewSource | null = null;
  private abort: AbortController | null = null;

  constructor(compositor: Compositor, onClose: () => void) {
    this.compositor = compositor;
    this.onCloseCallback = onClose;

    this.overlay = this.buildDom();
    this.titleEl = this.overlay.querySelector('.krypton-overview__title')!;
    this.metaEl = this.overlay.querySelector('.krypton-overview__meta')!;
    this.bodyEl = this.overlay.querySelector('.krypton-overview__body')!;
    this.footerEl = this.overlay.querySelector('.krypton-overview__footer')!;

    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    document.body.appendChild(this.overlay);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Show the dialog immediately in a loading state, then render `source`
   * once it resolves. Opening while already open replaces the content.
   */
  open(source: OverviewSource): void {
    this.abort?.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.source = source;
    this.titleEl.textContent = source.title;
    this.metaEl.textContent = source.meta ?? '';
    this.renderFooter();
    this.renderNotice('loading…');

    if (!this.visible) {
      this.visible = true;
      this.overlay.classList.add('krypton-overview--visible');
      this.compositor.soundEngine.play('command_palette.open');
    }

    source
      .load(signal)
      .then((body) => {
        if (signal.aborted || this.source !== source) return;
        // `meta` is typically only known after load (language, size, lines).
        this.metaEl.textContent = source.meta ?? '';
        this.renderBody(body);
      })
      .catch((err: unknown) => {
        if (signal.aborted || this.source !== source) return;
        console.error('[QuickOverview] source load failed:', err);
        this.metaEl.textContent = source.meta ?? '';
        this.renderNotice(err instanceof Error ? err.message : String(err));
      });
  }

  close(): void {
    if (!this.visible) return;
    this.abort?.abort();
    this.abort = null;
    this.visible = false;
    this.source = null;
    this.overlay.classList.remove('krypton-overview--visible');
    // Drop the rendered content so a large peek does not sit in the DOM.
    this.bodyEl.replaceChildren();
    this.footerEl.replaceChildren();
    this.compositor.soundEngine.play('command_palette.close');
    this.onCloseCallback();
  }

  /** Returns true when the key was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible) return false;

    if (e.key === 'Escape') {
      this.close();
      return true;
    }

    // Source actions win over the built-ins so a source can override `y`.
    const key = e.key === 'Enter' ? 'Enter' : e.key.toLowerCase();
    const action = this.source?.actions?.find((a) => a.key === key);
    if (action && !e.metaKey && !e.ctrlKey) {
      void Promise.resolve(action.run()).catch((err: unknown) => {
        console.error(`[QuickOverview] action "${action.key}" failed:`, err);
      });
      if (action.closes !== false) this.close();
      return true;
    }

    const line = this.lineHeight();
    const page = Math.max(line, this.bodyEl.clientHeight / 2);

    if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
      this.bodyEl.scrollTop += page;
      return true;
    }
    if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
      this.bodyEl.scrollTop -= page;
      return true;
    }
    if (e.metaKey || e.ctrlKey) return false;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        this.bodyEl.scrollTop += line;
        return true;
      case 'k':
      case 'ArrowUp':
        this.bodyEl.scrollTop -= line;
        return true;
      case 'g':
      case 'Home':
        this.bodyEl.scrollTop = 0;
        return true;
      case 'G':
      case 'End':
        this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
        return true;
      case 'PageDown':
        this.bodyEl.scrollTop += this.bodyEl.clientHeight;
        return true;
      case 'PageUp':
        this.bodyEl.scrollTop -= this.bodyEl.clientHeight;
        return true;
      case 'y':
        void navigator.clipboard.writeText(this.source?.title ?? '').catch(() => {
          /* clipboard denied — nothing else to do */
        });
        return true;
      default:
        // Swallow bare printable keys so they never leak to the PTY behind us.
        return e.key.length === 1;
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────

  private buildDom(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'krypton-overview';
    overlay.innerHTML = `
      <div class="krypton-overview__panel">
        <div class="krypton-overview__head">
          <span class="krypton-overview__title"></span>
          <span class="krypton-overview__meta"></span>
        </div>
        <div class="krypton-overview__body"></div>
        <div class="krypton-overview__footer"></div>
      </div>
    `;
    return overlay;
  }

  private renderFooter(truncated = false): void {
    this.footerEl.replaceChildren();

    const hints: Array<[string, string, boolean]> = [];
    for (const [key, label] of BUILTIN_HINTS) hints.push([key, label, false]);
    for (const action of this.source?.actions ?? []) {
      hints.push([action.key === 'Enter' ? '⏎' : action.key, action.label, true]);
    }

    for (const [key, label, primary] of hints) {
      const span = document.createElement('span');
      if (primary) span.className = 'krypton-overview__key--primary';
      const b = document.createElement('b');
      b.textContent = key;
      span.append(b, ` ${label}`);
      this.footerEl.appendChild(span);
    }

    if (truncated) {
      const span = document.createElement('span');
      span.className = 'krypton-overview__truncated';
      span.textContent = `truncated`;
      this.footerEl.appendChild(span);
    }
  }

  private renderBody(body: OverviewBody): void {
    this.bodyEl.replaceChildren();
    this.bodyEl.scrollTop = 0;
    this.bodyEl.dataset.kind = body.kind;

    switch (body.kind) {
      case 'code':
        this.bodyEl.appendChild(this.buildCode(body.text, body.lang));
        this.renderFooter(body.truncated === true);
        break;

      case 'markdown': {
        const div = document.createElement('div');
        div.className = 'krypton-overview__markdown';
        div.innerHTML = previewMarked.parse(body.text, { gfm: true, breaks: true }) as string;
        for (const img of div.querySelectorAll('img')) {
          (img as HTMLElement).style.maxWidth = '100%';
        }
        this.bodyEl.appendChild(div);
        break;
      }

      case 'notice':
        this.renderNotice(body.text);
        break;

      case 'element':
        this.bodyEl.appendChild(body.el);
        break;
    }
  }

  /**
   * Code body: a sticky line-number gutter beside the highlighted source,
   * both inside the single scroll container so they can never desync.
   * Unknown languages are rendered as plain text rather than paying for
   * highlightAuto() on up to 64 kb.
   */
  private buildCode(text: string, lang: string | null): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'krypton-overview__code-wrap';

    const lines = text.split('\n');
    const gutter = document.createElement('pre');
    gutter.className = 'krypton-overview__gutter';
    gutter.setAttribute('aria-hidden', 'true');
    gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n');

    const code = document.createElement('pre');
    code.className = 'krypton-overview__code';
    if (lang && hljs.getLanguage(lang)) {
      try {
        code.innerHTML = hljs.highlight(text, { language: lang }).value;
      } catch {
        code.textContent = text;
      }
    } else {
      code.textContent = text;
    }

    wrap.append(gutter, code);
    return wrap;
  }

  private renderNotice(text: string): void {
    this.bodyEl.replaceChildren();
    this.bodyEl.dataset.kind = 'notice';
    const span = document.createElement('span');
    span.className = 'krypton-overview__notice';
    span.textContent = text;
    this.bodyEl.appendChild(span);
  }

  private lineHeight(): number {
    const target = this.bodyEl.firstElementChild ?? this.bodyEl;
    const parsed = parseFloat(getComputedStyle(target).lineHeight);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_LINE_HEIGHT;
  }
}
