import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ToolCall } from './types';
import {
  ACTION_HUD_HIDE_MS,
  actionHudKindFromLabel,
  actionHudMarkup,
  actionHudMustRemount,
  actionHudWellMarkup,
  deriveLiveAction,
  deriveRailLiveActions,
  hasOmittedRailLiveAction,
  liveActionFromPeekTool,
  liveActionFromToolCall,
  liveActionFromToolLabel,
  liveActionSig,
  shouldOmitActionHud,
} from './harness-action-hud';
import { inferToolLabel } from './harness-tool-render';

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

  it('treats a raw shell line as execute', () => {
    expect(actionHudKindFromLabel(
      'cd /Users/wk/Project/tli-anysite-migration; actionlint .github/workflows/docker-publish.yml',
    )).toBe('execute');
    expect(actionHudKindFromLabel('git status')).toBe('execute');
  });
});

describe('deriveLiveAction', () => {
  it('prefers an in-flight tool over thinking so a Read scan does not restart', () => {
    const action = deriveLiveAction({
      activity: { kind: 'thinking', label: '' },
      toolCalls: [call({ kind: 'read', title: 'Read src/a.ts' })],
    });
    expect(action?.kind).toBe('read');
  });

  it('prefers an in-flight tool over writing', () => {
    const action = deriveLiveAction({
      activity: { kind: 'writing', label: '' },
      toolCalls: [call({ kind: 'read', title: 'Read foo' })],
    });
    expect(action?.kind).toBe('read');
  });

  it('falls back to thinking when no tool is in flight', () => {
    const action = deriveLiveAction({
      activity: { kind: 'thinking', label: '' },
      toolCalls: [call({ status: 'completed', kind: 'read', title: 'Read src/a.ts' })],
    });
    expect(action).toMatchObject({ kind: 'thinking', title: 'thinking', subject: null });
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
    expect(action?.subject).toBe('tli-api/…/OnlineService.java');
    expect(action?.detail).toContain('OnlineService.java');
  });

  it('keeps the basename when the parent folder is a long ticket slug', () => {
    const action = deriveLiveAction({
      activity: null,
      toolCalls: [call({
        kind: 'edit',
        title: 'Edit review.md',
        locations: [{
          path: '/Users/wk/Source/krypton/docs/analysis/krypton/1/2026-09-02-1183-security-401-403-log-attribution-review/review.md',
        }],
      })],
    });
    expect(action?.subject).toBe('Source/…/review.md');
    expect(action?.subject).not.toContain('2026-09-02');
    expect(action?.detail).toContain('review.md');
  });

  it('abbreviates a project-relative ticket path to docs/…/basename', () => {
    const action = liveActionFromToolCall(call({
      kind: 'edit',
      title: 'Edit review.md',
      locations: [{
        path: 'docs/analysis/krypton/1/2026-09-02-1183-security-401-403-log-attribution-review/review.md',
      }],
    }));
    expect(action.subject).toBe('docs/…/review.md');
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
    expect(action).toMatchObject({
      kind: 'execute',
      title: 'execute',
      subject: 'cargo test',
    });
  });

  it('keeps a title-only shell line out of the kind label', () => {
    const cmd = [
      'cd /Users/wk/Project/tli-anysite-migration;',
      'actionlint .github/workflows/docker-publish.yml',
      '.github/workflows/trivy-scan.yml;',
      'echo "actionlint"',
    ].join('\n');
    const action = liveActionFromToolCall(call({
      kind: 'other',
      title: cmd,
    }));
    expect(action.kind).toBe('execute');
    expect(action.title).toBe('execute');
    expect(action.subject).toBe(
      'cd /Users/wk/Project/tli-anysite-migration; actionlint .github/workflows/docker-publish.yml .github/workflows/trivy-scan.yml; echo "actionlint"',
    );
    expect(action.subject).not.toMatch(/\n/);
    expect(action.detail).toContain('actionlint');
  });
});

describe('liveActionFromToolLabel', () => {
  it('does not uppercase a multiline command as the kind title', () => {
    const action = liveActionFromToolLabel(
      'cd /tmp/foo; actionlint a.yml\nb.yml',
    );
    expect(action).toMatchObject({ kind: 'execute', title: 'execute' });
    expect(action.subject).toBe('cd /tmp/foo; actionlint a.yml b.yml');
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
      laneId: 'a',
      thoughtLaneId: 'a',
      thoughtLive: true,
    })).toBe(true);
  });

  it('keeps thinking when the thought slot is for another lane or sealed', () => {
    expect(shouldOmitActionHud(thinking, {
      laneId: 'a',
      thoughtLaneId: 'b',
      thoughtLive: true,
    })).toBe(false);
    expect(shouldOmitActionHud(thinking, {
      laneId: 'a',
      thoughtLaneId: 'a',
      thoughtLive: false,
    })).toBe(false);
  });

  it('never omits writing, even when thought is showing', () => {
    expect(shouldOmitActionHud(writing, {
      laneId: 'a',
      thoughtLaneId: 'a',
      thoughtLive: true,
    })).toBe(false);
  });

  it('omits a null action', () => {
    expect(shouldOmitActionHud(null, {
      laneId: 'a',
      thoughtLaneId: null,
      thoughtLive: false,
    })).toBe(true);
  });
});

