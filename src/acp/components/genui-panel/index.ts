// Spec 309 — the generative UI panel; spec 310 — hosted inline.
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
//
// Spec 310 replaced the `OverlayShell` host with this plain inline block: the
// view moves this one node into the slot of the card that owns it, so the
// panel expands in the sealed row instead of covering the dashboard. The node
// is moved, never rebuilt — a transcript repaint detaches it and the view
// re-appends the same element, which is what keeps focus and scroll position.

import './genui-panel.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList } from '../../../ui/list';
import { evaluate } from '../../genui/evaluate';
import type { UiAction, UiFenceEntry, UiNode, UiState, UiStateValue } from '../../genui/types';
import { toStateValue } from '../../genui/types';
import { renderChildren } from '../genui-catalog';
import type { GenUiContext } from '../genui-catalog';
import { FOCUSABLE_ATTR, asNodes } from '../genui-catalog/renderer';
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
  /**
   * Whether opening moves focus into the panel. True for a panel the user
   * asked for; false for one that expanded on its own when the row sealed
   * (spec 310 rev 2) — the composer keeps the keyboard until the user enters
   * the panel.
   */
  readonly takeFocus: boolean;
  /** Loads the composer draft. Returns a refusal reason, or `null` on success. */
  onDraft(text: string): string | null;
  /** Opens an `http(s)` url through the host's `open_url`. */
  onOpenUrl(url: string): void;
  /**
   * The panel collapsed: the view detaches this node and drops its open
   * target. `restoreFocus` is false when the collapse was not the user asking
   * for it (row disposed, lane switched, tab hidden) — then the composer must
   * not be yanked back.
   */
  onClose(restoreFocus: boolean): void;
}

const NO_STATE: UiState = {};

export class GenUiPanel extends Component<GenUiPanelProps> {
  /** The card above already names the spec; this line is the key legend. */
  private readonly legend = el('span', {
    class: 'acp-genui-panel__legend',
    text: 'Tab moves between controls · Esc closes',
  });
  /** Carries `acp-genui` too: catalog sheets scope their shared rules to that block. */
  private readonly content = el('div', { class: 'acp-genui-panel__body acp-genui' });
  private readonly feedback = el('div', { class: 'acp-genui-panel__feedback', attrs: { role: 'status' } });
  private readonly source = el('pre', { class: 'acp-genui-panel__source' });
  /** The ```svg fence card's toggle, same control in the same place: a quiet
   *  bar button at the right of the head. There is no Close button — the card
   *  head above collapses the panel, as does `Escape`. */
  private readonly sourceButton = el('button', {
    class: 'acp-genui-panel__button',
    text: 'Source',
    attrs: { type: 'button', [FOCUSABLE_ATTR]: '' },
  });
  private readonly main = el('div', { class: 'acp-genui-panel__main' });
  private readonly ctx: GenUiContext;
  private props: GenUiPanelProps | null = null;
  private visibilityObserver: MutationObserver | null = null;
  private focusIndex = 0;
  private openState = false;

