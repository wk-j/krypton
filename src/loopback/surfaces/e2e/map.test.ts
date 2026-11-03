import { describe, expect, it } from 'vitest';

import a from './fixtures/a-valence-push-and-browse.json';
import b from './fixtures/b-loopback-api-authorization.json';
import c from './fixtures/c-control-api-roundtrip.json';
import { buildPins, countsText, DEFAULT_PIN_COLOURS, hexColour, litNodes, mapSource } from './map';
import type { E2eMap, MapCheck, MapPin } from './map';

// Spec 355 test cases A, B and C: real runs (C's FAIL is synthetic) with the
// `at` tags the spec assigns, on the maps the spec draws.

const summary = (pins: readonly MapPin[]): string[] =>
  pins.map((p) => `${p.key} ${p.group}@${p.at} ${countsText(p.counts)} ${p.tone}`);

function idle(map: E2eMap, pins: readonly MapPin[]): string[] {
  const lit = litNodes(map, pins);
  return map.nodes.filter((n) => !lit.has(n.id)).map((n) => n.id);
}

describe('A: valence push-and-browse', () => {
  const map = a.map as E2eMap;
  const { pins, unplaced } = buildPins(a.checks as MapCheck[], map, null);

  it('pins one per (at, group) in order of first appearance', () => {
    expect(summary(pins)).toEqual([
      'P1 serve@w-home ✓×2 pass',
      'P2 push@push ✓×2 pass',
      'P3 report@push ✓×1 pass',
      'P4 report@w-project ✓×1 pass',
      'P5 report@w-run ✓×2 pass',
      'P6 evidence@w-raw ✓×3 pass',
      'P7 restart@store ✓×1 pass',
    ]);
    expect(unplaced).toEqual([0, 1, 2, 3].map((index) => ({ index, reason: null })));
  });

  it('greys only the pages no check reaches; nodes on the way to a pin stay lit', () => {
    expect(idle(map, pins)).toEqual(['w-case', 'w-other']);
  });
});

describe('B: loopback-api-authorization', () => {
  const map = b.map as E2eMap;
  const { pins, unplaced } = buildPins(b.checks as MapCheck[], map, null);

  it('pins every gate and the one handler the positive control reaches', () => {
    expect(summary(pins)).toEqual([
      'P1 control API bearer@control-handlers ✓×1 pass',
      'P2 control API bearer@bearer ✓×6 pass',
      'P3 control API lane capability@lane-capability ✓×3 pass',
      'P4 cross-origin@cors-control ✓×1 pass',
      'P5 cross-origin@cors-loopback ✓×1 pass',
      'P6 cross-origin@json-only ✓×1 pass',
      'P7 capability tokens@capability-token ✓×9 pass',
      'P8 network exposure@bind-control ✓×1 pass',
      'P9 network exposure@bind-loopback ✓×1 pass',
    ]);
    expect(unplaced.map((u) => u.index)).toEqual([0, 1]);
  });

  it('greys the handlers behind gates tested only from the refusing side', () => {
    expect(idle(map, pins)).toEqual(['computer-handlers', 'doc-feedback', 'token-pages']);
  });
});

