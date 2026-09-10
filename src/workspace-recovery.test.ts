import { describe, expect, it } from 'vitest';

import { LayoutMode } from './types';
import {
  WORKSPACE_SNAPSHOT_VERSION,
  parseWorkspaceSnapshot,
  planWorkspaceRecovery,
  type WorkspaceSnapshot,
} from './workspace-recovery';

function snapshot(): WorkspaceSnapshot {
  return {
    version: WORKSPACE_SNAPSHOT_VERSION,
    layoutMode: LayoutMode.Focus,
    focusedWindowIndex: 0,
    maximizedWindowIndex: null,
    windows: [{
      activeTabIndex: 0,
      pinned: false,
      tabs: [{
        title: 'shell',
        focusedPaneIndex: 0,
        paneTree: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { type: 'leaf', sessionId: 7, contentType: 'terminal' },
          second: { type: 'leaf', sessionId: null, contentType: 'acp_harness' },
        },
      }],
    }],
    depthOrder: [0],
    scrollState: { columns: [], cameraX: 0 },
    stageState: { order: [0], frame: { x: 0, y: 0.05, width: 0.78, height: 0.9 } },
    quickTerminalSessionId: null,
    quickTerminalVisible: false,
  };
}

describe('workspace recovery', () => {
  it('treats a current snapshot as authoritative over unreferenced PTYs', () => {
    const plan = planWorkspaceRecovery(snapshot(), [7, 9]);
    expect(plan.snapshot?.layoutMode).toBe(LayoutMode.Focus);
    expect(plan.activeSessionIds).toEqual(new Set([7, 9]));
    expect(plan.orphanSessionIds).toEqual([]);
  });

  it('rejects snapshots from another schema version without losing active PTYs', () => {
    const invalid = { ...snapshot(), version: 99 };
    const plan = planWorkspaceRecovery(invalid, [4]);
    expect(plan.snapshot).toBeNull();
    expect(plan.orphanSessionIds).toEqual([4]);
  });

  it('rejects malformed pane trees atomically', () => {
    const invalid = snapshot() as unknown as Record<string, unknown>;
    const windows = invalid.windows as Array<Record<string, unknown>>;
    const tabs = windows[0].tabs as Array<Record<string, unknown>>;
    tabs[0].paneTree = { type: 'leaf', sessionId: '7', contentType: 'terminal' };
    expect(parseWorkspaceSnapshot(invalid)).toBeNull();
  });
});
