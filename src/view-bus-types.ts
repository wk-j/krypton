// View Protocol — closed vocabulary of signal/intent kinds and their payloads.
// See docs/105-view-protocol.md.

import type { PaneContentType, PaneId, ProgressState, TabId, WindowId } from './types';

export interface ViewAddress {
  viewId: string;
  role: PaneContentType;
  windowId: WindowId;
  tabId: TabId;
  paneId: PaneId;
}

export interface SystemSource {
  kind: 'system';
}

export const SYSTEM_SOURCE: SystemSource = { kind: 'system' };

export type SignalSource = ViewAddress | SystemSource;

export type SignalState =
  | 'normal'
  | 'busy'
  | 'ok'
  | 'warn'
  | 'err'
  | 'special'
  | 'needs_attention';

export interface SignalValueMap {
  'view:state': SignalState;
  'view:throughput': number;
  'view:metrics': Record<string, string | number>;
  'view:exit': { code: number | null };
  'view:progress': { state: ProgressState; pct: number | null };
  // Working directory reported by the view, event-driven. Terminals emit this
  // from OSC 7 (every prompt / after `cd`) via the PTY→ViewBus bridge, so the
  // workspace footer reflects a directory change immediately instead of waiting
  // for a focus change or poll tick. `cwd` is the absolute path.
  'view:cwd': { cwd: string };
  'system:focus-change': { windowId: WindowId | null };
  'system:relayout': Record<string, never>;
  // spec 128: open attention-triage item count, published globally by each ACP
  // harness so the workspace footer can surface it regardless of focused view.
  // `sourceId` identifies the publishing harness instance so the footer sums
  // across all of them (collect every lane's attention in one place) rather than
  // last-writer-wins. A harness publishes `openCount: 0` for its id on dispose.
  // spec 138: `maxReversibility` is the heaviest open item's tier (the list is
  // pre-sorted), letting the footer colour the gauge by judgement weight; null
  // when nothing is open. Self-contained union (mirrors acp `Reversibility`
  // values) so the global bus stays decoupled from the ACP types.
  'system:attention': { sourceId: string; openCount: number; maxReversibility: AttentionTier | null };
  // spec 146: total recorded #review rounds (review quality matrix), published
  // globally by each ACP harness so the workspace footer can show a neutral
  // depth indicator regardless of focused view. `sourceId` identifies the
  // publishing harness so the footer sums across all of them rather than
  // last-writer-wins. A harness publishes `totalReviews: 0` for its id on
  // dispose. Deliberately just a count — never coloured by badness, never a
  // score (ADR-0004); it means "N rounds recorded — press to inspect", not
  // "act on me" (contrast the attention gauge).
  'review:quality': { sourceId: string; totalReviews: number };
  // spec 162: count of `high` review-priority ranges across this harness's
  // lanes (mark_review_priority roll-up), published globally so the workspace
  // footer can show a neutral "read these first" depth indicator regardless of
  // focused view. `sourceId` identifies the publishing harness so the footer
  // sums across all of them. A harness publishes `highCount: 0` for its id on
  // dispose. Neutral, never coloured — review priority is an advisory reading
  // hint (ADR-0009), not an action queue; it means "N spots marked to read
  // first — press to inspect", not "act on me".
  'review:priority': { sourceId: string; highCount: number };
  // spec 155: published by an ACP harness whenever one of its lanes
  // transitions to `idle` — a lane quiet point (ADR-0008). `cwd` is the
  // harness's projectDir; consumers (the Diff Window) resolve it to a repo
  // root and refresh when it matches their own. Deliberately carries no lane
  // identity: the only meaning is "a lane in this project just went quiet".
  'harness:lane-idle': { cwd: string };
}

/** spec 138: reversibility tier of the heaviest open attention item, ordered
 * lightest → heaviest. String values match acp `Reversibility`. */
export type AttentionTier = 'reversible' | 'costly' | 'irreversible';

export type SignalKind = keyof SignalValueMap;

export interface Signal<K extends SignalKind = SignalKind> {
  kind: K;
  source: SignalSource;
  value: SignalValueMap[K];
  ts: number;
}

export interface IntentPayloadMap {
  'pane:open': { type: PaneContentType; path?: string };
  'pane:focus': { viewId: string };
  'pane:close': { viewId: string };
  'diff:open-file': { path: string };
  'markdown:open-file': { path: string };
  'webview:navigate': { url: string };
  'agent:add-context': { text: string; mime?: string };
  'sound:play': { name: string };
}

export type IntentKind = keyof IntentPayloadMap;

export interface Intent<K extends IntentKind = IntentKind> {
  kind: K;
  source: ViewAddress;
  payload: IntentPayloadMap[K];
  ts: number;
}

export type IntentHandlerResult = void | { consumed: boolean };

export interface SignalFilter<K extends SignalKind> {
  kind: K;
  sourceRole?: PaneContentType;
  sourceViewId?: string;
}

export interface IntentFilter<K extends IntentKind> {
  kind: K;
}

export type Unsubscribe = () => void;
