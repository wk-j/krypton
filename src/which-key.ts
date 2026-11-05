// Krypton — Which-Key Popup
// Helix-style modal popup that shows available keybindings
// when entering a non-Normal mode.

import type { LeaderKeyBinding, PaneContentType } from './types';
import { LayoutMode, Mode } from './types';
import { paletteIcon } from './palette-icons';
import type { PaletteIconName } from './palette-icons';

/** A single keybinding entry displayed in the popup */
interface KeyEntry {
  key: string;
  label: string;
  /** Glyph drawn between key and label (spec 360); same concept, same glyph as the palette. */
  icon: PaletteIconName;
  effect?: 'important' | 'danger';
  group?: string;
  /** If set, only show this entry when focused pane matches one of these types.
   *  null in the array means "terminal" (no contentView). */
  contentTypes?: (PaneContentType | null)[];
}

function leaderBindingsToEntries(bindings: LeaderKeyBinding[]): KeyEntry[] {
  return bindings.map((binding) => ({
    key: binding.key,
    label: binding.label,
    icon: binding.icon,
    group: binding.group,
    effect: binding.effect,
  }));
}

function groupEntries(group: string, entries: KeyEntry[]): KeyEntry[] {
  return entries.map((entry) => ({ ...entry, group }));
}

/** Keybindings per mode — compositor keys are content-type-aware */
const SCROLL_WINDOW_KEYS: KeyEntry[] = groupEntries('Windows', [
  { key: 'n', label: 'New Window', icon: 'square-plus' },
  { key: 'x', label: 'Close Window', icon: 'x', effect: 'danger' },
  { key: 'h', label: 'Pane/Column Left', icon: 'arrow-left' },
  { key: 'j', label: 'Pane/Window Down', icon: 'arrow-down' },
  { key: 'k', label: 'Pane/Window Up', icon: 'arrow-up' },
  { key: 'l', label: 'Pane/Column Right', icon: 'arrow-right' },
  { key: ',', label: 'Consume/Expel Left', icon: 'arrow-left-to-line' },
  { key: '.', label: 'Consume/Expel Right', icon: 'arrow-right-to-line' },
  { key: '=', label: 'Cycle Column Width', icon: 'unfold-horizontal' },
  { key: '1-9', label: 'Focus By Index', icon: 'hash' },
  { key: 'f', label: 'Cycle Layout', icon: 'repeat' },
  { key: 'r', label: 'Resize Mode', icon: 'scaling', effect: 'important' },
  { key: 'm', label: 'Move Mode', icon: 'move', effect: 'important' },
  { key: 's', label: 'Swap Mode', icon: 'replace', effect: 'important' },
  { key: 'z', label: 'Maximize', icon: 'maximize-2', effect: 'important' },
  { key: 'p', label: 'Pin Window', icon: 'pin' },
]);

const STAGE_WINDOW_KEYS: KeyEntry[] = groupEntries('Windows', [
  { key: 'n', label: 'New Window', icon: 'square-plus' },
  { key: 'x', label: 'Close Window', icon: 'x', effect: 'danger' },
  { key: 'h/k', label: 'Pane/Prev Stage', icon: 'chevrons-left' },
  { key: 'j/l', label: 'Pane/Next Stage', icon: 'chevrons-right' },
  { key: '1-9', label: 'Activate Stage', icon: 'hash' },
  { key: '!', label: 'Next Needing You', icon: 'bell-ring' },
  { key: 'f', label: 'Cycle Layout', icon: 'repeat' },
  { key: 'r', label: 'Resize Stage', icon: 'scaling', effect: 'important' },
  { key: 'm', label: 'Move Stage', icon: 'move', effect: 'important' },
  { key: '=', label: 'Reset Stage Frame', icon: 'rotate-ccw-square' },
  { key: 'z', label: 'Maximize', icon: 'maximize-2', effect: 'important' },
  { key: 'p', label: 'Pin (No Stage Effect)', icon: 'pin' },
]);

// spec 272: resize/move/pin/= have no Wheel effect, so they are not listed.
const WHEEL_WINDOW_KEYS: KeyEntry[] = groupEntries('Windows', [
  { key: 'n', label: 'New Window', icon: 'square-plus' },
  { key: 'x', label: 'Close Window', icon: 'x', effect: 'danger' },
  { key: 'h/k', label: 'Pane/Prev Window', icon: 'chevrons-left' },
  { key: 'j/l', label: 'Pane/Next Window', icon: 'chevrons-right' },
  { key: '1-9', label: 'Jump To Window', icon: 'hash' },
  { key: '!', label: 'Next Needing You', icon: 'bell-ring' },
  { key: 'f', label: 'Cycle Layout', icon: 'repeat' },
  { key: 's', label: 'Reorder Wheel', icon: 'replace', effect: 'important' },
  { key: 'z', label: 'Maximize', icon: 'maximize-2', effect: 'important' },
]);

