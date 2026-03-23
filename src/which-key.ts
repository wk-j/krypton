// Krypton — Which-Key Popup
// Helix-style modal popup that shows available keybindings
// when entering a non-Normal mode.

import type { PaneContentType } from './types';
import { Mode } from './types';

/** A single keybinding entry displayed in the popup */
interface KeyEntry {
  key: string;
  label: string;
  /** If set, only show this entry when focused pane matches one of these types.
   *  null in the array means "terminal" (no contentView). */
  contentTypes?: (PaneContentType | null)[];
}

/** Keybindings per mode — compositor keys are content-type-aware */
const COMPOSITOR_KEYS: KeyEntry[] = [
  // ── Window management (always shown) ──
  { key: 'n', label: 'new window' },
  { key: 'x', label: 'close window' },
  { key: 'h', label: 'focus left' },
  { key: 'j', label: 'focus down' },
  { key: 'k', label: 'focus up' },
  { key: 'l', label: 'focus right' },
  { key: '1-9', label: 'focus by index' },
  { key: 'f', label: 'focus layout' },
  { key: 'r', label: 'resize mode' },
  { key: 'm', label: 'move mode' },
  { key: 's', label: 'swap mode' },
  { key: 'z', label: 'maximize' },
  { key: 'p', label: 'pin window' },
  { key: 'H', label: 'hint mode' },

  // ── Tab / pane management (always shown) ──
  { key: 't', label: 'new tab' },
  { key: 'w', label: 'close tab' },
  { key: '[', label: 'prev tab' },
  { key: ']', label: 'next tab' },
  { key: 'T', label: 'move tab' },
  { key: '\\', label: 'split vertical' },
  { key: '-', label: 'split horizontal' },
  { key: 'A-hjkl', label: 'focus pane' },
  { key: 'A-x', label: 'close pane' },

  // ── Terminal-only ──
  { key: 'v', label: 'select mode', contentTypes: [null] },
  { key: 'V', label: 'select lines', contentTypes: [null] },
  { key: 'd', label: 'git diff', contentTypes: [null] },
  { key: 'D', label: 'git diff staged', contentTypes: [null] },
  { key: 'o', label: 'markdown viewer', contentTypes: [null] },
  { key: 'c', label: 'clone SSH tab', contentTypes: [null] },
  { key: 'C', label: 'clone SSH window', contentTypes: [null] },

  // ── Markdown viewer ──
  { key: 'o', label: 'markdown viewer', contentTypes: ['markdown'] },
];

const RESIZE_KEYS: KeyEntry[] = [
  { key: '\u2190', label: 'shrink width' },
  { key: '\u2192', label: 'grow width' },
  { key: '\u2191', label: 'shrink height' },
  { key: '\u2193', label: 'grow height' },
  { key: 'Esc', label: 'done' },
];

const MOVE_KEYS: KeyEntry[] = [
  { key: '\u2190', label: 'move left' },
  { key: '\u2192', label: 'move right' },
  { key: '\u2191', label: 'move up' },
  { key: '\u2193', label: 'move down' },
  { key: 'Esc', label: 'done' },
];

const SWAP_KEYS: KeyEntry[] = [
  { key: 'h/\u2190', label: 'swap left' },
  { key: 'l/\u2192', label: 'swap right' },
  { key: 'k/\u2191', label: 'swap up' },
  { key: 'j/\u2193', label: 'swap down' },
];

const TAB_MOVE_KEYS: KeyEntry[] = [
  { key: '1-9', label: 'move to window N' },
  { key: 'Esc', label: 'cancel' },
];

const HINT_KEYS: KeyEntry[] = [
  { key: 'a-z', label: 'type label' },
  { key: 'Bksp', label: 'undo char' },
  { key: 'Esc', label: 'cancel' },
];

const SELECTION_KEYS: KeyEntry[] = [
  { key: 'h/l', label: 'move left/right' },
  { key: 'j/k', label: 'move down/up' },
  { key: 'w/b', label: 'word fwd/back' },
  { key: 'e', label: 'word end' },
  { key: '0/$', label: 'line start/end' },
  { key: 'gg/G', label: 'buffer top/bottom' },
  { key: 'v', label: 'toggle char select' },
  { key: 'V', label: 'toggle line select' },
  { key: 'y', label: 'yank to clipboard' },
  { key: 'Esc', label: 'exit' },
];

/** Filter key entries by focused pane content type. */
function filterByContentType(entries: KeyEntry[], contentType: PaneContentType | null): KeyEntry[] {
  return entries.filter((e) => {
    if (!e.contentTypes) return true; // no restriction — always show
    return e.contentTypes.includes(contentType);
  });
}

export class WhichKey {
  private overlay: HTMLElement;
  private title: HTMLElement;
  private keyList: HTMLElement;

  constructor() {
    // Overlay backdrop
    this.overlay = document.createElement('div');
    this.overlay.className = 'krypton-whichkey';

    // Popup container
    const popup = document.createElement('div');
    popup.className = 'krypton-whichkey__popup';

    // Title
    this.title = document.createElement('div');
    this.title.className = 'krypton-whichkey__title';

    // Key list
    this.keyList = document.createElement('div');
    this.keyList.className = 'krypton-whichkey__keys';

    popup.appendChild(this.title);
    popup.appendChild(this.keyList);
    this.overlay.appendChild(popup);
    document.body.appendChild(this.overlay);
  }

  /** Update the popup for the given mode and focused content type */
  setMode(mode: Mode, contentType: PaneContentType | null = null): void {
    if (mode === Mode.Normal) {
      this.hide();
      return;
    }

    let entries: KeyEntry[];
    let titleText: string;

    switch (mode) {
      case Mode.Compositor:
        entries = filterByContentType(COMPOSITOR_KEYS, contentType);
        titleText = contentType
          ? `Compositor · ${contentType}`
          : 'Compositor';
        break;
      case Mode.Resize:
        entries = RESIZE_KEYS;
        titleText = 'Resize';
        break;
      case Mode.Move:
        entries = MOVE_KEYS;
        titleText = 'Move';
        break;
      case Mode.Swap:
        entries = SWAP_KEYS;
        titleText = 'Swap';
        break;
      case Mode.Selection:
        entries = SELECTION_KEYS;
        titleText = 'Selection';
        break;
      case Mode.Hint:
        entries = HINT_KEYS;
        titleText = 'Hint';
        break;
      case Mode.TabMove:
        entries = TAB_MOVE_KEYS;
        titleText = 'Move Tab to Window';
        break;
      default:
        this.hide();
        return;
    }

    this.title.textContent = titleText;
    this.keyList.innerHTML = '';

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'krypton-whichkey__entry';

      const key = document.createElement('span');
      key.className = 'krypton-whichkey__key';
      key.textContent = entry.key;

      const label = document.createElement('span');
      label.className = 'krypton-whichkey__label';
      label.textContent = entry.label;

      row.appendChild(key);
      row.appendChild(label);
      this.keyList.appendChild(row);
    }

    this.show();
  }

  private show(): void {
    this.overlay.classList.add('krypton-whichkey--visible');
  }

  private hide(): void {
    this.overlay.classList.remove('krypton-whichkey--visible');
  }
}
