import { describe, expect, it } from 'vitest';

import type { E2eMap } from '../e2e/map';
import {
  bugPath,
  focus,
  frame,
  gapText,
  isPathEdge,
  pinStatus,
  rootLevel,
  stateLine,
  submap,
  trailPins,
  trailStatus,
} from './model';
import type { TrailPayload, TrailStep } from './types';
import fixture from './fixtures/1364.json';

// Spec 400: bcircle/tli-api-service#1364 analysed at b420e805, on the real
// `e2e/maps/tli-online.toml` (26 nodes), before any code was edited.

const trail = fixture as unknown as TrailPayload;
const map = trail.map.map as E2eMap;
const LAST = trail.steps.length - 1;

const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

describe('frame', () => {
  it('keeps the last state per node, pins every step and lists the off-map ones', () => {
    const f = frame(trail, LAST);
    expect(f.upTo).toBe(9);
    expect(Object.fromEntries(f.states)).toEqual({
      alfresco: 'symptom',
      'dim-policy': 'ruled-out',
      api003: 'root-cause',
      online006: 'root-cause',
    });
    expect(Object.fromEntries(f.pins)).toEqual({
      alfresco: ['1', '?10'],
      'dim-policy': ['3'],
      api003: ['4', '5', '?7', '8'],
      online006: ['6', '9'],
    });
    expect(f.unplaced).toEqual([1]);
    expect(f.symptoms).toEqual(['alfresco']);
    expect(sorted(f.roots)).toEqual(['api003', 'online006']);
    expect(f.hasRootCause).toBe(true);
    expect(Object.fromEntries(f.levels)).toEqual({ api003: 'cited', online006: 'cited' });
    expect(f.openDecisions).toBe(2);
  });

  it('moves with the step: symptom only, then a suspect, then the root causes', () => {
    const first = frame(trail, 0);
    expect(Object.fromEntries(first.states)).toEqual({ alfresco: 'symptom' });
    expect(first.roots).toEqual([]);
    expect(trailStatus(first).label).toBe('investigating');
    expect(gapText(trail, first)).toBeNull();

    const suspect = frame(trail, 3);
    expect(suspect.states.get('api003')).toBe('suspect');
    expect(suspect.roots).toEqual(['api003']);
    expect(suspect.hasRootCause).toBe(false);
    expect(trailStatus(suspect).label).toBe('suspect');
    expect(sorted(bugPath(map, suspect))).toEqual(['alfresco', 'api003']);

    const cause = frame(trail, 4);
    expect(cause.states.get('api003')).toBe('root-cause');
    expect(trailStatus(cause)).toEqual({ label: 'root cause cited', tone: 'del' });
    expect(cause.openDecisions).toBe(0);
  });

  it('clamps out-of-range steps', () => {
    expect(frame(trail, 99).upTo).toBe(LAST);
    expect(frame(trail, -5).upTo).toBe(-1);
    expect(frame(trail, -5).pins.size).toBe(0);
  });
});

describe('bug path and focus', () => {
  it('lights the flow path between the symptom and the root causes', () => {
    const f = frame(trail, LAST);
    expect(sorted(bugPath(map, f))).toEqual(['alfresco', 'api003', 'online006']);
  });

  it('shows the pinned and path nodes and the actors feeding them: 6 of 26', () => {
    const f = frame(trail, LAST);
    const shown = focus(map, f, bugPath(map, f));
    expect(map.nodes).toHaveLength(26);
    expect(sorted(shown)).toEqual(['alfresco', 'api003', 'channel', 'dim-policy', 'online006', 'staff']);
  });

  it('follows flow edges only, in either direction', () => {
    const small: E2eMap = {
      direction: 'LR',
      groups: [],
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, group: null, shape: 'box', source: null })),
      edges: [
        { from: 'a', to: 'b', label: null, kind: 'flow' },
        { from: 'b', to: 'c', label: null, kind: 'flow' },
        { from: 'c', to: 'a', label: null, kind: 'reply' },
        { from: 'c', to: 'd', label: null, kind: 'flow' },
      ],
    };
    const payload: TrailPayload = {
      ...trail,
      map: { ...trail.map, map: small },
      steps: [
        { ...trail.steps[0], at: 'a', kind: 'symptom', evidence: [] },
        { ...trail.steps[4], at: 'c', kind: 'root-cause' },
      ],
    };
    // Request runs a → b → c and breaks at c: the path is the request's route.
    expect(sorted(bugPath(small, frame(payload, 1)))).toEqual(['a', 'b', 'c']);
    // Corrupt data upstream at a shows downstream at c: the same route, other direction.
    const reversed: TrailPayload = {
      ...payload,
      steps: [
        { ...payload.steps[0], at: 'c' },
        { ...payload.steps[1], at: 'a' },
      ],
    };
    expect(sorted(bugPath(small, frame(reversed, 1)))).toEqual(['a', 'b', 'c']);
  });
});

