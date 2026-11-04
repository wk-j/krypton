// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { AssistantInstance, AssistantInventoryState } from '../assistant-instance-store';
import { HarnessAssistantsController } from './harness-assistants-controller';

const originalScroll = Element.prototype.scrollIntoView;

function state(ids: readonly string[]): AssistantInventoryState {
  return {
    loading: false, error: null, refreshed_at_ms: 1000, sampled_at_ms: null,
    instances: ids.map((id): AssistantInstance => ({
      id, kind: 'acp', backend_id: 'codex',
      owner: { role: 'harness_lane', label: id, harness_id: 'harness', lane_id: id },
      cwd: '/project', acp_session_id: null, execution: { kind: 'local', host: null, runtime_id: null },
      pid: 42, lifecycle: 'ready', activity: 'idle', liveness: 'alive', has_error: false,
      requested_model_id: null, confirmed_model_id: null, model_uncertain: false,
      started_at_ms: 1000, last_activity_at_ms: 1000, metrics: null, cpu_ready: false,
    })),
  };
}

function setup() {
  let shown = false;
  let hidden = true;
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  Element.prototype.scrollIntoView = vi.fn();
  const listeners: ((state: AssistantInventoryState) => void)[] = [];
  const unsubscribes: Mock[] = [];
  const invalidate = vi.fn();
  const focusComposer = vi.fn();
  const availability = vi.fn();
  const controller = new HarnessAssistantsController({
    isPanelHidden: () => hidden,
    setDockTabAvailable: availability,
    dockTabShown: () => shown,
    invalidate, focusComposer,
  }, {
    subscribeInventory: (listener) => {
      listeners.push(listener);
      const unsubscribe = vi.fn();
      unsubscribes.push(unsubscribe);
      listener(state([]));
      return unsubscribe;
    },
  });
  document.body.append(controller.dockEl);
  return {
    controller, listeners, unsubscribes, invalidate, focusComposer, availability,
    show: (value: boolean): void => { hidden = !value; shown = value; controller.renderDock(); },
    visibility: (value: string): void => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); },
  };
}

function press(controller: HarnessAssistantsController, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  controller.dockEl.dispatchEvent(event);
  controller.handleDockKey(event);
  return event;
}

function selected(controller: HarnessAssistantsController): string | null {
  return controller.dockEl.querySelector('[aria-selected="true"]')?.getAttribute('data-assistant-id') ?? null;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = originalScroll;
});

describe('HarnessAssistantsController', () => {
  it('subscribes only for an actually shown visible-document monitor, with empty inventory still available', () => {
    const harness = setup();
    harness.controller.renderDock();
    expect(harness.listeners).toHaveLength(0);
    expect(harness.availability).toHaveBeenLastCalledWith(false);
    harness.show(true);
    expect(harness.listeners).toHaveLength(1);
    expect(harness.availability).toHaveBeenLastCalledWith(true);
    harness.controller.renderDock();
    expect(harness.listeners).toHaveLength(1);
    expect(harness.controller.dockEl.textContent).toContain('No assistant instances started');
    harness.visibility('hidden');
    expect(harness.unsubscribes[0]).toHaveBeenCalledTimes(1);
    harness.visibility('visible');
    expect(harness.listeners).toHaveLength(2);
    harness.show(false);
    expect(harness.unsubscribes[1]).toHaveBeenCalledTimes(1);
    harness.controller.dispose();
    harness.visibility('visible');
    expect(harness.listeners).toHaveLength(2);
  });

  it('rejects retired subscription callbacks and disconnects its document listener on disposal', () => {
    const harness = setup();
    harness.show(true);
    harness.listeners[0](state(['first']));
    harness.show(false);
    harness.show(true);
    harness.listeners[1](state(['current']));
    harness.listeners[0](state(['obsolete']));
    harness.controller.renderDock();
    expect(harness.controller.dockEl.textContent).toContain('current');
    expect(harness.controller.dockEl.textContent).not.toContain('obsolete');
    const calls = harness.invalidate.mock.calls.length;
    harness.controller.dispose();
    harness.listeners[1](state(['late']));
    harness.visibility('hidden');
    harness.visibility('visible');
    expect(harness.invalidate).toHaveBeenCalledTimes(calls);
    expect(harness.listeners).toHaveLength(2);
    expect(harness.unsubscribes[1]).toHaveBeenCalledTimes(1);
  });

  it('owns keyed selection, boundaries, focused typing, and Escape focus restoration', () => {
    const harness = setup();
    harness.show(true);
    harness.listeners[0](state(['one', 'two', 'three']));
    harness.controller.renderDock();
    expect(selected(harness.controller)).toBe('one');
    expect(press(harness.controller, 'j').defaultPrevented).toBe(true);
    expect(selected(harness.controller)).toBe('two');
    press(harness.controller, 'End');
    expect(selected(harness.controller)).toBe('three');
    press(harness.controller, 'ArrowDown');
    expect(selected(harness.controller)).toBe('three');
    press(harness.controller, 'k');
    expect(selected(harness.controller)).toBe('two');
    harness.listeners[0](state(['three', 'two', 'one']));
    harness.controller.renderDock();
    expect(selected(harness.controller)).toBe('two');
    press(harness.controller, 'Home');
    expect(selected(harness.controller)).toBe('three');
    expect(press(harness.controller, 'x').defaultPrevented).toBe(true);
    expect(press(harness.controller, 'Escape').defaultPrevented).toBe(true);
    expect(harness.focusComposer).toHaveBeenCalledTimes(1);
    expect(harness.controller.handleDockKey(new KeyboardEvent('keydown', { key: 'j' }))).toBe(false);
    harness.listeners[0](state([]));
    harness.controller.renderDock();
    press(harness.controller, 'End');
    expect(selected(harness.controller)).toBeNull();
    harness.controller.dispose();
  });
});
