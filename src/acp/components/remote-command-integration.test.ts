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
import { toolEventSource, type ToolEventSource } from '../adapters/test-utils';
import { RemoteCommandDialog } from './remote-command-dialog';

let view: AcpHarnessView;
let lane: HarnessLane;
let source: ToolEventSource;

function call<T = void>(name: string, ...args: unknown[]): T {
  const host = view as unknown as Record<string, (...values: unknown[]) => T>;
  return host[name].call(view, ...args);
}

function dialog(): RemoteCommandDialog {
  const value: unknown = Reflect.get(view, 'remoteCommandDialog');
  if (!(value instanceof RemoteCommandDialog)) throw new Error('Missing remote command dialog');
  return value;
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, cancelable: true, ...init });
  view.onKeyDown(event);
  return event;
}

function start(id: string): void {
  call('onLaneEvent', lane, source.call({
    toolCallId: id, status: 'in_progress',
    title: 'mcp__krypton_harness_memory__computer_exec',
    rawInput: { computerId: 'mac-mini', command: "printf '%s\\n' remote-result", cwd: '/srv/project' },
  }));
}

function finish(id: string, exitCode: number, outcome: 'completed' | 'unknown' = 'completed'): void {
  call('onLaneEvent', lane, source.update({
    toolCallId: id, status: 'completed',
    rawOutput: { content: [{ type: 'text', text: JSON.stringify({
      computerId: 'mac-mini', exitCode, outcome,
      stdout: '  remote-result\n', stderr: exitCode ? 'remote diagnostic\n' : '', truncated: false,
    }) }] },
  }));
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
  view = new AcpHarnessView('/tmp/remote-command-integration');
  document.body.appendChild(view.element);
  lane = call<HarnessLane>('createLane', 1, 'claude', 'Claude-1');
  lane.status = 'busy';
  source = toolEventSource('claude');
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

describe('remote command details in the Harness', () => {
  it('updates a late result through its card and open dialog without rebuilding a sealed row', () => {
    lane.transcript.push({ id: 'neighbour', kind: 'assistant', text: 'A sealed neighbouring reply.' });
    start('remote');
    call('onLaneEvent', lane, source.update({ toolCallId: 'remote', status: 'completed' }));
    call('renderDashboard');
    const original = row('remote');
    const body = original.querySelector<HTMLElement>('.acp-harness__msg-body')!;
    const label = original.querySelector<HTMLElement>('.acp-harness__msg-label')!;
    const neighbour = view.element.querySelector<HTMLElement>('[data-msg-id="neighbour"]')!;
    const structure = new MutationObserver(() => {});
    structure.observe(body, { childList: true });
    structure.observe(label, { attributes: true, childList: true, subtree: true, characterData: true });
    structure.observe(neighbour, { attributes: true, childList: true, subtree: true, characterData: true });
    original.querySelector<HTMLButtonElement>('[data-remote-command-details]')!.click();
    expect(dialog().isOpen).toBe(true);
    expect(original.contains(dialog().el)).toBe(false);
    finish('remote', 7);
    expect(row('remote')).toBe(original);
    expect(original.textContent).toContain('exit 7');
    expect(dialog().el.textContent).toContain('remote diagnostic');
    expect(dialog().el.textContent).toContain('  remote-result\n');
    expect(structure.takeRecords()).toEqual([]);
    structure.disconnect();
    // An unknown remote outcome outranks the outer tool's completed status.
    finish('remote', 0, 'unknown');
    expect(original.textContent).toContain('Outcome unknown');
    expect(dialog().el.textContent).toContain('Outcome unknown');
  });

  it('opens by f hint, routes Tab to sections, preserves copy chords and restores focus on Escape', () => {
    start('remote');
    finish('remote', 0);
    call('renderDashboard');
    call('enterTranscriptFocus');
    key('f');
    const item = lane.transcript.find((entry) => entry.id === lane.toolTranscriptIds.get('remote'))!;
    const hint = item.remoteCommandTarget?.hintLabel;
    expect(hint).toBeTruthy();
    for (const letter of hint ?? '') key(letter);
    expect(dialog().isOpen).toBe(true);
    const selected = (): string | null | undefined => dialog().el.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
    const first = selected();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(selected()).not.toBe(first);
    key('Tab', { shiftKey: true });
    expect(selected()).toBe(first);
    expect(key('c', { metaKey: true }).defaultPrevented).toBe(false);
    key('Escape');
    expect(dialog().isOpen).toBe(false);
    expect(document.activeElement).toBe(view.element);
    row('remote').querySelector<HTMLButtonElement>('[data-remote-command-details]')!.click();
    expect(dialog().isOpen).toBe(true);
  });

  it('retains details outside the mounted tail and closes without stealing focus when the item disappears', () => {
    start('old');
    finish('old', 0);
    call('renderDashboard');
    row('old').querySelector<HTMLButtonElement>('[data-remote-command-details]')!.click();
    lane.transcriptWindow = 1;
    start('new');
    call('renderActiveTranscript', lane);
    expect(dialog().isOpen).toBe(true);
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    const oldId = lane.toolTranscriptIds.get('old');
    lane.transcript = lane.transcript.filter((entry) => entry.id !== oldId);
    call('renderActiveTranscript', lane);
    expect(dialog().isOpen).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });
});