describe('root level', () => {
  const root = trail.steps[4];
  const repro = { type: 'repro' as const, fields: { id: 'r' }, detail: null, outputTail: null };

  it('is cited when every cite/commit/observed check is ok', () => {
    expect(rootLevel(root)).toBe('cited');
  });

  it('is claimed with a failing check or no checked evidence at all', () => {
    const mismatch: TrailStep = { ...root, evidence: [{ ...root.evidence[0], status: 'mismatch' }] };
    expect(rootLevel(mismatch)).toBe('claimed');
    expect(rootLevel({ ...root, evidence: [] })).toBe('claimed');
    expect(rootLevel({ ...root, evidence: [{ ...repro, status: 'unexpected' }, ...root.evidence] })).toBe('claimed');
  });

  it('is reproduced by a run that ended as expected; a pending repro does not lower it', () => {
    expect(rootLevel({ ...root, evidence: [...root.evidence, { ...repro, status: 'reproduced' }] })).toBe('reproduced');
    expect(rootLevel({ ...root, evidence: [...root.evidence, { ...repro, status: 'not-run' }] })).toBe('cited');
  });

  it('turns the pill and closes the gap once a root is reproduced', () => {
    const steps = trail.steps.map((step, i) =>
      i === 4 ? { ...step, evidence: [...step.evidence, { ...repro, status: 'reproduced' as const }] } : step,
    );
    const f = frame({ ...trail, steps }, LAST);
    expect(trailStatus(f).label).toBe('root cause reproduced');
    expect(gapText(trail, f)).toBeNull();
    expect(f.levels.get('api003')).toBe('reproduced');
  });
});

describe('page text', () => {
  it('names the gap and the analysis snapshot', () => {
    const f = frame(trail, LAST);
    expect(trailStatus(f).label).toBe('root cause cited');
    expect(gapText(trail, f)).toBe('not reproduced on b420e805');
    expect(stateLine(trail)).toEqual({ text: 'analysis @ b420e805 · tree clean at start', warn: false });
    expect(stateLine({ ...trail, state: { start: null, check: null } }).text).toBe('analysis @ b420e805 · start snapshot missing');
    const changed = { ...trail.state.start!, changed: ['src/a.ts', 'HEAD moved'] };
    expect(stateLine({ ...trail, state: { start: trail.state.start, check: changed } })).toEqual({
      text: 'analysis @ b420e805 · changed during analysis (2)',
      warn: true,
    });
  });
});

describe('what the map shows', () => {
  const f = frame(trail, LAST);
  const path = bugPath(map, f);

  it('pins every placed step on its node in step order, skipping the off-map one', () => {
    const pins = trailPins(trail);
    expect(pins.map((p) => `${p.at} ${p.key} ${p.label} ${p.status}`)).toEqual([
      'alfresco 1 symptom symptom',
      'dim-policy 3 ruled out ruled-out',
      'api003 4 suspect suspect',
      'api003 5 root cause root-cited',
      'online006 6 root cause root-cited',
      'api003 ?7 decision decision-open',
      'api003 8 plan plan',
      'online006 9 plan plan',
      'alfresco ?10 decision decision-open',
    ]);
    expect(pins[0].title.startsWith('1 symptom: ')).toBe(true);
  });

  it('names how far a root cause is proven and whether a decision is answered', () => {
    const root = trail.steps[4] as TrailStep;
    expect(pinStatus(root)).toBe('root-cited');
    const reproduced = { ...root, evidence: [...root.evidence, { type: 'repro', fields: { id: 'r' }, status: 'reproduced', detail: null, outputTail: null }] } as TrailStep;
    expect(pinStatus(reproduced)).toBe('root-reproduced');
    expect(pinStatus({ ...(trail.steps[6] as TrailStep), answer: 'yes' })).toBe('decision-answered');
  });

  it('cuts the map down to the involved nodes, their edges and groups', () => {
    const small = submap(map, focus(map, f, path));
    expect(sorted(small.nodes.map((n) => n.id))).toEqual(['alfresco', 'api003', 'channel', 'dim-policy', 'online006', 'staff']);
    expect(small.edges.every((e) => small.nodes.some((n) => n.id === e.from) && small.nodes.some((n) => n.id === e.to))).toBe(true);
    expect(small.groups.map((g) => g.id)).toEqual(['tli-api', 'dim']);
  });

  it('marks the flow edges between the root causes and the symptom as the bug path', () => {
    const edges = map.edges.filter((e) => isPathEdge(e, f, path));
    expect(edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['api003>alfresco', 'online006>alfresco']);
    expect(map.edges.filter((e) => isPathEdge(e, frame(trail, 0), bugPath(map, frame(trail, 0))))).toHaveLength(0);
  });
});
