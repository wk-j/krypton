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
  'system:focus-change': { windowId: WindowId | null };
  'system:relayout': Record<string, never>;
}

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
