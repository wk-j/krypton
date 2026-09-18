// spec 215 — lane heads carry the backend logo inside the name span in both
// the active and collapsed branches, so lane identity survives de-focus.
import { describe, expect, it } from 'vitest';

import {
  filteredSlashCommands,
  renderLaneHead,
  renderLaneStats,
  renderSlashPalette,
  slashPaletteVisible,
} from './harness-lane-chrome';
import { backendLogoId } from './harness-lane-identity';
import type { HarnessLane } from './harness-view-types';

function makeLane(overrides: Partial<HarnessLane> = {}): HarnessLane {
  return {
    id: 'lane-1',
    backendId: 'claude',
    displayName: 'Claude-1',
    status: 'idle',
    transcript: [],
    pendingPermissions: [],
    pendingQuestions: [],
    modelName: null,
    modelApplyFailed: false,
    permissionMode: 'normal',
    toolCalls: new Map(),
    ...overrides,
  } as unknown as HarnessLane;
}

describe('renderLaneHead — spec 215 lane identity', () => {
  it('renders the backend logo inside the lane name on a collapsed head', () => {
    const html = renderLaneHead(makeLane(), false, null, null, 0, []);
    expect(html).toContain(`<use href="#${backendLogoId('claude')}"/>`);
    expect(html).toMatch(/class="acp-harness__lane-name"><svg/);
  });

  it('renders the backend logo inside the lane name on the active head', () => {
    const html = renderLaneHead(makeLane({ backendId: 'codex' }), true, null, null, 0, []);
    expect(html).toContain(`<use href="#${backendLogoId('codex')}"/>`);
    expect(html).toMatch(/class="acp-harness__lane-name"><svg/);
  });

  it('keeps the display name escaped next to the logo', () => {
    const html = renderLaneHead(makeLane({ displayName: 'A<b>-1' }), false, null, null, 0, []);
    expect(html).toContain('A&lt;b&gt;-1');
  });
});

describe('renderLaneHead — lane-mail inbox chip', () => {
  it('nests the inbox chip inside the chips group so it cannot stretch as a grid sibling', () => {
    const html = renderLaneHead(makeLane({ status: 'busy' }), true, null, null, 1, []);
    expect(html).toContain('class="acp-harness__lane-inbox"');
    expect(html).toContain('href="#krypton-icon-inbox"');
    expect(html).toContain('1 pending peer message');
    expect(html).toMatch(
      /class="acp-harness__lane-chips"><span class="acp-harness__lane-inbox"/,
    );
    expect(html).not.toMatch(
      /acp-harness__lane-status[\s\S]*acp-harness__lane-inbox[\s\S]*acp-harness__lane-chips/,
    );
  });

  it('omits the inbox chip when nothing is queued', () => {
    const html = renderLaneHead(makeLane(), true, null, null, 0, []);
    expect(html).not.toContain('acp-harness__lane-inbox');
  });

  it('pluralizes the queued-mail tooltip', () => {
    const html = renderLaneHead(makeLane(), false, null, null, 3, []);
    expect(html).toContain('3 pending peer messages');
    expect(html).toMatch(
      /class="acp-harness__lane-chips"><span class="acp-harness__lane-inbox"/,
    );
  });
});

describe('renderLaneHead — no cancel chip', () => {
  it('does not paint a ⌃C cancel hint on a busy active head', () => {
    const html = renderLaneHead(makeLane({ status: 'busy' }), true, null, null, 0, []);
    expect(html).not.toContain('acp-harness__lane-cancel-hint');
    expect(html).not.toContain('⌃C cancel');
    expect(html).not.toContain('force restart');
  });

  it('does not paint a force-restart hint when cancel is unacknowledged', () => {
    const html = renderLaneHead(
      makeLane({ status: 'busy', cancelUnacked: true }),
      true,
      null,
      null,
      0,
      [],
    );
    expect(html).not.toContain('acp-harness__lane-cancel-hint');
    expect(html).not.toContain('force restart');
  });
});

describe('slash palette — Codex skills', () => {
  const availableCommands = [
    { name: 'status', description: 'Display session status.' },
    { name: '$grill-with-docs', description: 'Stress-test a document.' },
    { name: '$grilling', description: 'Stress-test an idea.' },
  ];

  it('matches a Codex skill without requiring the dollar marker', () => {
    const lane = makeLane({ draft: '/grill-with-d', availableCommands });

    expect(slashPaletteVisible(lane)).toBe(true);
    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual([
      '$grill-with-docs',
    ]);
  });

  it('matches a Codex skill when the dollar marker is typed explicitly', () => {
    const lane = makeLane({ draft: '/$grill', availableCommands });

    expect(slashPaletteVisible(lane)).toBe(true);
    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual([
      '$grill-with-docs',
      '$grilling',
    ]);
  });

  it('keeps ordinary ACP slash commands unchanged', () => {
    const lane = makeLane({ draft: '/sta', availableCommands });

    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual(['status']);
  });

  it('renders the advertised Codex skill name unchanged for insertion', () => {
    const lane = makeLane({ draft: '/grill-with-d', availableCommands });

    expect(renderSlashPalette(lane)).toContain('/$grill-with-docs');
  });
});

describe('renderLaneStats — spec 249 prompt-cache hit rate', () => {
  it('shows the coherent last-turn rate and keeps counts in the tooltip', () => {
    const html = renderLaneStats(makeLane({
      sessionId: 'session-123',
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        cachedReadTokens: 90_000,
      },
      lastTurnTokens: { input: 1200, cachedRead: 90_000 },
    }), '/Users/wk/Source/krypton');

    expect(html).toContain('cache 99%');
    expect(html).toContain('this turn 99% · read 90.0k · write 0 · input 1.2k');
    expect(html).not.toContain('cache 90k');
  });

  it('keeps raw counts when the adapter omitted input', () => {
    const html = renderLaneStats(makeLane({
      usage: { outputTokens: 340, cachedReadTokens: 90_000, cachedWriteTokens: 8000 },
      lastTurnTokens: { cachedRead: 90_000 },
    }), null);

    expect(html).toContain('cache 90.0k');
    expect(html).toContain('cache read 90.0k, write 0');
    expect(html).not.toContain('cache 99%');
    expect(html).not.toContain('write 8.0k');
  });

  it('does not revive stale cache counts when the latest turn omitted them', () => {
    const html = renderLaneStats(makeLane({
      usage: { inputTokens: 1200, outputTokens: 340, cachedReadTokens: 90_000 },
      lastTurnTokens: { input: 1200 },
    }), null);

    expect(html).not.toContain('cache ');
  });
});