const COMPOSITOR_KEYS: KeyEntry[] = [
  ...groupEntries('Windows', [
    { key: 'n', label: 'New Window', icon: 'square-plus' },
    { key: 'x', label: 'Close Window', icon: 'x', effect: 'danger' },
    { key: 'h', label: 'Pane/Window Left', icon: 'arrow-left' },
    { key: 'j', label: 'Pane/Window Down', icon: 'arrow-down' },
    { key: 'k', label: 'Pane/Window Up', icon: 'arrow-up' },
    { key: 'l', label: 'Pane/Window Right', icon: 'arrow-right' },
    { key: '1-9', label: 'Focus By Index', icon: 'hash' },
    { key: '!', label: 'Next Needing You', icon: 'bell-ring' },
    { key: 'f', label: 'Cycle Layout', icon: 'repeat' },
    { key: 'r', label: 'Resize Mode', icon: 'scaling', effect: 'important' },  // Shift+R = Review Board (AI group)
    { key: 'm', label: 'Move Mode', icon: 'move', effect: 'important' },
    { key: 's', label: 'Swap Mode', icon: 'replace', effect: 'important' },
    { key: 'z', label: 'Maximize', icon: 'maximize-2', effect: 'important' },
    { key: 'p', label: 'Pin Window', icon: 'pin' },
  ]),

  ...groupEntries('Tabs / Panes', [
    { key: 't', label: 'New Tab', icon: 'plus' },
    { key: 'w', label: 'Close Tab', icon: 'x', effect: 'danger' },
    { key: '[', label: 'Previous Tab', icon: 'chevrons-left' },
    { key: ']', label: 'Next Tab', icon: 'chevrons-right' },
    { key: 'T', label: 'Move Tab', icon: 'square-arrow-right', effect: 'important' },
    { key: '\\', label: 'Split Vertical', icon: 'columns-2' },
    { key: '-', label: 'Split Horizontal', icon: 'rows-2' },
    { key: 'A-hjkl', label: 'Focus Pane Only', icon: 'crosshair' },
    { key: 'A-x', label: 'Close Pane', icon: 'x', effect: 'danger' },
    // spec 296. Shift-only: bare `o` is Markdown Viewer in a new tab.
    { key: 'O', label: 'Markdown To Side', icon: 'panel-right', effect: 'important' },
  ]),

  ...groupEntries('Apps', [
    { key: 'b', label: 'File Manager', icon: 'folder-tree', effect: 'important' },
    { key: 'u', label: 'Vault Viewer', icon: 'vault', effect: 'important' },
    { key: 'e', label: 'Pencil', icon: 'pencil', effect: 'important' },
    { key: 'q', label: 'Hurl Client', icon: 'arrow-right-left', effect: 'important' },
    { key: '$', label: 'Credit Usage', icon: 'chart-column', effect: 'important' },
    { key: 'M', label: 'Music Dashboard', icon: 'eighth-notes', effect: 'important' },
    { key: 'P', label: 'Profiler HUD', icon: 'gauge', effect: 'important' },
    { key: 'K', label: 'Keyboard Overlay', icon: 'keyboard', effect: 'important' },
    { key: 'H', label: 'Hint Mode', icon: 'mouse-pointer-click', effect: 'important' },
    // spec 213. Shift-only: bare `x` is Close Window, listed under Windows.
    { key: 'X', label: 'Probe Backend Link', icon: 'satellite-dish', effect: 'important' },
  ]),

  ...groupEntries('AI', [
    { key: 'a', label: 'AI Agent', icon: 'sparkles', effect: 'important' },
    { key: 'Y', label: 'ACP Harness', icon: 'bot', effect: 'important' },
    { key: 'S', label: 'Remote ACP Harness', icon: 'server', effect: 'important' },
    // spec 211. Shift-only: bare `r` is Resize Mode, listed under Windows.
    { key: 'R', label: 'Review Board', icon: 'clipboard-list', effect: 'important' },
  ]),

  ...groupEntries('Terminal', [
    { key: 'v', label: 'Select Mode', icon: 'text-cursor', contentTypes: [null] },
    { key: 'V', label: 'Select Lines', icon: 'text-align-start', contentTypes: [null] },
    { key: 'd', label: 'Git Diff', icon: 'diff', effect: 'important', contentTypes: [null] },
    { key: 'D', label: 'Git Diff Staged', icon: 'diff', effect: 'important', contentTypes: [null] },
    { key: 'i', label: 'Native / Raw Output', icon: 'toggle-left', contentTypes: [null] },
    { key: 'I', label: 'Copy Native Output', icon: 'copy', contentTypes: [null] },
    { key: 'o', label: 'Markdown Viewer', icon: 'file-text', effect: 'important', contentTypes: [null] },
    { key: 'J', label: 'Daily Note', icon: 'calendar', effect: 'important', contentTypes: [null] },
    { key: 'c', label: 'Clone SSH Tab', icon: 'copy-plus', contentTypes: [null] },
    { key: 'C', label: 'Clone SSH Window', icon: 'copy-plus', contentTypes: [null] },
    { key: 'g', label: 'Cycle Shader', icon: 'wand-sparkles' },
    { key: 'G', label: 'Toggle Shaders', icon: 'wand-sparkles', effect: 'important' },
  ]),

  ...groupEntries('Markdown', [
    { key: 'o', label: 'Markdown Viewer', icon: 'file-text', effect: 'important', contentTypes: ['markdown'] },
  ]),
];

