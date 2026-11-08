// Spec 0375 — the Commit Browser asks a Harness lane to explain a commit
// through the in-process control op `lane.learn` (caller `commit_browser`).
// These drive the real AcpHarnessView and assert the source gate, the busy
// refusal, and the one system turn a successful call starts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'list_lessons') return null;
    if (cmd === 'knowledge_write_path') return '/k/krypton-abcdef1.md';
    return [];
  }),
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));
vi.mock('../../profiler/ipc', () => ({ invoke: vi.fn(async () => []) }));

import { AcpHarnessView } from '../acp-harness-view';
import type { ControlCaller } from '../control-types';
import type { HarnessLane } from '../harness-view-types';
import type { ContentBlock } from '../types';

const BROWSER: ControlCaller = { source: 'commit_browser' };
const API: ControlCaller = { source: 'control_api' };

let view: AcpHarnessView;
let prompts: ContentBlock[][];

function call<T>(name: string, ...args: unknown[]): T {
  const fn = (view as unknown as Record<string, (...a: unknown[]) => T>)[name];
  return fn.call(view, ...args);
}

function addLane(name: string): HarnessLane {
  const lanes = (view as unknown as { lanes: HarnessLane[] }).lanes;
  const lane = call<HarnessLane>('createLane', lanes.length + 1, 'claude', name);
  lanes.push(lane);
  lane.status = 'idle';
  const client = {
    prompt: async (blocks: ContentBlock[]): Promise<string> => {
      prompts.push(blocks);
      return 'end_turn';
    },
    dispose: async (): Promise<void> => {},
  };
  lane.client = client as unknown as HarnessLane['client'];
  return lane;
}

function userText(blocks: ContentBlock[]): string {
  const last = blocks[blocks.length - 1];
  return last?.type === 'text' ? last.text : '';
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
  prompts = [];
});

afterEach(() => {
  view.dispose();
  vi.unstubAllGlobals();
});

describe('lane.learn from the Commit Browser (spec 0375)', () => {
  it('refuses a control_api caller before resolving the lane', async () => {
    await expect(view.handleControlOperation('lane.learn', { lane: 'No-Such-Lane', sha: 'abcdef1' }, API))
      .rejects.toMatchObject({ code: 'invalid_request', message: 'lane.learn is internal to the Commit Browser' });
  });

  it('refuses a busy lane with lane_busy', async () => {
    const lane = addLane('Claude-1');
    lane.status = 'busy';
    await expect(view.handleControlOperation('lane.learn', { lane: 'Claude-1', sha: 'abcdef1' }, BROWSER))
      .rejects.toMatchObject({ code: 'lane_busy' });
    expect(prompts).toEqual([]);
  });

  it('starts one explainer turn and returns the knowledge path', async () => {
    addLane('Claude-1');
    const result = await view.handleControlOperation('lane.learn', { lane: 'Claude-1', sha: 'abcdef1234' }, BROWSER);
    expect(result).toMatchObject({ status: 'started', lane: 'Claude-1', path: '/k/krypton-abcdef1.md' });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(userText(prompts[0])).toContain('"/k/krypton-abcdef1.md"');
  });

  it('returns started while the explainer turn is still running', async () => {
    // The Commit Browser lights its pending lamp from this result; awaiting the
    // whole turn would let the lane's idle signal arrive first.
    const lane = addLane('Claude-1');
    let finish: (stop: string) => void = () => undefined;
    lane.client = {
      prompt: (blocks: ContentBlock[]): Promise<string> => {
        prompts.push(blocks);
        // Executor form: tsconfig's ES2021 lib has no `Promise.withResolvers`.
        return new Promise<string>((resolve) => { finish = resolve; });
      },
      dispose: async (): Promise<void> => {},
    } as unknown as HarnessLane['client'];
    const result = await view.handleControlOperation('lane.learn', { lane: 'Claude-1', sha: 'abcdef1234' }, BROWSER);
    expect(result).toMatchObject({ status: 'started' });
    expect(lane.status).toBe('busy');
    expect(prompts).toHaveLength(1);
    finish('end_turn');
  });
});
