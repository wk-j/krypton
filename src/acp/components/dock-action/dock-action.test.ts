import { describe, expect, it } from 'vitest';

import { DockActionButton, type DockActionState } from './index';

function button(): DockActionButton {
  return new DockActionButton({ label: 'Send', icon: 'rails-send', data: { 'rails-action': 'send' } });
}

const el = (b: DockActionButton): HTMLButtonElement => b.el as HTMLButtonElement;

describe('DockActionButton', () => {
  it('shows an idle detail as the tooltip and no badge line', () => {
    const b = button();
    b.update({ state: { kind: 'idle', detail: 'Send 3 open findings to codex-1' }, disabledReason: null });

    expect(el(b).className).toBe('acp-dock-action');
    expect(el(b).dataset.railsAction).toBe('send');
    expect(el(b).textContent).toBe('Send');
    expect(el(b).title).toBe('Send 3 open findings to codex-1');
    expect(el(b).disabled).toBe(false);
    expect(el(b).querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-rails-send');
  });

  it('lets the disabled reason win the tooltip and keeps a running state', () => {
    const b = button();
    b.update({
      state: { kind: 'running', badge: 'running · claude-1', detail: 'Update running in claude-1' },
      disabledReason: 'codex-1 is busy',
    });

    expect(el(b).className).toBe('acp-dock-action acp-dock-action--running');
    expect(el(b).disabled).toBe(true);
    expect(el(b).title).toBe('codex-1 is busy');
    expect(el(b).textContent).toBe('Sendrunning · claude-1');
  });

  it('drops the badge and the tooltip when a done button returns to idle', () => {
    const b = button();
    b.update({ state: { kind: 'done', badge: '✓ 14:02', detail: '3 findings sent to codex-1' }, disabledReason: null });
    expect(el(b).className).toBe('acp-dock-action acp-dock-action--done');
    expect(el(b).disabled).toBe(false);
    expect(el(b).textContent).toBe('Send✓ 14:02');

    b.update({ state: { kind: 'idle' }, disabledReason: null });
    expect(el(b).className).toBe('acp-dock-action');
    expect(el(b).textContent).toBe('Send');
    expect(el(b).hasAttribute('title')).toBe(false);
  });

  it('writes nothing when an equal state arrives as a new object', () => {
    const b = button();
    const done = (): DockActionState => ({ kind: 'done', badge: '✓ trusted', detail: 'rails.toml is trusted' });
    b.update({ state: done(), disabledReason: null });

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(b.el, { subtree: true, childList: true, attributes: true, characterData: true });
    b.update({ state: done(), disabledReason: null });
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });
});
