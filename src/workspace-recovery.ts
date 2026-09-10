import { LayoutMode, type PaneContentType, type SplitDirection } from './types';

export const WORKSPACE_SNAPSHOT_VERSION = 1;

export type WorkspacePaneSnapshot =
  | {
    type: 'leaf';
    sessionId: number | null;
    contentType: PaneContentType;
  }
  | {
    type: 'split';
    direction: SplitDirection;
    ratio: number;
    first: WorkspacePaneSnapshot;
    second: WorkspacePaneSnapshot;
  };

export interface WorkspaceTabSnapshot {
  title: string;
  focusedPaneIndex: number;
  paneTree: WorkspacePaneSnapshot;
}

export interface WorkspaceWindowSnapshot {
  tabs: WorkspaceTabSnapshot[];
  activeTabIndex: number;
  pinned: boolean;
}

export interface WorkspaceSnapshot {
  version: typeof WORKSPACE_SNAPSHOT_VERSION;
  layoutMode: LayoutMode;
  focusedWindowIndex: number;
  maximizedWindowIndex: number | null;
  windows: WorkspaceWindowSnapshot[];
  depthOrder: number[];
  scrollState: {
    columns: Array<{
      windowIndexes: number[];
      width: number;
      heights: number[];
    }>;
    cameraX: number;
  };
  stageState: {
    order: number[];
    frame: { x: number; y: number; width: number; height: number };
  };
  quickTerminalSessionId: number | null;
  quickTerminalVisible: boolean;
}

export interface WorkspaceBootstrap {
  lifecycle: 'startup' | 'reload';
  snapshot: unknown | null;
  activeSessionIds: number[];
}

export interface WorkspaceRecoveryPlan {
  snapshot: WorkspaceSnapshot | null;
  activeSessionIds: Set<number>;
  orphanSessionIds: number[];
}

const CONTENT_TYPES: ReadonlySet<string> = new Set([
  'terminal',
  'diff',
  'markdown',
  'agent',
  'acp',
  'acp_harness',
  'context',
  'file_manager',
  'vault',
  'hurl',
  'pencil',
  'webview',
  'usage',
  'telegram_settings',
  'review',
]);

const LAYOUT_MODES: ReadonlySet<string> = new Set(Object.values(LayoutMode));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function parsePane(value: unknown): WorkspacePaneSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.type === 'leaf') {
    const sessionId = value.sessionId;
    if (sessionId !== null && !isIndex(sessionId)) return null;
    if (typeof value.contentType !== 'string' || !CONTENT_TYPES.has(value.contentType)) return null;
    return {
      type: 'leaf',
      sessionId,
      contentType: value.contentType as PaneContentType,
    };
  }
  if (value.type !== 'split') return null;
  if (value.direction !== 'horizontal' && value.direction !== 'vertical') return null;
  if (!isFiniteNumber(value.ratio)) return null;
  const first = parsePane(value.first);
  const second = parsePane(value.second);
  if (!first || !second) return null;
  return {
    type: 'split',
    direction: value.direction,
    ratio: Math.max(0.05, Math.min(0.95, value.ratio)),
    first,
    second,
  };
}

function parseIndexes(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every(isIndex)) return null;
  return value.slice();
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (!isRecord(value) || value.version !== WORKSPACE_SNAPSHOT_VERSION) return null;
  if (typeof value.layoutMode !== 'string' || !LAYOUT_MODES.has(value.layoutMode)) return null;
  if (!isIndex(value.focusedWindowIndex)) return null;
  if (value.maximizedWindowIndex !== null && !isIndex(value.maximizedWindowIndex)) return null;
  if (!Array.isArray(value.windows)) return null;

  const windows: WorkspaceWindowSnapshot[] = [];
  for (const rawWindow of value.windows) {
    if (!isRecord(rawWindow) || !Array.isArray(rawWindow.tabs)) return null;
    if (!isIndex(rawWindow.activeTabIndex) || typeof rawWindow.pinned !== 'boolean') return null;
    const tabs: WorkspaceTabSnapshot[] = [];
    for (const rawTab of rawWindow.tabs) {
      if (!isRecord(rawTab) || typeof rawTab.title !== 'string' || !isIndex(rawTab.focusedPaneIndex)) {
        return null;
      }
      const paneTree = parsePane(rawTab.paneTree);
      if (!paneTree) return null;
      tabs.push({
        title: rawTab.title,
        focusedPaneIndex: rawTab.focusedPaneIndex,
        paneTree,
      });
    }
    if (tabs.length === 0) return null;
    windows.push({
      tabs,
      activeTabIndex: rawWindow.activeTabIndex,
      pinned: rawWindow.pinned,
    });
  }

  if (!Array.isArray(value.depthOrder) || !value.depthOrder.every(isIndex)) return null;
  if (!isRecord(value.scrollState) || !Array.isArray(value.scrollState.columns)
      || !isFiniteNumber(value.scrollState.cameraX)) return null;
  const columns: WorkspaceSnapshot['scrollState']['columns'] = [];
  for (const rawColumn of value.scrollState.columns) {
    if (!isRecord(rawColumn) || !isFiniteNumber(rawColumn.width)
        || !Array.isArray(rawColumn.heights) || !rawColumn.heights.every(isFiniteNumber)) return null;
    const windowIndexes = parseIndexes(rawColumn.windowIndexes);
    if (!windowIndexes) return null;
    columns.push({ windowIndexes, width: rawColumn.width, heights: rawColumn.heights.slice() });
  }

  if (!isRecord(value.stageState) || !isRecord(value.stageState.frame)) return null;
  const order = parseIndexes(value.stageState.order);
  const frame = value.stageState.frame;
  if (!order || !isFiniteNumber(frame.x) || !isFiniteNumber(frame.y)
      || !isFiniteNumber(frame.width) || !isFiniteNumber(frame.height)) return null;
  if (value.quickTerminalSessionId !== null && !isIndex(value.quickTerminalSessionId)) return null;
  if (typeof value.quickTerminalVisible !== 'boolean') return null;

  return {
    version: WORKSPACE_SNAPSHOT_VERSION,
    layoutMode: value.layoutMode as LayoutMode,
    focusedWindowIndex: value.focusedWindowIndex,
    maximizedWindowIndex: value.maximizedWindowIndex,
    windows,
    depthOrder: value.depthOrder.slice(),
    scrollState: { columns, cameraX: value.scrollState.cameraX },
    stageState: {
      order,
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    },
    quickTerminalSessionId: value.quickTerminalSessionId,
    quickTerminalVisible: value.quickTerminalVisible,
  };
}

export function planWorkspaceRecovery(
  snapshotValue: unknown,
  activeIds: readonly number[],
): WorkspaceRecoveryPlan {
  const snapshot = parseWorkspaceSnapshot(snapshotValue);
  const activeSessionIds = new Set(activeIds.filter(isIndex));
  return {
    snapshot,
    activeSessionIds,
    // Once a coherent snapshot exists it is authoritative: a PTY omitted from
    // it may be a pane the user intentionally closed. Only the no-snapshot
    // fallback adopts every backend PTY.
    orphanSessionIds: snapshot
      ? []
      : [...activeSessionIds].sort((a, b) => a - b),
  };
}
