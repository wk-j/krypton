// Spec 320 — per-panel visibility for the ACP Harness.
//
// Each persistent panel (plan, lane peek, live thought, grammar review, prompt
// queue, Active Ticket dock, Rails dock) carries its own hidden flag, persisted per
// project. `#panels` (spec 251) stays the master switch above them: the two
// levels never rewrite each other. The view's renderers ask
// `isPanelHidden(id)`, which is `panelsHidden || hiddenPanels.has(id)`.

import type { TitlebarToggle } from '../types';

export type HarnessPanelId = 'plan' | 'peek' | 'thought' | 'grammar' | 'queue' | 'ticket' | 'rails';

/** Spec 337: the two tabs of the `dock.right` column. */
export type HarnessDockTab = 'ticket' | 'rails';

export interface HarnessTogglePanel {
  readonly id: HarnessPanelId;
  readonly label: string;
  /** Symbol id from `HARNESS_ICON_SVG_DEFS`. */
  readonly icon: string;
}

/** Titlebar order, left to right. */
export const HARNESS_TOGGLE_PANELS: readonly HarnessTogglePanel[] = [
  { id: 'plan', label: 'Plan panel', icon: 'krypton-icon-panel-plan' },
  { id: 'peek', label: 'Lane peek', icon: 'krypton-icon-panel-peek' },
  { id: 'thought', label: 'Thought', icon: 'krypton-icon-panel-thought' },
  { id: 'grammar', label: 'Grammar', icon: 'krypton-icon-panel-grammar' },
  { id: 'queue', label: 'Prompt queue', icon: 'krypton-icon-panel-queue' },
  { id: 'ticket', label: 'Ticket dock', icon: 'krypton-icon-panel-ticket' },
  { id: 'rails', label: 'Rails dock', icon: 'krypton-icon-panel-rails' },
];

/** Titlebar id of the master toggle — the same switch as bare `#panels`. */
export const ALL_PANELS_TOGGLE_ID = 'all';

export const PANELS_USAGE =
  'usage: #panels [hide | show | toggle] [plan | peek | thought | grammar | queue | ticket | rails]';

export type PanelsAction = 'hide' | 'show' | 'toggle';

export type PanelsCommand =
  | { kind: 'all'; action: PanelsAction }
  | { kind: 'panel'; panel: HarnessPanelId; action: PanelsAction }
  | { kind: 'usage' };

const PANEL_ID: Record<HarnessPanelId, true> = {
  plan: true,
  peek: true,
  thought: true,
  grammar: true,
  queue: true,
  ticket: true,
  rails: true,
};

export function isHarnessPanelId(value: string): value is HarnessPanelId {
  return Object.prototype.hasOwnProperty.call(PANEL_ID, value);
}

function isPanelsAction(value: string): value is PanelsAction {
  return value === 'hide' || value === 'show' || value === 'toggle';
}

/**
 * Parse the words after `#panels`:
 * `[]` / `[action]` address every panel; `[panel]` / `[action, panel]` one.
 * Anything else — unknown words, reversed order, extra words — is usage.
 */
export function parsePanelsCommand(args: readonly string[]): PanelsCommand {
  const words = args.map((word) => word.toLowerCase());
  if (words.length === 0) return { kind: 'all', action: 'toggle' };
  if (words.length > 2) return { kind: 'usage' };
  const [first, second] = words;
  if (words.length === 1) {
    if (isPanelsAction(first)) return { kind: 'all', action: first };
    if (isHarnessPanelId(first)) return { kind: 'panel', panel: first, action: 'toggle' };
    return { kind: 'usage' };
  }
  if (isPanelsAction(first) && isHarnessPanelId(second)) {
    return { kind: 'panel', panel: second, action: first };
  }
  return { kind: 'usage' };
}

/** The hidden flag an action produces from the current one. */
export function nextHidden(action: PanelsAction, hidden: boolean): boolean {
  if (action === 'hide') return true;
  if (action === 'show') return false;
  return !hidden;
}

/** Chip flashed after a single-panel change. */
export function panelFlash(panel: HarnessPanelId, hidden: boolean, allHidden: boolean): string {
  const base = hidden ? `${panel} hidden · #panels show ${panel}` : `${panel} shown`;
  return allHidden ? `${base} · all panels hidden` : base;
}

/** The view's titlebar contribution: seven panels, a divider, then the master toggle. */
export function harnessTitlebarToggles(
  hidden: ReadonlySet<HarnessPanelId>,
  allHidden: boolean,
): TitlebarToggle[] {
  const disabledReason = allHidden ? 'all panels hidden · #panels show' : undefined;
  const toggles: TitlebarToggle[] = HARNESS_TOGGLE_PANELS.map((panel) => ({
    id: panel.id,
    icon: panel.icon,
    label: panel.label,
    pressed: !hidden.has(panel.id),
    ...(disabledReason ? { disabledReason } : {}),
  }));
  toggles.push({
    id: ALL_PANELS_TOGGLE_ID,
    icon: 'krypton-icon-panel-all',
    label: 'All panels',
    pressed: !allHidden,
    separatorBefore: true,
  });
  return toggles;
}

/** Persisted per project, beside spec 251's `krypton:acp-harness:panels-hidden:`. */
const HIDDEN_PANELS_KEY_PREFIX = 'krypton:acp-harness:hidden-panels:';

/** Unknown ids, corrupt JSON and unavailable storage all read as "not hidden". */
export function readHiddenPanels(projectDir: string | null): ReadonlySet<HarnessPanelId> {
  try {
    const raw = localStorage.getItem(`${HIDDEN_PANELS_KEY_PREFIX}${projectDir ?? ''}`);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((value): value is HarnessPanelId => typeof value === 'string' && isHarnessPanelId(value)),
    );
  } catch {
    return new Set();
  }
}

export function writeHiddenPanels(projectDir: string | null, hidden: ReadonlySet<HarnessPanelId>): void {
  try {
    const key = `${HIDDEN_PANELS_KEY_PREFIX}${projectDir ?? ''}`;
    if (hidden.size === 0) {
      localStorage.removeItem(key);
      return;
    }
    const ordered = HARNESS_TOGGLE_PANELS.map((panel) => panel.id).filter((id) => hidden.has(id));
    localStorage.setItem(key, JSON.stringify(ordered));
  } catch {
    // localStorage unavailable — the preference simply won't persist
  }
}

/** Spec 337: the selected dock tab, persisted beside the hidden flags. */
const DOCK_TAB_KEY_PREFIX = 'krypton:acp-harness:dock-tab:';

/** Anything but a stored `rails` reads as the Ticket tab, today's only dock. */
export function readDockTab(projectDir: string | null): HarnessDockTab {
  try {
    return localStorage.getItem(`${DOCK_TAB_KEY_PREFIX}${projectDir ?? ''}`) === 'rails' ? 'rails' : 'ticket';
  } catch {
    return 'ticket';
  }
}

export function writeDockTab(projectDir: string | null, tab: HarnessDockTab): void {
  try {
    const key = `${DOCK_TAB_KEY_PREFIX}${projectDir ?? ''}`;
    if (tab === 'ticket') localStorage.removeItem(key);
    else localStorage.setItem(key, tab);
  } catch {
    // localStorage unavailable — the choice simply won't persist
  }
}
