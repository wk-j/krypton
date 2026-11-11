// @vitest-environment happy-dom
// Spec 365 — a failed top-level tool call marks its lane for the workspace fire
// until the user acknowledges it by typing while that lane is active.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));
vi.mock('../profiler/ipc', () => ({ invoke: vi.fn(async () => []) }));

import { AcpHarnessView } from './acp-harness-view';
import type { HarnessLane } from './harness-view-types';
import type { LaneEvent } from './adapters/types';
import { toolEventSource } from './adapters/test-utils';
import type { ToolStatus } from './types';

let view: AcpHarnessView;
let changes: number;

// The view keeps lanes and event handling private (spec 275); these casts are
// the same deliberate test seam `components/harness-integration.test.ts` uses.
function call<T>(name: string, ...args: unknown[]): T {
  const fn = (view as unknown as Record<string, (...a: unknown[]) => T>)[name];
  return fn.call(view, ...args);
}

function addLane(index: number, name: string): HarnessLane {
  const lane = call<HarnessLane>('createLane', index, 'omp', name);
  (view as unknown as { lanes: HarnessLane[] }).lanes.push(lane);
  return lane;
}

function activate(lane: HarnessLane): void {
  (view as unknown as { activeLaneId: string }).activeLaneId = lane.id;
}

function toolEnds(lane: HarnessLane, toolCallId: string, status: ToolStatus | 'canceled'): void {
  const source = toolEventSource('omp');
  call('onLaneEvent', lane, source.call({ toolCallId, title: 'grep', status: 'in_progress' }));
  call('onLaneEvent', lane, source.update({ toolCallId, status: status as ToolStatus }));
}

function press(key = 'a'): void {
  view.onKeyDown(new KeyboardEvent('keydown', { key, cancelable: true }));
}

beforeEach(() => {
  document.body.replaceChildren();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => { storage.set(key, value); },
    removeItem: (key: string): void => { storage.delete(key); },
  });
  view = new AcpHarnessView('/tmp/proj');
  document.body.appendChild(view.element);
  changes = 0;
  view.onFireTriggerChange = (): void => { changes += 1; };
});

afterEach(() => {
  view.dispose();
  vi.unstubAllGlobals();
});

describe('harness tool-error fire trigger (spec 365)', () => {
  it('marks only a failed tool call, not a completed or canceled one', () => {
    const lane = addLane(1, 'OMP-1');
    activate(lane);
    toolEnds(lane, 'ok', 'completed');
    toolEnds(lane, 'stopped', 'canceled');
    expect(view.getFireTrigger()).toBeNull();
    expect(changes).toBe(0);

    toolEnds(lane, 'bad', 'failed');
    expect(view.getFireTrigger()).toBe('tool_error');
    expect(changes).toBe(1);
  });

  it('stays lit until the user types while the failed lane is active', () => {
    const failed = addLane(1, 'OMP-1');
    const other = addLane(2, 'OMP-2');
    activate(other);
    toolEnds(failed, 'bad', 'failed');

    press();
    expect(view.getFireTrigger()).toBe('tool_error');

    activate(failed);
    press();
    expect(view.getFireTrigger()).toBeNull();
    expect(changes).toBe(2);
  });

  it('stays lit while any marked lane is unacknowledged', () => {
    const a = addLane(1, 'OMP-1');
    const b = addLane(2, 'OMP-2');
    toolEnds(a, 'a1', 'failed');
    toolEnds(b, 'b1', 'failed');
    activate(a);
    press();
    expect(view.getFireTrigger()).toBe('tool_error');
    activate(b);
    press();
    expect(view.getFireTrigger()).toBeNull();
  });
});
