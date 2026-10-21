import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
  convertFileSrc: (path: string): string => path,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));
vi.mock('../../profiler/ipc', () => ({ invoke: vi.fn(async () => []) }));

import { AcpHarnessView } from '../acp-harness-view';
import type { HarnessLane } from '../harness-view-types';
import type { ToolCall, ToolCallUpdate } from '../types';
import { ExecutionDialog } from './execution-dialog';

let view: AcpHarnessView;
let lane: HarnessLane;

function call<T = void>(name: string, ...args: unknown[]): T {
  // Deliberate test seam: drive the real view's private event/render methods.
  const host = view as unknown as Record<string, (...values: unknown[]) => T>;
  const method = host[name];
  return method.call(view, ...args);
}

function dialog(): ExecutionDialog {
  const value: unknown = Reflect.get(view, 'executionDialog');
  if (!(value instanceof ExecutionDialog)) throw new Error('Missing execution dialog');
  return value;
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, cancelable: true, ...init });
  view.onKeyDown(event);
  return event;
}

function start(id: string, title = 'Read fixture'): void {
  const input: ToolCall = {
    toolCallId: id, kind: 'execute', status: 'pending',
    title: `[py] ${title}\nprint("fixture")`,
    rawInput: { language: 'py', title, code: 'print("fixture")' },
    content: [{ type: 'content', content: { type: 'text', text: 'print("fixture")' } }],
  };
  call('onLaneEvent', lane, { type: 'tool_call', call: input });
}

function output(id: string, text: string, terminal = false): void {
  const update: ToolCallUpdate = {
    toolCallId: id, status: terminal ? 'completed' : 'in_progress',
    rawOutput: {
      content: [{ type: 'text', text }],
      details: { cells: [{
        index: 0, code: 'print("fixture")', language: 'python', title: 'Read fixture',
        output: text, status: terminal ? 'complete' : 'running',
        ...(terminal ? { durationMs: 12, exitCode: 0 } : {}),
        statusEvents: [{ op: 'phase', title: 'Reading fixture' }],
      }] },
    },
  };
  call('onLaneEvent', lane, { type: 'tool_call_update', update });
  call('renderActiveTranscript', lane);
}

function row(id: string): HTMLElement {
  const itemId = lane.toolTranscriptIds.get(id);
  const element = view.element.querySelector<HTMLElement>(`[data-msg-id="${itemId}"]`);
  if (!element) throw new Error(`Missing row ${id}`);
  return element;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  view = new AcpHarnessView('/tmp/execution-integration');
  document.body.appendChild(view.element);
  lane = call<HarnessLane>('createLane', 1, 'omp', 'OMP-1');
  lane.status = 'busy';
  // Deliberate test seam: attach a real lane without starting a native ACP process.
  const state = view as unknown as { lanes: HarnessLane[]; activeLaneId: string };
  state.lanes.push(lane);
  state.activeLaneId = lane.id;
});

afterEach(() => {
  view.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('execution inspector dialog in the Harness', () => {
  it('streams snapshots into one dialog without ever writing to the transcript rows', () => {
    lane.transcript.push({ id: 'neighbour', kind: 'assistant', text: 'An unchanged sealed reply.' });
    start('cell');
    call('renderDashboard');
    const originalRow = row('cell');
    const sibling = view.element.querySelector<HTMLElement>('[data-msg-id="neighbour"]');
    if (!sibling) throw new Error('Missing sealed neighbour');
    const siblingMutations = new MutationObserver(() => {});
    siblingMutations.observe(sibling, { attributes: true, childList: true, characterData: true, subtree: true });
    const rowMutations = new MutationObserver(() => {});
    rowMutations.observe(originalRow, { attributes: true, childList: true, characterData: true, subtree: true });
    const button = originalRow.querySelector<HTMLButtonElement>('[data-execution-inspector]');
    expect(button).not.toBeNull();
    expect(originalRow.textContent).not.toContain('print("fixture")');
    button?.click();
    const inspector = dialog().el;
    expect(dialog().isOpen).toBe(true);
    expect(originalRow.contains(inspector)).toBe(false);
    expect(view.element.contains(inspector)).toBe(true);
    expect(inspector.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(rowMutations.takeRecords()).toEqual([]);
    rowMutations.disconnect();

    output('cell', 'first result');
    output('cell', 'first result\nsecond result', true);
    expect(lane.transcript.filter((item) => item.kind === 'tool')).toHaveLength(1);
    expect(row('cell')).toBe(originalRow);
    expect(dialog().el).toBe(inspector);
    expect(inspector.textContent).toContain('first result\nsecond result');
    expect(inspector.textContent?.split('second result')).toHaveLength(2);

    call('onLaneEvent', lane, { type: 'tool_call_update', update: { toolCallId: 'cell', status: 'completed' } });
    call('renderActiveTranscript', lane);
    expect(inspector.textContent).toContain('first result\nsecond result');
    expect(inspector.textContent).toContain('Done');
    expect(view.element.querySelector('[data-msg-id="neighbour"]')).toBe(sibling);
    expect(siblingMutations.takeRecords()).toEqual([]);
    siblingMutations.disconnect();
  });

  it('opens by transcript hint, owns plain keys, lets Cmd chords through, and returns focus on Escape', () => {
    const other = call<HarnessLane>('createLane', 2, 'omp', 'OMP-2');
    const lanes: unknown = Reflect.get(view, 'lanes');
    if (!Array.isArray(lanes)) throw new Error('Missing lanes');
    lanes.push(other);
    start('first');
    start('second');
    call('renderDashboard');
    call('enterTranscriptFocus');
    key('f');
    const firstItem = lane.transcript.find((item) => item.id === lane.toolTranscriptIds.get('first'));
    const hint = firstItem?.executionTarget?.hintLabel;
    expect(hint).toBeTruthy();
    for (const letter of hint ?? '') key(letter);
    const inspector = dialog().el;
    expect(dialog().isOpen).toBe(true);
    expect(inspector.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute('role')).toBe('tab');

    // `2` would switch lanes from the transcript; the open dialog takes it.
    expect(key('2').defaultPrevented).toBe(true);
    expect(Reflect.get(view, 'activeLaneId')).toBe(lane.id);
    expect(inspector.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Output');
    expect(key('c', { metaKey: true }).defaultPrevented).toBe(false);

    key('Escape');
    expect(dialog().isOpen).toBe(false);
    expect(document.activeElement).toBe(view.element);

    row('second').querySelector<HTMLButtonElement>('[data-execution-inspector]')?.click();
    expect(dialog().isOpen).toBe(true);
    expect(dialog().el).toBe(inspector);
  });

  it('stays open when its row leaves the mounted window and closes, without stealing focus, when the item is gone', () => {
    start('old');
    call('renderDashboard');
    row('old').querySelector<HTMLButtonElement>('[data-execution-inspector]')?.click();
    lane.transcriptWindow = 1;
    start('new');
    call('renderActiveTranscript', lane);
    expect(dialog().isOpen).toBe(true);
    expect(dialog().el.textContent).toContain('Read fixture');

    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    const oldId = lane.toolTranscriptIds.get('old');
    lane.transcript = lane.transcript.filter((item) => item.id !== oldId);
    call('renderActiveTranscript', lane);
    expect(dialog().isOpen).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('does not turn an identically shaped non-OMP tool into an execution card', () => {
    lane.backendId = 'claude';
    start('not-omp');
    call('renderDashboard');
    expect(row('not-omp').querySelector('[data-execution-inspector]')).toBeNull();
    expect(lane.transcript.find((item) => item.kind === 'tool')?.executionTarget).toBeUndefined();
  });
});
