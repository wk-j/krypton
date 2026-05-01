// Krypton — Which-Key Popup
// Helix-style modal popup that shows available keybindings
// when entering a non-Normal mode.

import type { PaneContentType } from './types';
import { Mode } from './types';

/** A single keybinding entry displayed in the popup */
interface KeyEntry {
  key: string;
  label: string;
  effect?: 'important' | 'danger';
  group?: string;
  /** If set, only show this entry when focused pane matches one of these types.
   *  null in the array means "terminal" (no contentView). */
  contentTypes?: (PaneContentType | null)[];
}

function groupEntries(group: string, entries: KeyEntry[]): KeyEntry[] {
  return entries.map((entry) => ({ ...entry, group }));
}

/** Keybindings per mode — compositor keys are content-type-aware */
const COMPOSITOR_KEYS: KeyEntry[] = [
  ...groupEntries('Windows', [
    { key: 'n', label: 'New Window' },
    { key: 'x', label: 'Close Window', effect: 'danger' },
    { key: 'h', label: 'Focus Left' },
    { key: 'j', label: 'Focus Down' },
    { key: 'k', label: 'Focus Up' },
    { key: 'l', label: 'Focus Right' },
    { key: '1-9', label: 'Focus By Index' },
    { key: 'f', label: 'Focus Layout' },
    { key: 'r', label: 'Resize Mode', effect: 'important' },
    { key: 'm', label: 'Move Mode', effect: 'important' },
    { key: 's', label: 'Swap Mode', effect: 'important' },
    { key: 'z', label: 'Maximize', effect: 'important' },
    { key: 'p', label: 'Pin Window' },
  ]),

  ...groupEntries('Tabs / Panes', [
    { key: 't', label: 'New Tab' },
    { key: 'w', label: 'Close Tab', effect: 'danger' },
    { key: '[', label: 'Previous Tab' },
    { key: ']', label: 'Next Tab' },
    { key: 'T', label: 'Move Tab', effect: 'important' },
    { key: '\\', label: 'Split Vertical' },
    { key: '-', label: 'Split Horizontal' },
    { key: 'A-hjkl', label: 'Focus Pane' },
    { key: 'A-x', label: 'Close Pane', effect: 'danger' },
  ]),

  ...groupEntries('Apps', [
    { key: 'b', label: 'File Manager', effect: 'important' },
    { key: 'u', label: 'Vault Viewer', effect: 'important' },
    { key: 'e', label: 'Pencil', effect: 'important' },
    { key: 'q', label: 'Hurl Client', effect: 'important' },
    { key: 'M', label: 'Music Dashboard', effect: 'important' },
    { key: 'P', label: 'Profiler HUD', effect: 'important' },
    { key: 'H', label: 'Hint Mode', effect: 'important' },
  ]),

  ...groupEntries('AI', [
    { key: 'a', label: 'AI Agent', effect: 'important' },
    { key: 'A', label: 'Claude ACP', effect: 'important' },
    { key: 'E', label: 'Gemini ACP', effect: 'important' },
    { key: 'I', label: 'Codex ACP', effect: 'important' },
    { key: 'Y', label: 'ACP Harness', effect: 'important' },
  ]),

  ...groupEntries('Terminal', [
    { key: 'v', label: 'Select Mode', contentTypes: [null] },
    { key: 'V', label: 'Select Lines', contentTypes: [null] },
    { key: 'd', label: 'Git Diff', effect: 'important', contentTypes: [null] },
    { key: 'D', label: 'Git Diff Staged', effect: 'important', contentTypes: [null] },
    { key: 'o', label: 'Markdown Viewer', effect: 'important', contentTypes: [null] },
    { key: 'c', label: 'Clone SSH Tab', contentTypes: [null] },
    { key: 'C', label: 'Clone SSH Window', contentTypes: [null] },
    { key: 'g', label: 'Cycle Shader' },
    { key: 'G', label: 'Toggle Shaders', effect: 'important' },
  ]),

  ...groupEntries('Markdown', [
    { key: 'o', label: 'Markdown Viewer', effect: 'important', contentTypes: ['markdown'] },
  ]),
];

const RESIZE_KEYS: KeyEntry[] = [
  { key: '\u2190', label: 'Shrink Width' },
  { key: '\u2192', label: 'Grow Width' },
  { key: '\u2191', label: 'Shrink Height' },
  { key: '\u2193', label: 'Grow Height' },
  { key: 'Esc', label: 'Done', effect: 'important' },
];

