// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncTitlebarToggles } from './titlebar-toggles';
import type { TitlebarToggle } from './types';

const PANELS: readonly TitlebarToggle[] = [
  { id: 'plan', icon: 'krypton-icon-panel-plan', label: 'Plan panel', pressed: true },
  { id: 'grammar', icon: 'krypton-icon-panel-grammar', label: 'Grammar panel', pressed: false },
  { id: 'all', icon: 'krypton-icon-panel-all', label: 'All panels', pressed: true, separatorBefore: true },
];

function makeEnd(): HTMLElement {
  const end = document.createElement('div');
  end.className = 'krypton-window__titlebar-end';
  const status = document.createElement('span');
  status.className = 'krypton-window__pty-status';
  end.appendChild(status);
  document.body.appendChild(end);
  return end;
}

function buttons(end: HTMLElement): HTMLButtonElement[] {
  return Array.from(end.querySelectorAll<HTMLButtonElement>('.krypton-window__view-toggle'));
}

function button(end: HTMLElement, id: string): HTMLButtonElement {
  const found = end.querySelector<HTMLButtonElement>(`[data-toggle-id='${id}']`);
  if (!found) throw new Error(`no toggle ${id}`);
  return found;
}

describe('syncTitlebarToggles', () => {
  let end: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    end = makeEnd();
  });

  it('renders a labelled toolbar as the first child of the titlebar end', () => {
    syncTitlebarToggles(end, PANELS, () => {});
    const cluster = end.firstElementChild;
    expect(cluster?.classList.contains('krypton-window__view-toggles')).toBe(true);
    expect(cluster?.getAttribute('role')).toBe('toolbar');
    expect(cluster?.getAttribute('aria-label')).toBe('Panels');
    expect(end.children).toHaveLength(2);
    expect(buttons(end).map((b) => b.dataset.toggleId)).toEqual(['plan', 'grammar', 'all']);
  });

  it('reflects pressed state, labels and icons on non-focusable buttons', () => {
    syncTitlebarToggles(end, PANELS, () => {});
    const plan = button(end, 'plan');
    const grammar = button(end, 'grammar');
    expect(plan.type).toBe('button');
    expect(plan.tabIndex).toBe(-1);
    expect(plan.getAttribute('aria-pressed')).toBe('true');
    expect(grammar.getAttribute('aria-pressed')).toBe('false');
    expect(plan.getAttribute('aria-label')).toBe('Plan panel');
    expect(plan.title).toBe('Plan panel');
    expect(plan.disabled).toBe(false);
    const svg = plan.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-panel-plan');
  });

  it('disables a toggle with a reason and shows the reason as its tooltip', () => {
    const reason = 'all panels hidden · #panels show';
    syncTitlebarToggles(end, [{ ...PANELS[0], disabledReason: reason }], () => {});
    const plan = button(end, 'plan');
    expect(plan.disabled).toBe(true);
    expect(plan.title).toBe(reason);
    expect(plan.getAttribute('aria-label')).toBe('Plan panel');
  });

  it('draws a separator only before toggles that ask for one', () => {
    syncTitlebarToggles(end, PANELS, () => {});
    const cluster = end.firstElementChild as HTMLElement;
    const seps = cluster.querySelectorAll('.krypton-window__view-toggle-sep');
    expect(seps).toHaveLength(1);
    expect(seps[0].getAttribute('aria-hidden')).toBe('true');
    expect(seps[0].nextElementSibling).toBe(button(end, 'all'));
    expect(seps[0].previousElementSibling).toBe(button(end, 'grammar'));
  });

  it('calls the latest activation callback with the clicked toggle id', () => {
    const first = vi.fn();
    const latest = vi.fn();
    syncTitlebarToggles(end, PANELS, first);
    syncTitlebarToggles(end, PANELS, latest);
    button(end, 'grammar').querySelector('svg')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith('grammar');
  });

  it('ignores clicks on a disabled toggle', () => {
    const onActivate = vi.fn();
    syncTitlebarToggles(end, [{ ...PANELS[0], disabledReason: 'off' }], onActivate);
    button(end, 'plan').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('prevents mousedown focus change without stopping propagation', () => {
    syncTitlebarToggles(end, PANELS, () => {});
    const outer = vi.fn();
    document.body.addEventListener('mousedown', outer);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button(end, 'plan').dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('keeps the same button nodes when nothing visible changed', () => {
    syncTitlebarToggles(end, PANELS, () => {});
    const before = buttons(end);
    syncTitlebarToggles(end, PANELS.map((t) => ({ ...t })), () => {});
    const after = buttons(end);
    expect(after).toHaveLength(before.length);
    after.forEach((b, i) => expect(b).toBe(before[i]));
  });

  it('updates the pressed state when it changes', () => {
    syncTitlebarToggles(end, PANELS, () => {});
    syncTitlebarToggles(
      end,
      PANELS.map((t) => (t.id === 'grammar' ? { ...t, pressed: true } : t)),
      () => {},
    );
    expect(button(end, 'grammar').getAttribute('aria-pressed')).toBe('true');
    expect(end.querySelectorAll('.krypton-window__view-toggles')).toHaveLength(1);
  });

  it('removes the cluster when the view has no toggles', () => {
    syncTitlebarToggles(end, PANELS, () => {});
    syncTitlebarToggles(end, [], () => {});
    expect(end.querySelector('.krypton-window__view-toggles')).toBeNull();
    expect(end.children).toHaveLength(1);
  });
});
