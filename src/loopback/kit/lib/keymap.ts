// Spec 341 — one keyboard dispatcher per loopback page.
//
// Every page used to carry its own `keydown` handler with its own idea of
// "ignore while typing". The shell, the switcher, the help overlay and each
// surface now register bindings here instead, which is also how `?` can list
// every key the page answers to.
//
// Dispatch runs newest binding first, so an overlay registered after the page
// wins while it is open (its bindings carry a `when` gate). Two ungated
// bindings for the same chord are a bug: `bind()` throws.

import type { Disposer } from '../../../ui/component';

export interface KeyBinding {
  /** `KeyboardEvent.key` value(s), e.g. `'j'`, `['ArrowDown', 'j']`, `'?'`. */
  readonly key?: string | readonly string[];
  /** `KeyboardEvent.code` instead — layout-independent (`'Backquote'`). */
  readonly code?: string;
  /** Require Ctrl or Meta. Without it the binding never fires while Ctrl/Meta/Alt is held. */
  readonly mod?: boolean;
  /** Require Shift held (`true`) or released (`false`). Default: ignored, `key` already carries it. */
  readonly shift?: boolean;
  /** Help text. A binding without a label is not listed by `?`. */
  readonly label?: string;
  /** Help column for the key, when the default (`key` joined by ` / `) reads badly. */
  readonly display?: string;
  /** Help group. Default `'Page'`. */
  readonly group?: string;
  /** Also fire while focus is in an input, textarea, select or contenteditable. */
  readonly inInput?: boolean;
  /** Extra gate, read at dispatch time. */
  readonly when?: () => boolean;
  /** Belongs to an overlay: stays live while a modal is open (every other binding pauses). */
  readonly modal?: boolean;
  /** Return `false` to decline, letting older bindings and the fallback see the event. */
  run(event: KeyboardEvent): void | boolean;
}

export interface HelpEntry {
  readonly group: string;
  readonly keys: string;
  readonly label: string;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowDown: '↓',
  ArrowUp: '↑',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  ' ': 'Space',
  Backquote: '`',
};

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[contenteditable=""], [contenteditable="true"]')) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

function keysOf(binding: KeyBinding): readonly string[] {
  if (binding.key === undefined) return [];
  return typeof binding.key === 'string' ? [binding.key] : binding.key;
}

function chordIds(binding: KeyBinding): string[] {
  const suffix = `|${binding.mod ? 'mod' : ''}|${binding.shift === undefined ? '' : String(binding.shift)}`;
  const ids = keysOf(binding).map((key) => `key:${key}${suffix}`);
  if (binding.code) ids.push(`code:${binding.code}${suffix}`);
  return ids;
}

function matches(binding: KeyBinding, event: KeyboardEvent): boolean {
  const mod = event.ctrlKey || event.metaKey;
  if (binding.mod ? !mod : mod || event.altKey) return false;
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false;
  if (binding.code !== undefined && binding.code === event.code) return true;
  return keysOf(binding).includes(event.key);
}

export class Keymap {
  private readonly bindings: KeyBinding[] = [];
  private fallback: ((event: KeyboardEvent) => void | boolean) | null = null;
  private readonly modals = new Set<() => boolean>();
  private readonly listener = (event: KeyboardEvent): void => this.dispatch(event);

  constructor(private readonly target: EventTarget = window) {
    this.target.addEventListener('keydown', this.listener as EventListener, { capture: true });
  }

  bind(binding: KeyBinding): Disposer {
    if (keysOf(binding).length === 0 && binding.code === undefined) {
      throw new Error('[keymap] a binding needs a key or a code');
    }
    if (!binding.when) {
      const ids = new Set(chordIds(binding));
      const clash = this.bindings.find((other) => !other.when && chordIds(other).some((id) => ids.has(id)));
      if (clash) {
        throw new Error(
          `[keymap] duplicate binding for ${[...ids].join(', ')} (${clash.label ?? 'unlabelled'} vs ${binding.label ?? 'unlabelled'})`,
        );
      }
    }
    this.bindings.push(binding);
    return () => {
      const index = this.bindings.indexOf(binding);
      if (index >= 0) this.bindings.splice(index, 1);
    };
  }

  bindAll(bindings: readonly KeyBinding[]): Disposer {
    const disposers = bindings.map((binding) => this.bind(binding));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  /** Runs after every binding declined — e.g. the docs index's type-to-filter. */
  setFallback(handler: (event: KeyboardEvent) => void | boolean): Disposer {
    this.fallback = handler;
    return () => {
      if (this.fallback === handler) this.fallback = null;
    };
  }

  /** Every labelled binding whose gate is open, oldest first (shell before page). */
  help(): HelpEntry[] {
    const out: HelpEntry[] = [];
    const seen = new Set<string>();
    for (const binding of this.bindings) {
      if (!binding.label) continue;
      if (binding.when && !binding.when()) continue;
      const keys =
        binding.display ??
        [...keysOf(binding), ...(binding.code ? [binding.code] : [])]
          .map((key) => KEY_NAMES[key] ?? key)
          .join(' / ');
      const entry = { group: binding.group ?? 'Page', keys: binding.mod ? `⌘/Ctrl+${keys}` : keys, label: binding.label };
      const id = `${entry.group}\u0000${entry.keys}\u0000${entry.label}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
    return out;
  }

  /** Register an overlay; while `isOpen()`, only `modal` bindings fire. */
  addModal(isOpen: () => boolean): Disposer {
    this.modals.add(isOpen);
    return () => this.modals.delete(isOpen);
  }

  dispatch(event: KeyboardEvent): void {
    if (event.isComposing || event.defaultPrevented) return;
    const editable = isEditableTarget(event.target);
    const modalOpen = [...this.modals].some((isOpen) => isOpen());
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const binding = this.bindings[i];
      if (modalOpen && !binding.modal) continue;
      if (editable && !binding.inInput) continue;
      if (!matches(binding, event)) continue;
      if (binding.when && !binding.when()) continue;
      if (binding.run(event) === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.fallback && !modalOpen && !editable && this.fallback(event) !== false) {
      event.preventDefault();
    }
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.listener as EventListener, { capture: true });
    this.bindings.length = 0;
    this.fallback = null;
    this.modals.clear();
  }
}

let pageKeymap: Keymap | null = null;

/** The page's dispatcher, created on first use. */
export function keymap(): Keymap {
  pageKeymap ??= new Keymap(window);
  return pageKeymap;
}
