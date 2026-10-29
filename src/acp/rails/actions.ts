// Krypton — Rails verifier: the Rails dock's action buttons (spec 344).
//
// Each button is a `#rails` sub-command that takes no argument and acts now.
// A click calls the same controller method as the typed sub-command, so these
// rules only decide what a button shows: running, done, disabled, tooltip.
// Run has no done state on purpose: a green `✓` beside a run whose verdict is
// `check_failed` would read as a verdict (ADR-0025 item 5).

import type { DockActionState } from '../components/dock-action';
import { formatActionTime, fullActionTime, ticketWorkActionDisabledReason } from '../harness-ticket-helpers';
import { plural, progressText } from './format';
import type { RailsMode, RailsProgress, RailsRunRecord, RailsSnapshot } from './types';

/** Paint order. `verb` is the `#rails` sub-command; `icon` the `krypton-icon-*` suffix. */
export const RAILS_DOCK_ACTIONS = [
  { verb: 'now', label: 'Run', icon: 'rails-run' },
  { verb: 'send', label: 'Send', icon: 'rails-send' },
  { verb: 'trust', label: 'Trust', icon: 'rails-trust' },
  { verb: 'update', label: 'Update', icon: 'rails-update' },
] as const;

export type RailsDockAction = (typeof RAILS_DOCK_ACTIONS)[number]['verb'];

export function railsDockActionFromData(value: string | undefined): RailsDockAction | null {
  return RAILS_DOCK_ACTIONS.find((action) => action.verb === value)?.verb ?? null;
}

/** The newest run's findings were sent to a lane (send-all only). Memory only. */
export interface RailsSendMark {
  readonly runId: string;
  readonly laneName: string;
  readonly count: number;
  readonly at: number;
}

export interface RailsActionView {
  readonly state: DockActionState;
  /** Non-null disables the button; it becomes the tooltip. */
  readonly disabledReason: string | null;
}

/** Everything the Actions bar paints. */
export interface RailsDockActions {
  readonly states: Readonly<Record<RailsDockAction, RailsActionView>>;
  /** `lane codex-1 · idle`: where Send and Update go. */
  readonly laneLine: string;
}

export interface RailsDockActionsInput {
  readonly snapshot: RailsSnapshot | null;
  readonly mode: RailsMode;
  readonly progress: RailsProgress;
  /** The controller has a run in flight (from the clean-tree probe to the record). */
  readonly running: boolean;
  readonly latest: RailsRunRecord | null;
  readonly lastSend: RailsSendMark | null;
  readonly activeLane: { readonly displayName: string; readonly status: string; readonly hasClient: boolean } | null;
  /** Display name of the lane whose turn carries the `rails update` label, if any. */
  readonly updateLane: string | null;
  readonly now: number;
}

function runView(input: RailsDockActionsInput, trusted: boolean): RailsActionView {
  if (input.running) {
    const kind = input.progress.kind;
    const step = kind === 'checking' || kind === 'judging' ? progressText(input.progress) : null;
    return {
      state: { kind: 'running', badge: step ?? 'running', detail: 'Rails run in progress' },
      disabledReason: 'a run is already in progress',
    };
  }
  return {
    state: {
      kind: 'idle',
      detail: trusted
        ? 'Run the checks and the judge now (#rails now · r)'
        : 'Judge only — checks wait for trust (#rails now · r)',
    },
    disabledReason: input.mode === 'off' ? 'rails is off · #rails manual' : null,
  };
}

function sendView(input: RailsDockActionsInput): RailsActionView {
  const { latest, lastSend, activeLane, now } = input;
  const open = latest?.open.length ?? 0;
  const disabledReason = open === 0 ? 'no open findings' : activeLane ? null : 'no active lane';
  if (latest && lastSend?.runId === latest.runId) {
    return {
      state: {
        kind: 'done',
        badge: `✓ ${formatActionTime(lastSend.at, now)}`,
        detail: `${plural(lastSend.count, 'finding')} sent to ${lastSend.laneName} ${fullActionTime(lastSend.at)}`,
      },
      disabledReason,
    };
  }
  const detail = activeLane
    ? `Send ${plural(open, 'open finding')} to ${activeLane.displayName} (#rails send · s on the head row)`
    : undefined;
  return { state: { kind: 'idle', detail }, disabledReason };
}

function trustView(snapshot: RailsSnapshot | null): RailsActionView {
  const checks = plural(snapshot?.checks.length ?? 0, 'check');
  if (snapshot?.trust === 'trusted') {
    return {
      state: { kind: 'done', badge: '✓ trusted', detail: `rails.toml is trusted · ${checks} may run` },
      disabledReason: null,
    };
  }
  let detail: string;
  if (!snapshot || snapshot.checks.length === 0) detail = 'Trust rails.toml so auto runs can start (#rails trust)';
  else if (snapshot.trust === 'changed') {
    detail = `rails.toml changed since trust — allow the ${checks} listed above (#rails trust)`;
  } else detail = `Allow the ${checks} listed above to run (#rails trust)`;
  return { state: { kind: 'idle', detail }, disabledReason: null };
}

function updateView(input: RailsDockActionsInput): RailsActionView {
  const { activeLane, updateLane } = input;
  const disabledReason = ticketWorkActionDisabledReason(activeLane);
  if (updateLane !== null) {
    return {
      state: { kind: 'running', badge: `running · ${updateLane}`, detail: `Update running in ${updateLane}` },
      disabledReason,
    };
  }
  const detail = activeLane
    ? `${activeLane.displayName} proposes rails changes, then waits for you (#rails update)`
    : undefined;
  return { state: { kind: 'idle', detail }, disabledReason };
}

/** Spec 344 §State rules. */
export function railsDockActions(input: RailsDockActionsInput): RailsDockActions {
  const lane = input.activeLane;
  return {
    states: {
      now: runView(input, input.snapshot?.trust === 'trusted'),
      send: sendView(input),
      trust: trustView(input.snapshot),
      update: updateView(input),
    },
    laneLine: lane ? `lane ${lane.displayName} · ${lane.status}` : 'no active lane',
  };
}