const SCROLL_COMPOSITOR_KEYS: KeyEntry[] = [
  ...SCROLL_WINDOW_KEYS,
  ...COMPOSITOR_KEYS.filter((e) => e.group !== 'Windows'),
];

const STAGE_COMPOSITOR_KEYS: KeyEntry[] = [
  ...STAGE_WINDOW_KEYS,
  ...COMPOSITOR_KEYS.filter((e) => e.group !== 'Windows'),
];

const WHEEL_COMPOSITOR_KEYS: KeyEntry[] = [
  ...WHEEL_WINDOW_KEYS,
  ...COMPOSITOR_KEYS.filter((e) => e.group !== 'Windows'),
];

const RESIZE_KEYS: KeyEntry[] = [
  { key: '\u2190', label: 'Shrink Width', icon: 'chevrons-right-left' },
  { key: '\u2192', label: 'Grow Width', icon: 'chevrons-left-right' },
  { key: '\u2191', label: 'Shrink Height', icon: 'chevrons-down-up' },
  { key: '\u2193', label: 'Grow Height', icon: 'chevrons-up-down' },
  // spec 296: Shift+letter moves the nearest split divider, not the window.
  { key: 'H/L', label: 'Split Divider \u2190/\u2192', icon: 'separator-vertical' },
  { key: 'K/J', label: 'Split Divider \u2191/\u2193', icon: 'separator-horizontal' },
  { key: '=', label: 'Even Split', icon: 'scale' },
  { key: 'Esc', label: 'Done', icon: 'check', effect: 'important' },
];

const MOVE_KEYS: KeyEntry[] = [
  { key: '\u2190', label: 'Move Left', icon: 'arrow-left' },
  { key: '\u2192', label: 'Move Right', icon: 'arrow-right' },
  { key: '\u2191', label: 'Move Up', icon: 'arrow-up' },
  { key: '\u2193', label: 'Move Down', icon: 'arrow-down' },
  { key: 'Esc', label: 'Done', icon: 'check', effect: 'important' },
];

const SWAP_KEYS: KeyEntry[] = [
  { key: 'h/\u2190', label: 'Swap Left', icon: 'arrow-left' },
  { key: 'l/\u2192', label: 'Swap Right', icon: 'arrow-right' },
  { key: 'k/\u2191', label: 'Swap Up', icon: 'arrow-up' },
  { key: 'j/\u2193', label: 'Swap Down', icon: 'arrow-down' },
];

const TAB_MOVE_KEYS: KeyEntry[] = [
  { key: '1-9', label: 'Move To Window N', icon: 'hash' },
  { key: 'Esc', label: 'Cancel', icon: 'circle-x', effect: 'important' },
];

const HINT_KEYS: KeyEntry[] = [
  { key: 'a-z', label: 'Type Label', icon: 'type' },
  { key: 'Bksp', label: 'Undo Char', icon: 'delete' },
  { key: 'Esc', label: 'Cancel', icon: 'circle-x', effect: 'important' },
];

const SELECTION_KEYS: KeyEntry[] = [
  { key: 'h/l', label: 'Move Left/Right', icon: 'move-horizontal' },
  { key: 'j/k', label: 'Move Down/Up', icon: 'move-vertical' },
  { key: 'w/b', label: 'Word Forward/Back', icon: 'whole-word' },
  { key: 'e', label: 'Word End', icon: 'arrow-right-to-line' },
  { key: '0/$', label: 'Line Start/End', icon: 'arrow-left-right' },
  { key: 'gg/G', label: 'Buffer Top/Bottom', icon: 'arrow-up-down' },
  { key: 'v', label: 'Toggle Char Select', icon: 'text-cursor' },
  { key: 'V', label: 'Toggle Line Select', icon: 'text-align-start' },
  { key: 'y', label: 'Yank To Clipboard', icon: 'clipboard-copy' },
  { key: 'Esc', label: 'Exit', icon: 'circle-x', effect: 'important' },
];