const MOVE_KEYS: KeyEntry[] = [
  { key: '\u2190', label: 'Move Left' },
  { key: '\u2192', label: 'Move Right' },
  { key: '\u2191', label: 'Move Up' },
  { key: '\u2193', label: 'Move Down' },
  { key: 'Esc', label: 'Done', effect: 'important' },
];

const SWAP_KEYS: KeyEntry[] = [
  { key: 'h/\u2190', label: 'Swap Left' },
  { key: 'l/\u2192', label: 'Swap Right' },
  { key: 'k/\u2191', label: 'Swap Up' },
  { key: 'j/\u2193', label: 'Swap Down' },
];

const TAB_MOVE_KEYS: KeyEntry[] = [
  { key: '1-9', label: 'Move To Window N' },
  { key: 'Esc', label: 'Cancel', effect: 'important' },
];

const HINT_KEYS: KeyEntry[] = [
  { key: 'a-z', label: 'Type Label' },
  { key: 'Bksp', label: 'Undo Char' },
  { key: 'Esc', label: 'Cancel', effect: 'important' },
];

const SELECTION_KEYS: KeyEntry[] = [
  { key: 'h/l', label: 'Move Left/Right' },
  { key: 'j/k', label: 'Move Down/Up' },
  { key: 'w/b', label: 'Word Forward/Back' },
  { key: 'e', label: 'Word End' },
  { key: '0/$', label: 'Line Start/End' },
  { key: 'gg/G', label: 'Buffer Top/Bottom' },
  { key: 'v', label: 'Toggle Char Select' },
  { key: 'V', label: 'Toggle Line Select' },
  { key: 'y', label: 'Yank To Clipboard' },
  { key: 'Esc', label: 'Exit', effect: 'important' },
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
  private popup: HTMLElement;
  private title: HTMLElement;
  private keyList: HTMLElement;

  constructor() {
    // Overlay backdrop
    this.overlay = document.createElement('div');
    this.overlay.className = 'krypton-whichkey';

    // Popup container
    this.popup = document.createElement('div');
    this.popup.className = 'krypton-whichkey__popup';

    // Title
    this.title = document.createElement('div');
    this.title.className = 'krypton-whichkey__title';

    // Key list
    this.keyList = document.createElement('div');
    this.keyList.className = 'krypton-whichkey__keys';

    this.popup.appendChild(this.title);
    this.popup.appendChild(this.keyList);
    this.overlay.appendChild(this.popup);
    document.body.appendChild(this.overlay);

    window.addEventListener('resize', () => {
      if (this.overlay.classList.contains('krypton-whichkey--visible')) {
        this.positionPopup();
      }
    });
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

    let currentGroup: string | undefined;

    for (const entry of entries) {
      if (entry.group && entry.group !== currentGroup) {
        currentGroup = entry.group;
        const header = document.createElement('div');
        header.className = 'krypton-whichkey__group';
        header.textContent = entry.group;
        this.keyList.appendChild(header);
      }

      const row = document.createElement('div');
      row.className = 'krypton-whichkey__entry';
      if (entry.effect) {
        row.classList.add(`krypton-whichkey__entry--${entry.effect}`);
      }

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
    requestAnimationFrame(() => this.positionPopup());
  }

  private hide(): void {
    this.overlay.classList.remove('krypton-whichkey--visible');
  }

  private positionPopup(): void {
    const target = document.querySelector<HTMLElement>('.krypton-window--focused');
    const margin = 12;
    const popupRect = this.popup.getBoundingClientRect();
    const clamp = (value: number, min: number, max: number): number => {
      if (max < min) return min;
      return Math.min(Math.max(value, min), max);
    };
    const viewportMaxLeft = window.innerWidth - popupRect.width - margin;
    const viewportMaxTop = window.innerHeight - popupRect.height - margin;

    if (!target) {
      const fallbackLeft = clamp(window.innerWidth - popupRect.width - margin, margin, viewportMaxLeft);
      const fallbackTop = clamp(window.innerHeight - popupRect.height - 48, margin, viewportMaxTop);
      this.popup.style.left = `${fallbackLeft}px`;
      this.popup.style.top = `${fallbackTop}px`;
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const left = clamp(targetRect.right - popupRect.width - margin, margin, viewportMaxLeft);
    const top = clamp(targetRect.bottom - popupRect.height - margin, margin, viewportMaxTop);

    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }
}
