import { describe, expect, it } from 'vitest';

import { TOOL_CALL_RETENTION_CHAR_LIMIT, compactToolCallForRetention } from './adapters/tool';
import type { ToolView } from './adapters/types';
import {
  HARNESS_TRANSCRIPT_CAP,
  appendBoundedTranscriptItem,
  clearToolTranscriptRetention,
  isOrphanToolCallUpdate,
  type ToolRetentionState,
} from './harness-tool-retention';
import type { HarnessTranscriptItem } from './harness-view-types';

/** Only membership matters to retention; the view's fields are not read. */
function view(id: string, status: ToolView['status']): ToolView {
  return { id, status } as ToolView;
}

function retentionState(): ToolRetentionState {
  return {
    transcript: [],
    toolViews: new Map(),
    toolTranscriptIds: new Map(),
    seenTranscriptIds: new Set(),
    activeToolCount: 0,
  };
}

function completedTool(index: number): HarnessTranscriptItem {
  return {
    id: `row-${index}`,
    kind: 'tool',
    text: `tool ${index}`,
    status: 'completed',
    toolStartedAt: index,
    toolEndedAt: index + 1,
  };
}

function addCompletedTool(lane: ToolRetentionState, index: number): void {
  const callId = `call-${index}`;
  const item = completedTool(index);
  lane.toolViews.set(callId, view(callId, 'completed'));
  lane.toolTranscriptIds.set(callId, item.id);
  appendBoundedTranscriptItem(lane, item);
}

describe('ACP Harness tool-call retention', () => {
  it('keeps completed tool state bounded after more than 300 distinct calls', () => {
    const lane = retentionState();
    for (let i = 0; i < HARNESS_TRANSCRIPT_CAP + 325; i += 1) {
      addCompletedTool(lane, i);
    }

    expect(lane.transcript).toHaveLength(HARNESS_TRANSCRIPT_CAP);
    expect(lane.toolViews).toHaveLength(HARNESS_TRANSCRIPT_CAP);
    expect(lane.toolTranscriptIds).toHaveLength(HARNESS_TRANSCRIPT_CAP);
    expect(isOrphanToolCallUpdate(lane, 'call-0')).toBe(true);
    expect(isOrphanToolCallUpdate(lane, 'call-325')).toBe(false);
  });

  it('retains an active tool through transcript pressure, then prunes it after completion', () => {
    const lane = retentionState();
    const active: HarnessTranscriptItem = {
      id: 'active-row',
      kind: 'tool',
      text: 'active',
      status: 'in_progress',
      toolStartedAt: 1,
    };
    lane.activeToolCount = 1;
    lane.toolViews.set('active-call', view('active-call', 'in_progress'));
    lane.toolTranscriptIds.set('active-call', active.id);
    appendBoundedTranscriptItem(lane, active);
    for (let i = 0; i < HARNESS_TRANSCRIPT_CAP; i += 1) {
      appendBoundedTranscriptItem(lane, { id: `system-${i}`, kind: 'system', text: '' });
    }

    expect(lane.toolViews.has('active-call')).toBe(true);
    expect(isOrphanToolCallUpdate(lane, 'active-call')).toBe(false);
    expect(lane.activeToolCount).toBe(0);

    const completed = completedTool(999);
    lane.toolViews.set('active-call', view('active-call', 'completed'));
    lane.toolTranscriptIds.set('active-call', completed.id);
    appendBoundedTranscriptItem(lane, completed);
    for (let i = 0; i < HARNESS_TRANSCRIPT_CAP; i += 1) {
      appendBoundedTranscriptItem(lane, { id: `tail-${i}`, kind: 'system', text: '' });
    }

    expect(lane.toolViews.has('active-call')).toBe(false);
    expect(isOrphanToolCallUpdate(lane, 'active-call')).toBe(true);
  });

  it('clears transcript, tool maps, and render ids on reset/dispose', () => {
    const lane = retentionState();
    addCompletedTool(lane, 1);
    lane.seenTranscriptIds.add('row-1');
    lane.activeToolCount = 1;

    clearToolTranscriptRetention(lane);

    expect(lane.transcript).toHaveLength(0);
    expect(lane.toolViews.size).toBe(0);
    expect(lane.toolTranscriptIds.size).toBe(0);
    expect(lane.seenTranscriptIds.size).toBe(0);
    expect(lane.activeToolCount).toBe(0);
  });

  it('bounds retained raw input, raw output, content, and diff data', () => {
    const huge = 'x'.repeat(TOOL_CALL_RETENTION_CHAR_LIMIT * 4);
    const compact = compactToolCallForRetention({
      toolCallId: 'huge',
      title: huge,
      status: 'in_progress',
      rawInput: { command: 'run', body: huge },
      rawOutput: { stdout: huge },
      content: Array.from({ length: 20 }, (_, index) => ({
        type: 'diff' as const,
        path: `file-${index}.ts`,
        oldText: huge,
        newText: huge,
      })),
    });
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(TOOL_CALL_RETENTION_CHAR_LIMIT);
  });
});