/** Filter key entries by focused pane content type. */
function filterByContentType(entries: KeyEntry[], contentType: PaneContentType | null): KeyEntry[] {
  return entries.filter((e) => {
    if (!e.contentTypes) return true; // no restriction — always show
    return e.contentTypes.includes(contentType);
  });
}

/** Consecutive entries under one group header. An ungrouped entry joins the open section. */
interface KeySection {
  group?: string;
  entries: KeyEntry[];
}

function toSections(entries: KeyEntry[]): KeySection[] {
  const sections: KeySection[] = [];
  for (const entry of entries) {
    const open = sections[sections.length - 1];
    if (open && (!entry.group || entry.group === open.group)) {
      open.entries.push(entry);
    } else {
      sections.push({ group: entry.group, entries: [entry] });
    }
  }
  return sections;
}

/** A group header occupies a line like an entry does. */
function sectionLines(section: KeySection): number {
  return section.entries.length + (section.group ? 1 : 0);
}

/**
 * Split sections into two columns of near-equal height. Groups stay whole;
 * a lone section (the ungrouped modes) splits between its entries instead.
 */
function splitColumns(sections: KeySection[]): KeySection[][] {
  if (sections.length === 1) {
    const [only] = sections;
    const half = Math.ceil(only.entries.length / 2);
    const right = only.entries.slice(half);
    const left: KeySection = { group: only.group, entries: only.entries.slice(0, half) };
    return right.length > 0 ? [[left], [{ entries: right }]] : [[left]];
  }

  const lines = sections.map(sectionLines);
  const total = lines.reduce((sum, count) => sum + count, 0);
  let split = 1;
  let bestDiff = Infinity;
  let leftLines = 0;
  for (let i = 1; i < sections.length; i++) {
    leftLines += lines[i - 1];
    const diff = Math.abs(total - 2 * leftLines);
    if (diff < bestDiff) {
      bestDiff = diff;
      split = i;
    }
  }
  return [sections.slice(0, split), sections.slice(split)];
}

/** A line is ~1.5em tall; the 4em emblem plus its gap fits in four of them. */
const EMBLEM_MIN_SPARE_LINES = 4;

/** Index of the shorter column when its leftover space fits the emblem, else -1. */
function emblemColumn(columns: KeySection[][]): number {
  if (columns.length !== 2) return -1;
  const [left, right] = columns.map((sections) =>
    sections.reduce((sum, section) => sum + sectionLines(section), 0),
  );
  if (Math.abs(left - right) < EMBLEM_MIN_SPARE_LINES) return -1;
  return left < right ? 0 : 1;
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
  setMode(
    mode: Mode,
    contentType: PaneContentType | null = null,
    focusedLeaderKeys: LeaderKeyBinding[] = [],
    layoutMode: LayoutMode = LayoutMode.Focus,
  ): void {
    if (mode === Mode.Normal) {
      this.hide();
      return;
    }

    let entries: KeyEntry[];
    let titleText: string;

    switch (mode) {
      case Mode.Compositor:
        entries = [
          ...filterByContentType(
            layoutMode === LayoutMode.Scroll
              ? SCROLL_COMPOSITOR_KEYS
              : layoutMode === LayoutMode.Stage
                ? STAGE_COMPOSITOR_KEYS
                : layoutMode === LayoutMode.Wheel
                  ? WHEEL_COMPOSITOR_KEYS
                  : COMPOSITOR_KEYS,
            contentType,
          ),
          ...leaderBindingsToEntries(focusedLeaderKeys),
        ];
        titleText = contentType
          ? `Compositor · ${contentType}`
          : layoutMode === LayoutMode.Scroll
            ? 'Compositor · Scroll'
            : layoutMode === LayoutMode.Stage
              ? 'Compositor · Stage'
            : layoutMode === LayoutMode.Wheel
              ? 'Compositor · Wheel'
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

    const columns = splitColumns(toSections(entries));
    const emblemAt = mode === Mode.Compositor ? emblemColumn(columns) : -1;
    columns.forEach((sections, index) => {
      const column = document.createElement('div');
      column.className = 'krypton-whichkey__column';

      const list = document.createElement('div');
      list.className = 'krypton-whichkey__list';

      for (const section of sections) {
        if (section.group) {
          const header = document.createElement('div');
          header.className = 'krypton-whichkey__group';
          header.textContent = section.group;
          list.appendChild(header);
        }

        for (const entry of section.entries) {
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
          row.appendChild(paletteIcon(entry.icon, 'krypton-whichkey__icon'));
          row.appendChild(label);
          list.appendChild(row);
        }
      }

      column.appendChild(list);
      if (index === emblemAt) {
        const emblem = document.createElement('div');
        emblem.className = 'krypton-whichkey__emblem';
        emblem.appendChild(paletteIcon('layout-dashboard', 'krypton-whichkey__emblem-icon'));
        column.appendChild(emblem);
      }
      this.keyList.appendChild(column);
    });

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
