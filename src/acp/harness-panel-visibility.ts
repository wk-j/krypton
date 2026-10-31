// Spec 320 — per-panel visibility for the ACP Harness.
//
// Each persistent panel (plan, lane peek, live thought, grammar review, prompt
// queue, Active Ticket dock, Rails dock) carries its own hidden flag, persisted per
// project. Spec 347 adds one flag per side panel beside them: `left` hides the
// Zen lane rail, `right` hides the dock column. No flag ever rewrites another.
// The view's renderers ask `isPanelHidden(id)`: the panel's own flag, or, for
// the two dock tabs, the `right` flag too.

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

/** Spec 347: the side panels — `left` is the Zen lane rail, `right` the dock column. */
export type HarnessSide = 'left' | 'right';

export const PANELS_USAGE =
  'usage: #panels [hide | show | toggle] <left | right | plan | peek | thought | grammar | queue | ticket | rails>';

export type PanelsAction = 'hide' | 'show' | 'toggle';

export type PanelsCommand =
  | { kind: 'side'; side: HarnessSide; action: PanelsAction }
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

export function isHarnessSide(value: string): value is HarnessSide {
  return value === 'left' || value === 'right';
}

/** The two panels that are tabs of the dock column, which the `right` flag hides. */
export function isDockTab(panel: HarnessPanelId): panel is HarnessDockTab {
  return panel === 'ticket' || panel === 'rails';
}

function isPanelsAction(value: string): value is PanelsAction {
  return value === 'hide' || value === 'show' || value === 'toggle';
}

/**
 * Parse the words after `#panels`: `[target]` toggles one side or panel,
 * `[action, target]` sets it. Anything else — no target (spec 347 removed the
 * all-panels forms), unknown words, reversed order, extra words — is usage.
 */
export function parsePanelsCommand(args: readonly string[]): PanelsCommand {
  const words = args.map((word) => word.toLowerCase());
  if (words.length === 0 || words.length > 2) return { kind: 'usage' };
  const [action, target] = words.length === 1 ? ['toggle', words[0]] : words;
  if (!isPanelsAction(action)) return { kind: 'usage' };
  if (isHarnessSide(target)) return { kind: 'side', side: target, action };
  if (isHarnessPanelId(target)) return { kind: 'panel', panel: target, action };
  return { kind: 'usage' };
}

/** The hidden flag an action produces from the current one. */
export function nextHidden(action: PanelsAction, hidden: boolean): boolean {
  if (action === 'hide') return true;
  if (action === 'show') return false;
  return !hidden;
}

/** Chip flashed after a single-panel change; a dock tab says when the right panel hides it. */
export function panelFlash(panel: HarnessPanelId, hidden: boolean, rightPanelHidden: boolean): string {
  const base = hidden ? `${panel} hidden · #panels show ${panel}` : `${panel} shown`;
  return rightPanelHidden && isDockTab(panel) ? `${base} · right panel hidden` : base;
}

/** Chip flashed after a side-panel change. */
export function sideFlash(side: HarnessSide, hidden: boolean): string {
  return hidden ? `${side} panel hidden · #panels show ${side}` : `${side} panel shown`;
}

/** The view's titlebar contribution: seven panels, a divider, then the left and right panels. */
export function harnessTitlebarToggles(
  hidden: ReadonlySet<HarnessPanelId>,
  sides: Readonly<Record<HarnessSide, boolean>>,
): TitlebarToggle[] {
  const toggles: TitlebarToggle[] = HARNESS_TOGGLE_PANELS.map((panel) => ({
    id: panel.id,
    icon: panel.icon,
    label: panel.label,
    pressed: !hidden.has(panel.id),
  }));
  toggles.push(
    { id: 'left', icon: 'krypton-icon-panel-left', label: 'Left panel', pressed: !sides.left, separatorBefore: true },
    { id: 'right', icon: 'krypton-icon-panel-right', label: 'Right panel', pressed: !sides.right },
  );
  return toggles;
}

/** Spec 347: `'1'` while that side panel is hidden; the key is removed when it is shown. */
function sideHiddenKey(projectDir: string | null, side: HarnessSide): string {
  return `krypton:acp-harness:${side}-panel-hidden:${projectDir ?? ''}`;
}

/** Unavailable storage reads as "shown". */
export function readSideHidden(projectDir: string | null, side: HarnessSide): boolean {
  try {
    return localStorage.getItem(sideHiddenKey(projectDir, side)) === '1';
  } catch {
    return false;
  }
}

export function writeSideHidden(projectDir: string | null, side: HarnessSide, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(sideHiddenKey(projectDir, side), '1');
    else localStorage.removeItem(sideHiddenKey(projectDir, side));
  } catch {
    // localStorage unavailable — the preference simply won't persist
  }
}

/** Persisted per project, beside the side flags. */
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
