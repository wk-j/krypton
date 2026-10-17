// Spec 309 — the generative UI panel.
//
// A kernel `Component`: the whole spec is re-evaluated on every input, but the
// repaint is not re-rendered — `renderChildren()` reconciles by node key and
// each catalog component's `readDeps()` is its own evaluated props, so an
// untouched subtree early-returns. That is what replaces the flat
// `bindings: Array<() => void>` this panel used to re-run on every keystroke.
//
// Interactive state is owned by the caller (the harness view's LRU), not here:
// `state` holds the declared inputs, `views` the per-node view state. Both are
// mutated in place so a reopen of the same fence resumes where it left off.

import './genui-panel.css';
import './genui-panel.scheme.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList } from '../../../ui/list';
import { evaluate } from '../../genui/evaluate';
import type { UiAction, UiFenceEntry, UiState, UiStateValue } from '../../genui/types';
import { toStateValue } from '../../genui/types';
import { renderChildren } from '../genui-catalog';
import type { GenUiContext } from '../genui-catalog';
import { FOCUSABLE_ATTR } from '../genui-catalog/renderer';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';

/** Per-node view state, retained beside the inputs for as long as the panel entry lives. */
export type GenUiViews = Map<string, Record<string, unknown>>;

/**
 * One entry of the view's panel-state LRU: the declared inputs and the
 * per-node view state, evicted together with the fence they belong to.
 */
export interface GenUiPanelState {
  readonly state: UiState;
  readonly views: GenUiViews;
}

export interface GenUiPanelProps {
  readonly open: boolean;
  readonly entry: UiFenceEntry | null;
  /** The declared inputs. Mutated in place; the caller retains it. */
  readonly state: UiState;
  readonly views: GenUiViews;
  /** Loads the composer draft. Returns a refusal reason, or `null` on success. */
  onDraft(text: string): string | null;
  /** Opens an `http(s)` url through the host's `open_url`. */
  onOpenUrl(url: string): void;
  /** Focus goes back to the composer. */
  onClose(): void;
}

const NO_STATE: UiState = {};

export class GenUiPanel extends Component<GenUiPanelProps> {
  private readonly shell: OverlayShell;
  /** Carries `acp-genui` too: catalog sheets scope their shared rules to that block. */
  private readonly content = el('div', { class: 'acp-genui-panel__body acp-genui' });
  private readonly feedback = el('div', { class: 'acp-genui-panel__feedback', attrs: { role: 'status' } });
  private readonly source = el('pre', { class: 'acp-genui-panel__source' });
  private readonly sourceButton = el('button', {
    class: 'acp-genui-panel__button',
    text: 'Source',
    attrs: { type: 'button', [FOCUSABLE_ATTR]: '' },
  });
  private readonly closeButton = el('button', {
    class: 'acp-genui-panel__button',
    text: 'Close',
    attrs: { type: 'button', [FOCUSABLE_ATTR]: '' },
  });
  private readonly main = el('div', { class: 'acp-genui-panel__main' });
  private readonly ctx: GenUiContext;
  private props: GenUiPanelProps | null = null;
  private visibilityObserver: MutationObserver | null = null;
  private focusIndex = 0;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.source.hidden = true;
    this.main.append(
      this.content,
      this.feedback,
      this.source,
      el('div', { class: 'acp-genui-panel__actions' }, this.sourceButton, this.closeButton),
    );
    this.bag.listen(this.sourceButton, 'click', () => {
      this.source.hidden = !this.source.hidden;
      this.sourceButton.textContent = this.source.hidden ? 'Source' : 'Hide source';
    });
    this.bag.listen(this.closeButton, 'click', () => this.close());
    const readState = (): UiState => this.props?.state ?? NO_STATE;
    this.ctx = {
      run: (actions: readonly UiAction[]): void => this.run(actions),
      setInput: (name: string, value: UiStateValue): void => this.setInput(name, value),
      get state(): UiState { return readState(); },
      view: (key: string): Record<string, unknown> => this.viewOf(key),
      repaint: (): void => this.render(),
    };
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  update(next: GenUiPanelProps): void {
    this.props = next;
    super.update(next);
  }

  close(restoreFocus = true): void {
    const props = this.props;
    if (!this.isOpen || props === null) return;
    this.update({ ...props, open: false });
    if (restoreFocus) props.onClose();
  }