describe('C: control-api-roundtrip', () => {
  const map = c.map as E2eMap;
  const passRun = { runId: c.pass.runId, checks: c.pass.checks as MapCheck[] };

  it('PASS: the bridge is lit by reach although no check is pinned on it', () => {
    const { pins, unplaced } = buildPins(passRun.checks, map, null);
    expect(summary(pins)).toEqual([
      'P1 capabilities@axum ✓×2 pass',
      'P2 validation@validate ✓×1 pass',
      'P3 frontend round trip@harness-directory ✓×3 pass',
      'P4 events@sse ✓×1 pass',
    ]);
    expect(unplaced).toEqual([{ index: 0, reason: null }]);
    expect(idle(map, pins)).toEqual([]);
  });

  it('FAIL: the failure sits on the bridge, carries the earlier PASS, and HarnessDirectory goes grey', () => {
    const { pins } = buildPins(c.fail.checks as MapCheck[], map, passRun);
    expect(summary(pins)).toEqual([
      'P1 capabilities@axum ✓×2 pass',
      'P2 validation@validate ✓×1 pass',
      'P3 frontend round trip@bridge ✗×3 fail',
      'P4 events@sse ✓×1 pass',
    ]);
    expect(pins.map((p) => (p.before ? `${p.before.runId} ${countsText(p.before.counts)}` : null))).toEqual([
      null,
      null,
      '20261023T172243445Z ✓×3',
      null,
    ]);
    // Following the `reply` edge back to the pinned axum would light it.
    expect(idle(map, pins)).toEqual(['harness-directory']);
  });

  it('draws the same source for the same input, with the failing pin and the grey node classed', () => {
    const { pins } = buildPins(c.fail.checks as MapCheck[], map, passRun);
    const lit = litNodes(map, pins);
    const source = mapSource(map, pins, lit, DEFAULT_PIN_COLOURS);
    expect(mapSource(map, pins, lit, DEFAULT_PIN_COLOURS)).toBe(source);
    expect(source).toContain('p2(["P3 · frontend round trip<br/>✗×3<br/>PASS 20261023T172243445Z: ✓×3"])');
    expect(source).toContain('p2 -.-> n4');
    expect(source).toContain('n5 -->|"acp_control_reply"| n1');
    expect(source).toContain('  class p2 fail\n');
    expect(source).toContain('  class n5 idle\n');
  });
});

describe('placement and source safety', () => {
  const map: E2eMap = {
    direction: 'TB',
    groups: [{ id: 'g', label: 'Group "one"' }],
    nodes: [
      { id: 'who', label: 'caller', group: null, shape: 'actor', source: null },
      { id: 'evil"]; click', label: 'a "b" #c <d> `e`\nf', group: 'g', shape: 'gate', source: null },
      { id: 'wall', label: 'wall', group: null, shape: 'store', source: null },
    ],
    edges: [
      { from: 'who', to: 'evil"]; click', label: null, kind: 'flow' },
      { from: 'who', to: 'wall', label: 'no <entry>', kind: 'refused' },
    ],
  };

  it('lists a check whose at is not on the map as unplaced, with the reason', () => {
    const { pins, unplaced } = buildPins([{ label: 'x', status: 'pass', at: 'gone' }], map, null);
    expect(pins).toEqual([]);
    expect(unplaced).toEqual([{ index: 0, reason: '"gone" is not a node of the map' }]);
  });

  it('encodes every project string and never emits a project id', () => {
    const { pins } = buildPins([{ group: 'g#1', label: 'x', status: 'blocked', at: 'evil"]; click' }], map, null);
    const source = mapSource(map, pins, litNodes(map, pins), DEFAULT_PIN_COLOURS);
    expect(source.startsWith('flowchart TB\n')).toBe(true);
    expect(source).toContain('subgraph g0["Group #quot;one#quot;"]');
    expect(source).toContain('n1{{"a #quot;b#quot; #35;c #lt;d#gt; #96;e#96;<br/>f"}}');
    expect(source).toContain('n2[("wall")]');
    expect(source).toContain('n0 --x|"no #lt;entry#gt;"| n2');
    expect(source).toContain('p0(["P1 · g#35;1<br/>⊘×1"])');
    expect(source).not.toContain('evil');
    expect(source).toContain('  class p0 blocked\n');
    expect(source).toContain('  class n2 idle\n');
  });

  it('turns canvas colours into #rrggbb for classDef', () => {
    expect(hexColour('#0ECB81')).toBe('#0ecb81');
    expect(hexColour('rgba(14, 203, 129, 0.5)')).toBe('#0ecb81');
    expect(hexColour('rgb(252, 213, 53)')).toBe('#fcd535');
    expect(hexColour('rgb(300, 0, 0)')).toBeNull();
    expect(hexColour('red')).toBeNull();
  });
});