  constructor() {
    super(el('div', { class: 'acp-genui-panel', attrs: { role: 'group' } }));
    this.el.hidden = true;
    this.source.hidden = true;
    this.main.append(this.content, this.feedback, this.source);
    this.el.append(
      el('div', { class: 'acp-genui-panel__head' }, this.legend, this.sourceButton),
      this.main,
    );
    this.bag.listen(this.sourceButton, 'click', () => {
      this.source.hidden = !this.source.hidden;
      this.sourceButton.textContent = this.source.hidden ? 'Source' : 'Hide source';
    });
    // Entering the panel with the mouse. WebKit does not focus a <button> on
    // click (the macOS convention), so DOM focus alone cannot tell whether the
    // user is in the panel — and since rev 2 a panel can be open without ever
    // having been focused. Claim the control that was pressed: the keyboard
    // follows the pointer, and the roving ring continues from there instead of
    // from wherever Tab last left it.
    this.bag.listen(this.el, 'pointerdown', (event: Event) => {
      const pressed = event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${FOCUSABLE_ATTR}]`)
        : null;
      if (!pressed) return;
      const focusables = this.focusables();
      const index = focusables.indexOf(pressed);
      if (index >= 0) {
        this.focusIndex = index;
        this.syncFocusRing(focusables);
      }
      pressed.focus({ preventScroll: true });
    });
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
    return this.openState;
  }

  /**
   * Whether the panel owns the keyboard. An auto-expanded panel is open but
   * unfocused: the composer keeps every key until the user enters the panel,
   * which clicking a control or re-opening the card does.
   */
  get hasFocus(): boolean {
    return this.el.contains(document.activeElement);
  }

  update(next: GenUiPanelProps): void {
    this.props = next;
    super.update(next);
  }

  close(restoreFocus = true): void {
    const props = this.props;
    if (!this.isOpen || props === null) return;
    this.update({ ...props, open: false });
    props.onClose(restoreFocus);
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
    // Static chrome: the only root state is `hidden`, which `paint` writes.
  }

  protected paint(next: GenUiPanelProps): void {
    const entry = next.entry;
    if (!next.open || entry === null) {
      this.openState = false;
      this.release();
      this.el.hidden = true;
      return;
    }
    this.openState = true;
    this.el.setAttribute('aria-label', entry.title);
    this.feedback.textContent = '';
    this.source.textContent = entry.source;
    this.source.hidden = true;
    this.sourceButton.textContent = 'Source';
    this.el.hidden = false;
    this.render();
    this.watchVisibility();
    this.focusIndex = 0;
    const focusables = this.focusables();
    this.syncFocusRing(focusables);
    // `preventScroll`: the host owns transcript scrolling and does its own
    // bounded reveal right after this (spec 310 — the card head never leaves
    // the viewport). The browser's focus-scroll is unbounded, and it lands
    // inside the host's programmatic-scroll suppression window, so it would
    // move the lane body without the host ever recording where.
    if (next.takeFocus) (focusables[0] ?? this.sourceButton).focus({ preventScroll: true });
  }

  protected onDispose(): void {
    this.release();
  }

  /** Evaluate the spec against the current inputs and patch the mounted tree. */
  private render(): void {
    const entry = this.props?.entry;
    const state = this.props?.state;
    if (entry == null || state === undefined) return;
    const { roots, diagnostics } = evaluate(entry.program, state);
    renderChildren(this.content, this.unframe(roots, entry.title), this.ctx);
    const failure = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    this.feedback.textContent = failure === undefined ? '' : `line ${failure.line}: ${failure.message}`;
    this.syncFocusRing(this.focusables());
  }

  /**
   * Spec 310 §UI: the card head above already prints the outermost `Card`'s
   * title, so painting that root's own box nests a second frame under a
   * repeated heading — "two headings for one thing", plus a border inside a
   * border. Its children take its place; later roots are untouched.
   *
   * Only when the head is showing THIS title: a computed title, or a fence
   * whose first root is not a `Card`, keeps its box, because dropping it would
   * drop a heading nothing else prints. Child keys are node paths, so the
   * unwrapped children reconcile across re-evaluation like any other subtree.
   */
  private unframe(roots: readonly UiNode[], title: string): readonly UiNode[] {
    const first = roots[0];
    if (first === undefined || first.component !== 'Card') return roots;
    if (first.props.title !== title) return roots;
    const children = asNodes(first.props.children);
    if (children.length === 0) return roots;
    return roots.length === 1 ? children : [...children, ...roots.slice(1)];
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

  /** Content first, the head's Source toggle last: the ring order is what
   *  `paint()` focuses on open, and that must be the spec's first control,
   *  not the chrome that happens to sit above it in the DOM. */
  private focusables(): readonly HTMLElement[] {
    return [...this.content.querySelectorAll<HTMLElement>(`[${FOCUSABLE_ATTR}]`), this.sourceButton];
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

export const def: ComponentDef = { id: 'genui-panel', blocks: ['acp-genui-panel'] };
