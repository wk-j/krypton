import { describe, expect, it } from 'vitest';

import a from './fixtures/a-valence-push-and-browse.json';
import b from './fixtures/b-loopback-api-authorization.json';
import c from './fixtures/c-control-api-roundtrip.json';
import { layoutMap } from '../../kit';
import { buildPins, countsText, countsWords, layoutPins, litNodes, pinLook, problemsText } from './map';
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

  it('hands the layout valence-style pins: group, failed count, earlier PASS in the title', () => {
    const { pins } = buildPins(c.fail.checks as MapCheck[], map, passRun);
    const laid = layoutPins(pins);
    expect(laid[2]).toEqual({
      key: 'P3',
      at: 'bridge',
      label: 'frontend round trip',
      problems: '3 failed',
      status: 'fail',
      title: 'P3 frontend round trip: 3 failed\nEarlier PASS 20261023T172243445Z: 3 passed',
    });
    expect(pinLook(laid[2].status)).toEqual({ tone: 'del', strong: true });
    const drawing = layoutMap(map, laid, litNodes(map, pins));
    expect(layoutMap(map, laid, litNodes(map, pins))).toStrictEqual(drawing);
    const p3 = drawing.pins.find((p) => p.key === 'P3');
    expect(p3?.at).toBe('bridge');
    expect(p3?.texts.map((t) => [t.part, t.text])).toEqual([['key', 'P3'], ['label', 'frontend round trip'], ['problems', '3 failed']]);
    expect(drawing.nodes.filter((n) => !n.lit).map((n) => n.id)).toEqual(['harness-directory']);
    expect(drawing.edges.some((e) => e.from === 'harness-directory' && e.to === 'axum' && e.kind === 'reply')).toBe(true);
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

  it('keeps project strings as plain text for the drawing (React renders them as text nodes)', () => {
    const { pins } = buildPins([{ group: 'g#1', label: 'x', status: 'blocked', at: 'evil"]; click' }], map, null);
    const drawing = layoutMap(map, layoutPins(pins), litNodes(map, pins));
    expect(drawing.groups[0].label.text).toBe('Group "one"');
    expect(drawing.nodes.find((n) => n.id === 'evil"]; click')?.lines.map((l) => l.text)).toEqual(['a "b" #c <d> `e`', 'f']);
    expect(drawing.pins[0].texts.map((t) => t.text)).toEqual(['P1', 'g#1', '1 blocked']);
    expect(drawing.edges.find((e) => e.kind === 'refused')?.label.map((l) => l.text)).toEqual(['no <entry>']);
    expect(drawing.nodes.find((n) => n.id === 'wall')?.lit).toBe(false);
  });

  it("names counts in valence's words", () => {
    const counts = { pass: 2, fail: 1, blocked: 2, skip: 0, info: 1 };
    expect(countsWords(counts)).toBe('2 passed, 1 failed, 2 blocked, 1 info');
    expect(problemsText(counts)).toBe('1 failed, 2 blocked');
    expect(problemsText({ pass: 3, fail: 0, blocked: 0, skip: 1, info: 0 })).toBe('');
    expect(pinLook('skip')).toEqual({ tone: 'muted', dashed: true });
    expect(pinLook('pass')).toEqual({ tone: 'add' });
  });
});
