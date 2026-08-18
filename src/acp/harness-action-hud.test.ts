import { describe, expect, it } from 'vitest';

import type { ToolCall } from './types';
import {
  actionHudKindFromLabel,
  actionHudMarkup,
  deriveLiveAction,
  liveActionFromPeekTool,
  liveActionFromToolCall,
  liveActionFromToolLabel,
  liveActionSig,
  shouldOmitActionHud,
} from './harness-action-hud';

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: 't1',
    status: 'in_progress',
    ...over,
  };
}

describe('actionHudKindFromLabel', () => {
  it('maps ACP kinds and common title verbs', () => {
    expect(actionHudKindFromLabel('edit')).toBe('edit');
    expect(actionHudKindFromLabel('Write src/a.ts')).toBe('edit');
    expect(actionHudKindFromLabel('read')).toBe('read');
    expect(actionHudKindFromLabel('rg pattern')).toBe('search');
    expect(actionHudKindFromLabel('execute')).toBe('execute');
    expect(actionHudKindFromLabel('bash cargo test')).toBe('execute');
    expect(actionHudKindFromLabel('delete')).toBe('delete');
    expect(actionHudKindFromLabel('move')).toBe('move');
    expect(actionHudKindFromLabel('fetch')).toBe('fetch');
    expect(actionHudKindFromLabel('think')).toBe('thinking');
  });

  it('falls through to other for MCP / unknown names', () => {
    expect(actionHudKindFromLabel('memory_recall')).toBe('other');
    expect(actionHudKindFromLabel('')).toBe('other');
  });
});

describe('deriveLiveAction', () => {
  it('prefers thinking over an in-flight tool', () => {
    const action = deriveLiveAction({
      activity: { kind: 'thinking', label: '' },
      toolCalls: [call({ kind: 'edit', title: 'Edit src/a.ts' })],
    });
    expect(action).toMatchObject({ kind: 'thinking', title: 'thinking', subject: null });
  });

  it('prefers writing over an in-flight tool', () => {
    const action = deriveLiveAction({
      activity: { kind: 'writing', label: '' },
      toolCalls: [call({ kind: 'read', title: 'Read foo' })],
    });
    expect(action?.kind).toBe('writing');
  });

  it('picks the oldest pending/in_progress tool and abbreviates its path', () => {
    const action = deriveLiveAction({
      activity: { kind: 'tool', label: 'Edit later' },
      toolCalls: [
        call({
          toolCallId: 'old',
          kind: 'edit',
          title: 'Edit OnlineService.java',
          locations: [{ path: '/Users/wk/tli-api/src/main/java/com/bc/OnlineService.java' }],
        }),
        call({ toolCallId: 'new', kind: 'read', title: 'Read other' }),
      ],
    });
    expect(action?.kind).toBe('edit');
    expect(action?.title).toBe('edit');
    expect(action?.subject).toContain('OnlineService.java');
    expect(action?.detail).toContain('OnlineService.java');
  });

  it('skips completed tools and falls back to the lingering activity label', () => {
    const action = deriveLiveAction({
      activity: { kind: 'tool', label: 'Edit src/done.ts' },
      toolCalls: [call({ status: 'completed', kind: 'edit', title: 'Edit src/done.ts' })],
    });
    expect(action).toMatchObject({ kind: 'edit', title: 'edit' });
    expect(action?.subject).toContain('done.ts');
  });

  it('returns null when the lane is idle', () => {
    expect(deriveLiveAction({ activity: null, toolCalls: [] })).toBeNull();
  });

  it('accepts a Map of tool calls', () => {
    const tools = new Map<string, ToolCall>();
    tools.set('t1', call({ kind: 'search', title: 'Search deriveLiveAction' }));
    expect(deriveLiveAction({ activity: null, toolCalls: tools })?.kind).toBe('search');
  });
});

describe('liveActionFromToolCall', () => {
  it('classifies execute from a command-shaped rawInput even when kind is other', () => {
    const action = liveActionFromToolCall(call({
      kind: 'other',
      title: 'tool',
      rawInput: { command: 'cargo test' },
    }));
    expect(action.kind).toBe('execute');
  });
});

describe('liveActionFromPeekTool', () => {
  it('rebuilds a HUD action from the peek snapshot tool row', () => {
    const action = liveActionFromPeekTool({ name: 'edit', subject: 'src/acp/types.ts' });
    expect(action).toMatchObject({ kind: 'edit', title: 'edit', subject: 'src/acp/types.ts' });
  });
});

describe('shouldOmitActionHud', () => {
  const thinking = deriveLiveAction({ activity: { kind: 'thinking', label: '' }, toolCalls: [] });
  const writing = deriveLiveAction({ activity: { kind: 'writing', label: '' }, toolCalls: [] });

  it('omits thinking when the thought slot is already live for this lane', () => {
    expect(shouldOmitActionHud(thinking, {
      activeLaneId: 'a',
      thoughtLaneId: 'a',
      thoughtLive: true,
    })).toBe(true);
  });

  it('keeps thinking when the thought slot is for another lane or sealed', () => {
    expect(shouldOmitActionHud(thinking, {
      activeLaneId: 'a',
      thoughtLaneId: 'b',
      thoughtLive: true,
    })).toBe(false);
    expect(shouldOmitActionHud(thinking, {
      activeLaneId: 'a',
      thoughtLaneId: 'a',
      thoughtLive: false,
    })).toBe(false);
  });

  it('never omits writing, even when thought is showing', () => {
    expect(shouldOmitActionHud(writing, {
      activeLaneId: 'a',
      thoughtLaneId: 'a',
      thoughtLive: true,
    })).toBe(false);
  });

  it('omits a null action', () => {
    expect(shouldOmitActionHud(null, {
      activeLaneId: 'a',
      thoughtLaneId: null,
      thoughtLive: false,
    })).toBe(true);
  });
});

describe('actionHudMarkup', () => {
  it('emits a status card with kind, subject, and well', () => {
    const action = liveActionFromToolCall(call({
      kind: 'edit',
      title: 'Edit src/acp/types.ts',
      locations: [{ path: 'src/acp/types.ts' }],
    }));
    const html = actionHudMarkup(action, 'rail');
    expect(html).toContain('data-kind="edit"');
    expect(html).toContain('data-owner="rail"');
    expect(html).toContain('data-sig="edit|edit|src/acp/types.ts"');
    expect(html).toContain('role="status"');
    expect(html).toContain('acp-harness__action-kind');
    expect(html).toContain('src/acp/types.ts');
    expect(html).toContain('href="#krypton-action-edit"');
    expect(html).toContain('acp-harness__action-fx-head');
    expect(html).not.toContain('border-left');
  });

  it('omits the subject line for thinking', () => {
    const html = actionHudMarkup(deriveLiveAction({
      activity: { kind: 'thinking', label: '' },
      toolCalls: [],
    })!, 'rail');
    expect(html).not.toContain('acp-harness__action-subject');
    expect(html).toContain('data-kind="thinking"');
  });

  it('escapes a hostile title', () => {
    const html = actionHudMarkup(liveActionFromToolLabel('<img src=x>'), 'peek');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
  });
});

describe('liveActionSig', () => {
  it('changes when the subject changes so the card remounts', () => {
    expect(liveActionSig('edit', 'edit', 'a.ts')).not.toBe(liveActionSig('edit', 'edit', 'b.ts'));
  });
});
