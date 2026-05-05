// Global copy-on-select: when the user finishes a mouse or keyboard text
// selection anywhere in the app, copy the selected text to the clipboard.
//
// Skips selections that originate inside an editable element so normal
// text-editing semantics in <input>, <textarea>, and contenteditable surfaces
// are preserved. Terminal panes are unaffected because xterm.js renders into
// a canvas — its selection is not part of the DOM Selection API — so the
// existing terminal-side wireCopyOnSelect (src/compositor.ts) keeps handling
// them. See docs/81-global-copy-on-select.md.

export interface CopyOnSelectOptions {
  /** Minimum selection length in characters required to copy. Default 1. */
  minLength?: number;
  /** Optional callback fired after a successful clipboard write. */
  onCopy?: (text: string) => void;
}

const NAVIGATION_KEYS = new Set([
  'Shift',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

function isEditableSelection(selection: Selection): boolean {
  const node = selection.anchorNode;
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return false;
  return el.closest(EDITABLE_SELECTOR) !== null;
}

export function installGlobalCopyOnSelect(opts: CopyOnSelectOptions = {}): () => void {
  const minLength = opts.minLength ?? 1;

  const tryCopy = (): void => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString();
    if (text.length < minLength) return;
    if (isEditableSelection(selection)) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        opts.onCopy?.(text);
      })
      .catch((err: unknown) => {
        console.warn('[copy-on-select] clipboard write failed:', err);
      });
  };

  const onMouseUp = (): void => {
    // Defer to next microtask: in some browsers selection is finalized
    // immediately after mouseup but reading inside the same task is safe.
    tryCopy();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (!NAVIGATION_KEYS.has(e.key)) return;
    tryCopy();
  };

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keyup', onKeyUp, true);

  return () => {
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('keyup', onKeyUp, true);
  };
}