describe('ACTION_HUD_HIDE_MS', () => {
  it('holds empty frames past the 180ms entrance remount', () => {
    expect(ACTION_HUD_HIDE_MS).toBe(2000);
  });
});

describe('deriveRailLiveActions', () => {
  function lane(over: {
    id: string;
    displayName?: string;
    active?: boolean;
    activity?: { kind: 'tool' | 'thinking' | 'writing'; label: string } | null;
    toolCalls?: ToolCall[];
    live?: boolean;
  }) {
    return {
      id: over.id,
      displayName: over.displayName ?? over.id,
      active: over.active ?? false,
      ...(over.live === undefined ? {} : { live: over.live }),
      activity: 'activity' in over ? over.activity ?? null : { kind: 'tool' as const, label: 'Edit src/a.ts' },
      toolCalls: over.toolCalls ?? [call({
        kind: 'edit',
        title: 'Edit src/a.ts',
        locations: [{ path: 'src/a.ts' }],
      })],
    };
  }

  it('lists every busy lane in harness order', () => {
    const rows = deriveRailLiveActions({
      lanes: [
        lane({ id: 'grok', displayName: 'Grok-1', active: true }),
        lane({
          id: 'claude',
          displayName: 'Claude-1',
          toolCalls: [call({ kind: 'execute', title: 'cd /tmp; actionlint a.yml' })],
        }),
      ],
      thoughtLaneId: null,
      thoughtLive: false,
      peekHudLaneId: null,
    });
    expect(rows.map((row) => row.laneId)).toEqual(['grok', 'claude']);
    expect(rows[0]?.action.kind).toBe('edit');
    expect(rows[1]?.action.kind).toBe('execute');
    expect(rows[0]?.active).toBe(true);
  });

  it('skips a peeked lane that already embeds the HUD', () => {
    const rows = deriveRailLiveActions({
      lanes: [
        lane({ id: 'grok', active: true }),
        lane({ id: 'claude' }),
      ],
      thoughtLaneId: null,
      thoughtLive: false,
      peekHudLaneId: 'claude',
    });
    expect(rows.map((row) => row.laneId)).toEqual(['grok']);
  });

  it('omits only the lane whose thought is already live', () => {
    const rows = deriveRailLiveActions({
      lanes: [
        lane({
          id: 'grok',
          active: true,
          activity: { kind: 'thinking', label: '' },
          toolCalls: [],
        }),
        lane({ id: 'claude' }),
      ],
      thoughtLaneId: 'grok',
      thoughtLive: true,
      peekHudLaneId: null,
    });
    expect(rows.map((row) => row.laneId)).toEqual(['claude']);
  });

  it('drops idle lanes', () => {
    expect(deriveRailLiveActions({
      lanes: [lane({ id: 'idle', activity: null, toolCalls: [] })],
      thoughtLaneId: null,
      thoughtLive: false,
      peekHudLaneId: null,
    })).toEqual([]);
  });

  it('drops a lane whose turn ended even when a tool call is still in_progress (rev 2)', () => {
    // Background terminal the adapter never closed: toolCalls keeps an
    // in_progress execute forever. Lane status wins — no card, no omitted flag,
    // so the 2s hide timer is allowed to run.
    const stale = lane({
      id: 'claude',
      activity: null,
      toolCalls: [call({ kind: 'execute', title: 'Terminal' })],
      live: false,
    });
    const input = { lanes: [stale], thoughtLaneId: null, thoughtLive: false, peekHudLaneId: null };
    expect(deriveRailLiveActions(input)).toEqual([]);
    expect(hasOmittedRailLiveAction(input)).toBe(false);
    // The same lane while live still paints its card.
    expect(deriveRailLiveActions({ ...input, lanes: [{ ...stale, live: true }] }).map((row) => row.laneId))
      .toEqual(['claude']);
    // Callers that do not pass `live` keep the pre-rev-2 behaviour.
    expect(deriveRailLiveActions({ ...input, lanes: [lane({ id: 'legacy', toolCalls: [call({ kind: 'execute', title: 'x' })] })] }))
      .toHaveLength(1);
  });

  it('flags omitted thinking so the hide timer does not clear the last tool card', () => {
    const input = {
      lanes: [lane({
        id: 'grok',
        active: true,
        activity: { kind: 'thinking' as const, label: '' },
        toolCalls: [],
      })],
      thoughtLaneId: 'grok',
      thoughtLive: true,
      peekHudLaneId: null,
    };
    expect(deriveRailLiveActions(input)).toEqual([]);
    expect(hasOmittedRailLiveAction(input)).toBe(true);
    expect(hasOmittedRailLiveAction({
      lanes: [lane({ id: 'idle', activity: null, toolCalls: [] })],
      thoughtLaneId: null,
      thoughtLive: false,
      peekHudLaneId: null,
    })).toBe(false);
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
    expect(html).toMatch(/acp-harness__action-subject"><span>src\/acp\/types\.ts<\/span>/);
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

  it('puts a long command in the subject, not the kind label', () => {
    const html = actionHudMarkup(liveActionFromToolCall(call({
      kind: 'other',
      title: 'cd /tmp; actionlint a.yml b.yml',
    })), 'rail');
    expect(html).toMatch(/acp-harness__action-kind">execute</);
    expect(html).toContain('acp-harness__action-subject');
    expect(html).toContain('cd /tmp; actionlint a.yml b.yml');
    expect(html).toContain('data-kind="execute"');
  });

  it('labels a multi-lane card with the lane name, not in the kind', () => {
    const html = actionHudMarkup(
      liveActionFromToolCall(call({ kind: 'edit', title: 'Edit a.ts', locations: [{ path: 'a.ts' }] })),
      { owner: 'rail', laneId: 'claude', laneName: 'Claude-1' },
    );
    expect(html).toContain('data-lane-id="claude"');
    expect(html).toContain('data-labeled="1"');
    expect(html).toContain('acp-harness__action-lane');
    expect(html).toContain('Claude-1');
    expect(html).toMatch(/acp-harness__action-kind">edit</);
  });
});

describe('liveActionSig', () => {
  it('changes when the subject changes so the HUD can detect a new action', () => {
    expect(liveActionSig('edit', 'edit', 'a.ts')).not.toBe(liveActionSig('edit', 'edit', 'b.ts'));
  });
});

describe('actionHudMustRemount', () => {
  it('stays mounted across a new execute / kind so the entrance does not replay', () => {
    const el = { dataset: { labeled: '1' } };
    expect(actionHudMustRemount(el, true)).toBe(false);
    expect(actionHudMustRemount({ dataset: {} }, false)).toBe(false);
  });

  it('remounts only when labeled chrome appears or disappears', () => {
    expect(actionHudMustRemount({ dataset: {} }, true)).toBe(true);
    expect(actionHudMustRemount({ dataset: { labeled: '1' } }, false)).toBe(true);
  });
});

describe('actionHudWellMarkup', () => {
  it('swaps the instrument per kind', () => {
    expect(actionHudWellMarkup('execute')).toContain('acp-harness__action-fx-pty');
    expect(actionHudWellMarkup('execute')).toContain('href="#krypton-action-execute"');
    expect(actionHudWellMarkup('execute')).not.toContain('acp-harness__action-hex');
    expect(actionHudWellMarkup('edit')).toContain('acp-harness__action-fx-head');
    expect(actionHudWellMarkup('edit')).not.toContain('acp-harness__action-fx-pty');
    expect(actionHudWellMarkup('edit')).toContain('viewBox="0 0 16 16"');
    expect(actionHudWellMarkup('edit')).toContain('width="16"');
  });
});

describe('inferToolLabel shell titles', () => {
  it('classifies a title-only cd chain as execute', () => {
    expect(inferToolLabel(call({
      kind: 'other',
      title: 'cd /Users/wk/Project/tli-anysite-migration; actionlint a.yml',
    }))).toBe('execute');
  });

  it('still maps cat / edit titles to their ACP kinds', () => {
    expect(inferToolLabel(call({ kind: 'other', title: 'cat src/a.ts' }))).toBe('read');
    expect(inferToolLabel(call({ kind: 'other', title: 'Edit src/a.ts' }))).toBe('edit');
  });
});

describe('action HUD CSS', () => {
  it('keeps kind and subject to one ellipsized line', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../styles/acp-harness.css'),
      'utf8',
    );
    expect(css).toMatch(/\.acp-harness__action-kind\s*\{[\s\S]*?white-space:\s*nowrap/);
    expect(css).toMatch(
      /\.acp-harness__action-kind\s*\{[\s\S]*?font-size:\s*var\(--krypton-chrome-font-size/,
    );
    expect(css).toMatch(/\.acp-harness__action-subject\s*\{[\s\S]*?white-space:\s*nowrap/);
    expect(css).toMatch(/\.acp-harness__action-subject\s*\{[\s\S]*?direction:\s*rtl/);
    expect(css).toMatch(/\.acp-harness__action-copy\s*\{[\s\S]*?min-width:\s*0/);
    expect(css).toMatch(/\.acp-harness__action-hud\s*\{[\s\S]*?flex-direction:\s*row/);
    expect(css).toMatch(/\.acp-harness__action-well\s*\{[\s\S]*?flex:\s*0 0 28px/);
    expect(css).toMatch(/\[data-slot="action"\]\s*\{[\s\S]*?max-height:\s*min\(240px/);
    expect(css).toMatch(/\.acp-harness__action-lane\s*\{/);
    expect(css).toMatch(/\.acp-harness__action-fx-pty\s*\{[\s\S]*?animation:\s*acp-action-caret/);
    expect(css).not.toMatch(/\.acp-harness__action-hex\b/);
  });
});
