// Krypton — Rails verifier: the Rails dock's action buttons (spec 344).
//
// Each button is a `#rails` sub-command that takes no argument and acts now.
// A click calls the same controller method as the typed sub-command, so these
// rules only decide what a button shows: running, done, disabled, tooltip.
// Run has no done state on purpose: a green `✓` beside a run whose verdict is
// `check_failed` would read as a verdict (ADR-0025 item 5).

import type { DockActionState } from '../components/dock-action';
import { formatActionTime, fullActionTime, ticketWorkActionDisabledReason } from '../harness-ticket-helpers';
import type { RailsSendSet } from './envelope';
import { plural, progressText } from './format';
import type { RailsMode, RailsProgress, RailsSnapshot } from './types';

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

/** A Send-all delivered these Send-set keys (spec 368 amendment A). Memory only. */
export interface RailsSendMark {
  readonly keys: readonly string[];
  /** The set's label at send time: `3 open findings and failed osv`. */
  readonly label: string;
  readonly laneName: string;
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
  /** Spec 368: why a manual check's RUN key is disabled (its tooltip), or null. */
  readonly checkDisabledReason: string | null;
}

export interface RailsDockActionsInput {
  readonly snapshot: RailsSnapshot | null;
  readonly mode: RailsMode;
  readonly progress: RailsProgress;
  /** The controller has a run in flight (from the clean-tree probe to the record). */
  readonly running: boolean;
  /** Spec 368: the manual check running now, or null. */
  readonly checkInFlight: string | null;
  /** What Send-all would deliver now. */
  readonly sendSet: RailsSendSet;
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
  let disabledReason: string | null = null;
  if (input.mode === 'off') disabledReason = 'rails is off · #rails manual';
  else if (input.checkInFlight !== null) disabledReason = 'a run is already in progress';
  return {
    state: {
      kind: 'idle',
      detail: trusted
        ? 'Run the auto checks and the judge now (#rails now · r)'
        : 'Judge only — checks wait for trust (#rails now · r)',
    },
    disabledReason,
  };
}

/** Spec 368: a manual check runs only when Rails is on, trusted, and idle. */
function checkDisabledReason(input: RailsDockActionsInput): string | null {
  if (input.mode === 'off') return 'rails is off · #rails manual';
  if (input.snapshot?.trust !== 'trusted') return 'not trusted · #rails trust';
  if (input.running || input.checkInFlight !== null) return 'a run is already in progress';
  return null;
}

/** Done while the set is not empty and every item in it was sent: a clean run
 *  keeps it; open findings in a newer run, or a newer failed result, clear it. */
function sendView(input: RailsDockActionsInput): RailsActionView {
  const { sendSet, lastSend, activeLane, now } = input;
  const empty = sendSet.keys.length === 0;
  const disabledReason = empty ? 'no open findings or failed manual checks' : activeLane ? null : 'no active lane';
  if (!empty && lastSend && sendSet.keys.every((key) => lastSend.keys.includes(key))) {
    return {
      state: {
        kind: 'done',
        badge: `✓ ${formatActionTime(lastSend.at, now)}`,
        detail: `${lastSend.label} sent to ${lastSend.laneName} ${fullActionTime(lastSend.at)}`,
      },
      disabledReason,
    };
  }
  const detail = activeLane && !empty
    ? `Send ${sendSet.label} to ${activeLane.displayName} (#rails send · s on the head row)`
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
    checkDisabledReason: checkDisabledReason(input),
  };
}
