// Spec 372 — the Smart Prompt Dialog sends into a Harness lane through the
// control op `lane.send` with caller `prompt_dialog`. These drive the real
// AcpHarnessView and assert what reaches the agent: the dialog's text is
// literal (a leading `@path` is a file, not a lane mention, also after a queue
// drain), and only the dialog may attach images.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every Tauri call answers an empty list so the view's polls parse; the lessons
// store answers null (no snapshot), since `[].entries` is a function.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === 'list_lessons' ? null : [])),
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

const DIALOG: ControlCaller = { source: 'prompt_dialog' };
const API: ControlCaller = { source: 'control_api' };
const PNG = { data: 'iVBORw0KGgo=', mimeType: 'image/png', path: '/tmp/krypton-prompt-images/a.png' };

let view: AcpHarnessView;
let prompts: ContentBlock[][];

// The view keeps lanes and the drain private (spec 275); these casts are the
// test seam, as in components/harness-integration.test.ts.
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

function userText(blocks: ContentBlock[]): string | undefined {
  const last = blocks[blocks.length - 1];
  return last?.type === 'text' ? last.text : undefined;
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

describe('lane.send from the prompt dialog (spec 372)', () => {
  it('delivers text that starts with a file token instead of reading it as a lane mention', async () => {
    addLane('Claude-1');
    addLane('Codex-1');

    const reply = await view.handleControlOperation(
      'lane.send', { lane: 'Claude-1', text: '@src/foo.ts explain this' }, DIALOG,
    );

    expect(reply).toEqual({ status: 'started', lane: 'Claude-1' });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(userText(prompts[0])).toBe('@src/foo.ts explain this');
  });

  it('keeps the text literal when a queued dialog prompt drains', async () => {
    const lane = addLane('Claude-1');
    lane.status = 'busy';

    const reply = await view.handleControlOperation(
      'lane.send', { lane: 'Claude-1', text: '@/tmp/notes.md summarise' }, DIALOG,
    );
    expect(reply).toEqual({ status: 'queued', lane: 'Claude-1', queueDepth: 1 });

    lane.status = 'idle';
    call('maybeDrainPromptQueue', lane);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(userText(prompts[0])).toBe('@/tmp/notes.md summarise');
  });

  it('still fans a leading mention out for other callers', async () => {
    addLane('Claude-1');
    addLane('Codex-1');

    await view.handleControlOperation('lane.send', { lane: 'Claude-1', text: '@src/foo.ts explain' }, API);
    await Promise.resolve();

    expect(prompts).toEqual([]);
  });

  it('sends dialog images as image blocks, with or without text', async () => {
    addLane('Claude-1');

    await view.handleControlOperation('lane.send', { lane: 'Claude-1', text: '', images: [PNG] }, DIALOG);

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContainEqual(expect.objectContaining({
      type: 'image', data: PNG.data, mimeType: 'image/png',
    }));
  });

  it('rejects images from any caller but the dialog', async () => {
    addLane('Claude-1');

    await expect(view.handleControlOperation(
      'lane.send', { lane: 'Claude-1', text: 'look', images: [PNG] }, API,
    )).rejects.toMatchObject({ code: 'invalid_request' });
    expect(prompts).toEqual([]);
  });

  it('rejects dialog images on a remote Harness and sends nothing', async () => {
    addLane('Claude-1');
    (view as unknown as { remoteRuntimeId: string | null }).remoteRuntimeId = 'rt-1';

    await expect(view.handleControlOperation(
      'lane.send', { lane: 'Claude-1', text: 'look', images: [PNG] }, DIALOG,
    )).rejects.toMatchObject({ code: 'invalid_request', message: 'local images are unavailable in a remote Harness' });
    expect(prompts).toEqual([]);
  });

  it('rejects an empty dialog prompt with no images', async () => {
    addLane('Claude-1');

    await expect(view.handleControlOperation('lane.send', { lane: 'Claude-1', text: '  ' }, DIALOG))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});