  /**
   * Every key while the panel is open. `Escape` closes, `Tab` rides the roving
   * tabindex, and a key aimed at a native control inside the panel is left to
   * the browser so arrows, Space and Enter still work; everything else is
   * swallowed so the composer never sees it.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      this.moveFocus(event.shiftKey ? -1 : 1);
      return true;
    }
    if (this.el.contains(event.target as Node)) return false;
    event.preventDefault();
    return true;
  }

  protected readDeps(next: GenUiPanelProps): readonly unknown[] {
    return [next.open, next.entry, next.state, next.views];
  }

  protected syncClasses(): void {
    // The shell owns every class on the root; the panel's own nodes are static.
  }

  protected paint(next: GenUiPanelProps): void {
    const entry = next.entry;
    if (!next.open || entry === null) {
      this.release();
      this.shell.update({ open: false, name: 'genui-panel', block: 'acp-genui-panel', title: '', body: this.main });
      return;
    }
    this.feedback.textContent = '';
    this.source.textContent = entry.source;
    this.source.hidden = true;
    this.sourceButton.textContent = 'Source';
    this.render();
    this.shell.update({
      open: true,
      name: 'genui-panel',
      block: 'acp-genui-panel',
      title: entry.title,
      sub: `${entry.summary} · Tab moves between controls · Esc closes`,
      body: this.main,
      panelAttrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': entry.title },
      // Another shell took the single open slot: the mounted tree is gone, so
      // the next identical `update()` must paint instead of comparing equal.
      onAutoClose: () => { this.release(); this.invalidateDeps(); },
    });
    this.watchVisibility();
    this.focusIndex = 0;
    const focusables = this.focusables();
    this.syncFocusRing(focusables);
    (focusables[0] ?? this.sourceButton).focus();
  }

  protected onDispose(): void {
    this.release();
    this.shell.dispose();
  }

  /** Evaluate the spec against the current inputs and patch the mounted tree. */
  private render(): void {
    const entry = this.props?.entry;
    const state = this.props?.state;
    if (entry == null || state === undefined) return;
    const { roots, diagnostics } = evaluate(entry.program, state);
    renderChildren(this.content, roots, this.ctx);
    const failure = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    this.feedback.textContent = failure === undefined ? '' : `line ${failure.line}: ${failure.message}`;
    this.syncFocusRing(this.focusables());
  }

  private run(actions: readonly UiAction[]): void {
    for (const action of actions) {
      if (action.type === 'draft') this.loadDraft(action.text ?? '');
      else if (action.type === 'set') {
        if (action.name !== undefined) this.setInput(action.name, toStateValue(action.value ?? null) ?? null);
      } else if (action.type === 'copy') this.copy(action.text ?? '');
      else this.openUrl(action.text ?? '');
    }
  }

  private loadDraft(text: string): void {
    const props = this.props;
    if (props === null) return;
    const reason = props.onDraft(text);
    this.feedback.textContent = reason ?? '';
    if (reason === null) this.close();
  }

  private copy(text: string): void {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      this.feedback.textContent = 'clipboard unavailable';
      return;
    }
    void clipboard.writeText(text).then(
      () => { this.feedback.textContent = 'copied'; },
      () => { this.feedback.textContent = 'copy failed'; },
    );
  }

  /** Like the visual-fence link rule: a link opens only from the focused panel. */
  private openUrl(url: string): void {
    if (!this.el.contains(document.activeElement)) return;
    if (!/^https?:\/\//i.test(url)) {
      this.feedback.textContent = 'only http(s) links open';
      return;
    }
    this.props?.onOpenUrl(url);
  }

  private setInput(name: string, value: UiStateValue): void {
    const props = this.props;
    if (props === null) return;
    props.state[name] = value;
    this.render();
  }

  private viewOf(key: string): Record<string, unknown> {
    const views = this.props?.views;
    if (views === undefined) return {};
    const existing = views.get(key);
    if (existing !== undefined) return existing;
    const created: Record<string, unknown> = {};
    views.set(key, created);
    return created;
  }

  private focusables(): readonly HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>(`[${FOCUSABLE_ATTR}]`)];
  }

  /** Roving tabindex: one stop in the browser's ring, the rest reachable by Tab here. */
  private syncFocusRing(focusables: readonly HTMLElement[]): void {
    if (focusables.length === 0) return;
    this.focusIndex = Math.min(this.focusIndex, focusables.length - 1);
    for (let i = 0; i < focusables.length; i++) focusables[i].tabIndex = i === this.focusIndex ? 0 : -1;
  }

  private moveFocus(delta: number): void {
    const focusables = this.focusables();
    if (focusables.length === 0) return;
    const current = focusables.indexOf(document.activeElement as HTMLElement);
    const from = current === -1 ? this.focusIndex : current;
    this.focusIndex = (from + delta + focusables.length) % focusables.length;
    this.syncFocusRing(focusables);
    focusables[this.focusIndex].focus();
  }

  /** A hidden tab or window closes the panel without stealing focus back. */
  private watchVisibility(): void {
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    const tab = this.el.closest<HTMLElement>('.krypton-tab-wrapper');
    const windowEl = this.el.closest<HTMLElement>('.krypton-window');
    if (!tab && !windowEl) return;
    this.visibilityObserver = new MutationObserver(() => {
      if (tab?.classList.contains('krypton-tab-wrapper--hidden') || windowEl?.style.display === 'none') this.close(false);
    });
    if (tab) this.visibilityObserver.observe(tab, { attributes: true, attributeFilter: ['class'] });
    if (windowEl) this.visibilityObserver.observe(windowEl, { attributes: true, attributeFilter: ['style'] });
  }

  private release(): void {
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    disposeList(this.content);
    this.source.textContent = '';
    this.feedback.textContent = '';
  }
}

export const def: ComponentDef = { id: 'genui-panel', blocks: ['acp-genui-panel', 'acp-harness__genui-panel-overlay'] };
