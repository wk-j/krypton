// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import type { AssistantInstance, AssistantInventoryState } from '../../../assistant-instance-store';
import { AssistantInstances } from './index';

function instance(over: Partial<AssistantInstance> = {}): AssistantInstance {
  return {
    id: 'acp:1', kind: 'acp', backend_id: 'codex',
    owner: { role: 'harness_lane', label: 'codex-1', harness_id: 'h1', lane_id: 'lane1' },
    cwd: '/projects/one', acp_session_id: 'conversation-1',
    execution: { kind: 'local', runtime_id: null, host: null }, pid: 42,
    lifecycle: 'ready', activity: 'idle', liveness: 'alive', has_error: false,
    requested_model_id: null, confirmed_model_id: null, model_uncertain: false,
    started_at_ms: 1000, last_activity_at_ms: 2000, metrics: null, cpu_ready: false,
    ...over,
  };
}

function inventory(instances: readonly AssistantInstance[], over: Partial<AssistantInventoryState> = {}): AssistantInventoryState {
  return { instances, loading: false, error: null, refreshed_at_ms: 3000, sampled_at_ms: null, ...over };
}

function paint(instances: readonly AssistantInstance[], state: Partial<AssistantInventoryState> = {}): AssistantInstances {
  const component = new AssistantInstances();
  component.update({ inventory: inventory(instances, state), selectedId: instances[0]?.id ?? null, now: 4000 });
  return component;
}

const B = '.acp-assistant-instances';

function stat(component: AssistantInstances, id: string): string | null | undefined {
  return component.el.querySelector(`[data-stat="${id}"] ${B}__stat-value`)?.textContent;
}

