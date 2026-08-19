// spec 215 — lane heads carry the backend logo inside the name span in both
// the active and collapsed branches, so lane identity survives de-focus.
import { describe, expect, it } from 'vitest';

import { renderLaneHead } from './harness-lane-chrome';
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