function row(component: AssistantInstances, id: string): HTMLElement {
  const found = component.el.querySelector<HTMLElement>(`[data-assistant-id="${id}"]`);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

/** A figure cell's text, or null while the cell is hidden (not measured). */
function metric(component: AssistantInstances, id: string, key: string): string | null | undefined {
  const cell = row(component, id).querySelector<HTMLElement>(`[data-metric="${key}"]`);
  return cell?.hidden ? null : cell?.textContent;
}

function fact(component: AssistantInstances, id: string, key: string): string | null | undefined {
  const cell = row(component, id).querySelector<HTMLElement>(`[data-fact="${key}"]`);
  return cell?.hidden ? null : cell?.textContent;
}

function field(component: AssistantInstances, label: string): HTMLElement | undefined {
  const term = [...component.el.querySelectorAll(`${B}__details dt`)].find((dt) => dt.textContent === label);
  return term?.nextElementSibling instanceof HTMLElement ? term.nextElementSibling : undefined;
}

describe('AssistantInstances', () => {
  it('separates known-live ACP processes, embedded, working, and unknown liveness across projects', () => {
    const component = paint([
      instance({ activity: 'running' }),
      instance({ id: 'acp:2', cwd: '/other/two', liveness: 'unknown', execution: { kind: 'remote', runtime_id: 'r', host: 'buildbox' } }),
      instance({ id: 'acp:3', lifecycle: 'disconnected', liveness: 'exited', has_error: true }),
      instance({ id: 'embedded:1', kind: 'embedded', pid: null, execution: { kind: 'embedded', runtime_id: null, host: null }, owner: { role: 'agent_view', label: 'Agent', harness_id: null, lane_id: null } }),
      instance({ id: 'acp:5', owner: { role: 'assist', label: 'Assist · /projects/one', harness_id: 'h1', lane_id: null } }),
    ]);
    expect(component.el.querySelector('header')?.textContent).toContain('All projects');
    expect(['acp', 'embedded', 'working', 'unknown'].map((id) => stat(component, id))).toEqual(['2', '1', '1', '1']);
    expect(component.el.querySelector('[data-stat="working"]')?.getAttribute('data-tone')).toBe('live');
    expect(component.el.querySelector('[data-stat="unknown"]')?.getAttribute('data-tone')).toBe('warn');
    expect([fact(component, 'acp:2', 'project'), fact(component, 'acp:2', 'host')]).toEqual(['two', 'buildbox']);
    expect(fact(component, 'acp:1', 'host')).toBeNull();
    expect(component.el.querySelectorAll('[data-assistant-id]')).toHaveLength(5);
    const errorChip = (id: string): HTMLElement | null => row(component, id).querySelector(`${B}__chip--fault`);
    expect(errorChip('acp:3')?.hidden).toBe(false);
    expect(errorChip('acp:1')?.hidden).toBe(true);
    // A settled row is two lines: its unsettled-state line stays out.
    const alerts = (id: string): boolean | undefined => row(component, id).querySelector<HTMLElement>(`${B}__alerts`)?.hidden;
    expect([alerts('acp:1'), alerts('acp:2'), alerts('acp:3')]).toEqual([true, false, false]);
    // A helper's label repeats its cwd and role; the row says each once.
    expect(row(component, 'acp:5').querySelector(`${B}__name`)?.textContent).toBe('Assist');
    expect(row(component, 'acp:5').querySelector<HTMLElement>(`${B}__role`)?.hidden).toBe(true);
    expect(row(component, 'embedded:1').querySelector(`${B}__role`)?.textContent).toBe('Agent view');
  });

  it('does not invent local, remote or embedded resources or confirmed models', () => {
    const component = paint([
      instance({ requested_model_id: 'configured-alias' }),
      instance({ id: 'remote', pid: null, execution: { kind: 'remote', runtime_id: 'r1', host: 'remote' } }),
      instance({ id: 'pi', kind: 'embedded', pid: null, execution: { kind: 'embedded', runtime_id: null, host: null } }),
    ]);
    expect(row(component, 'acp:1').textContent).toContain('not sampled');
    expect(row(component, 'remote').textContent).toContain('unavailable');
    expect(row(component, 'pi').textContent).toContain('shared WebView');
    expect(['acp:1', 'remote', 'pi'].map((id) => [metric(component, id, 'cpu'), metric(component, id, 'mem')]))
      .toEqual([[null, null], [null, null], [null, null]]);
    expect(row(component, 'acp:1').textContent).toContain('requested configured-alias (unconfirmed)');
    expect(row(component, 'acp:1').querySelector(`${B}__age`)?.textContent).toBe('3s');
    expect(field(component, 'Cwd')?.textContent).toBe('/projects/one');
    expect(field(component, 'Conversation')?.textContent).toBe('conversation-1');
    expect(field(component, 'Resources')?.textContent).toBe('unavailable · not sampled');
  });

  it('labels CPU warmup, fresh delta, stale resources and uncertain requested model independently', () => {
    const row1 = instance({ metrics: { session: 1, root_pid: 42, root_alive: true, cpu_ready: false, total_cpu_percent: 0, total_rss_mb: 128, proc_count: 2, processes: [] }, confirmed_model_id: 'actual-model', requested_model_id: 'new-model', model_uncertain: true });
    const component = paint([row1], { sampled_at_ms: 3000 });
    expect([metric(component, row1.id, 'cpu'), metric(component, row1.id, 'mem')]).toEqual(['warming up', '128M']);
    expect(row(component, row1.id).textContent).toContain('actual-model · uncertain · requested new-model');
    const stale = (): string | undefined => row(component, row1.id).querySelector<HTMLElement>(`${B}__live`)?.dataset.stale;
    expect(stale()).toBe('false');
    component.update({ inventory: inventory([{ ...row1, cpu_ready: true }], { sampled_at_ms: 3000 }), selectedId: row1.id, now: 4000 });
    expect(metric(component, row1.id, 'cpu')).toBe('0.0%');
    component.update({ inventory: inventory([{ ...row1, cpu_ready: true }], { sampled_at_ms: 3000 }), selectedId: row1.id, now: 11000 });
    expect(metric(component, row1.id, 'mem')).toBe('128M');
    expect(stale()).toBe('true');
    expect(component.el.querySelector(`${B}__status[data-stale="true"]`)?.textContent).toContain('Stale inventory');
  });

  it('distinguishes loading/error/empty and retains stale rows and counts after refresh failure', () => {
    const component = paint([], { loading: true, refreshed_at_ms: null });
    expect(component.el.querySelector(`${B}__status`)?.textContent).toBe('Loading…');
    expect(component.el.querySelector(`${B}__empty`)?.textContent).toBe('Loading assistant instances…');
    expect(stat(component, 'acp')).toBe('—');
    component.update({ inventory: inventory([]), selectedId: null, now: 4000 });
    expect(component.el.textContent).toContain('No assistant instances started');
    component.update({ inventory: inventory([instance()], { error: 'offline' }), selectedId: 'acp:1', now: 4000 });
    expect(component.el.querySelector(`${B}__status[data-stale="true"]`)?.textContent)
      .toMatch(/^Refresh failed: offline · last success \d\d:\d\d:\d\d$/);
    expect(stat(component, 'acp')).toBe('1');
    expect(component.el.querySelector<HTMLElement>(`${B}__empty`)?.hidden).toBe(true);
    component.update({ inventory: inventory([], { error: 'offline', refreshed_at_ms: null }), selectedId: null, now: 4000 });
    expect(component.el.textContent).toContain('Assistant inventory unavailable');
    expect(component.el.textContent).not.toContain('No assistant instances started');
  });

  it('makes identical updates zero-write and retains keyed DOM identity across reorder and field mutations', () => {
    const a = instance();
    const b = instance({ id: 'acp:2' });
    const component = paint([a, b]);
    const first = component.el.querySelector('[data-assistant-id="acp:1"]');
    const second = component.el.querySelector('[data-assistant-id="acp:2"]');
    const observer = new MutationObserver(() => {});
    observer.observe(component.el, { childList: true, subtree: true, attributes: true, characterData: true });
    component.update({ inventory: inventory([{ ...a }, { ...b }]), selectedId: a.id, now: 4000 });
    expect(observer.takeRecords()).toHaveLength(0);
    component.update({ inventory: inventory([b, a]), selectedId: a.id, now: 4000 });
    expect([...component.el.querySelectorAll('[data-assistant-id]')]).toEqual([second, first]);
    observer.takeRecords();
    const stableRow = new MutationObserver(() => {});
    stableRow.observe(second!, { childList: true, subtree: true, attributes: true, characterData: true });
    a.confirmed_model_id = 'reported-model';
    a.last_activity_at_ms = 3500;
    component.update({ inventory: inventory([b, a]), selectedId: a.id, now: 4000 });
    expect(component.el.querySelector('[data-assistant-id="acp:1"]')).toBe(first);
    expect(first?.textContent).toContain('reported-model');
    expect(field(component, 'Last active')?.title).toBe('1970-01-01T00:00:03.500Z');
    expect(stableRow.takeRecords()).toHaveLength(0);
    stableRow.disconnect();
    // An age tick repaints rows but leaves the selected details — and any text
    // the user has selected in them — untouched.
    const details = component.el.querySelector(`${B}__details`)!;
    const stableDetails = new MutationObserver(() => {});
    stableDetails.observe(details, { childList: true, subtree: true, attributes: true, characterData: true });
    component.update({ inventory: inventory([b, a]), selectedId: a.id, now: 5000 });
    expect(row(component, a.id).querySelector(`${B}__age`)?.textContent).toBe('4s');
    expect(stableDetails.takeRecords()).toHaveLength(0);
    stableDetails.disconnect();
    observer.disconnect();
  });

  it('never changes dock-owned hidden state and hides unselected identity details', () => {
    const host = document.createElement('aside');
    host.className = 'acp-harness__assistants-dock';
    host.hidden = true;
    const component = new AssistantInstances(host);
    component.update({ inventory: inventory([instance()]), selectedId: null, now: 4000 });
    expect(host.hidden).toBe(true);
    expect(host.classList.contains('acp-harness__assistants-dock')).toBe(true);
    expect(host.querySelector<HTMLElement>(`${B}__details`)?.hidden).toBe(true);
  });
});
