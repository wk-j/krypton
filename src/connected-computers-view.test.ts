// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

import { ConnectedComputersContentView } from './connected-computers-view';

const profile = { id: 'buildbox', host: 'build.example', user: 'alice', port: 2222, defaultCwd: '/srv/builds' };
const list = (state: string) => ({
  revision: 'rev1',
  computers: [{ profile, state, resolvedTarget: 'alice@build.example:2222', activeCommands: 0, lastError: null }],
});

let view: ConnectedComputersContentView | null = null;
afterEach(() => {
  view?.dispose();
  view = null;
  mocks.invoke.mockReset();
  mocks.listen.mockReset();
});

describe('ConnectedComputersContentView', () => {
  it('keeps an edited profile and focus through a connection status event', async () => {
    const callbacks: Array<() => void> = [];
    mocks.listen.mockImplementation(async (_name: string, callback: () => void) => {
      callbacks.push(callback);
      return () => undefined;
    });
    mocks.invoke.mockResolvedValueOnce(list('configured')).mockResolvedValueOnce(list('disconnected'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    view = new ConnectedComputersContentView(container);
    await vi.waitFor(() => expect(view!.element.textContent).toContain('buildbox'));
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'e' }));
    const host = view.element.querySelector<HTMLInputElement>('input[name="host"]')!;
    host.value = 'unsaved.example';
    const autoApprove = view.element.querySelector<HTMLInputElement>('input[name="autoApproveReadOnly"]')!;
    expect(autoApprove.checked).toBe(true);
    autoApprove.checked = false;
    host.focus();
    expect(callbacks).toHaveLength(1);
    callbacks[0]();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect(view.element.querySelector<HTMLInputElement>('input[name="host"]')).toBe(host);
    expect(host.value).toBe('unsaved.example');
    expect(view.element.querySelector<HTMLInputElement>('input[name="autoApproveReadOnly"]')).toBe(autoApprove);
    expect(autoApprove.checked).toBe(false);
    expect(document.activeElement).toBe(host);
    container.remove();
  });

  it('reports a save conflict while retaining the unsaved form', async () => {
    mocks.listen.mockResolvedValue(() => undefined);
    mocks.invoke.mockResolvedValueOnce(list('configured'))
      .mockRejectedValueOnce('Profile file changed; reload before saving');
    view = new ConnectedComputersContentView(document.createElement('div'));
    await vi.waitFor(() => expect(view!.element.textContent).toContain('buildbox'));
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'e' }));
    const host = view.element.querySelector<HTMLInputElement>('input[name="host"]')!;
    host.value = 'unsaved.example';
    view.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(view!.element.textContent).toContain('Profile file changed'));
    expect(view.element.querySelector<HTMLInputElement>('input[name="host"]')?.value).toBe('unsaved.example');
    expect(view.element.querySelector('[data-action="reload"]')).not.toBeNull();
  });

  it.each([true, false])('preserves read-only choice %s through bypass save, reopen and disable', async (readOnly) => {
    let savedProfile = { ...profile, autoApproveReadOnly: readOnly, bypassCommandApproval: false };
    const snapshot = () => ({
      revision: 'rev1',
      computers: [{ ...list('configured').computers[0], profile: { ...savedProfile } }],
    });
    mocks.listen.mockResolvedValue(() => undefined);
    mocks.invoke.mockImplementation(async (command: string, args?: { profile: typeof savedProfile }) => {
      if (command === 'computer_profile_save') savedProfile = { ...args!.profile };
      return snapshot();
    });
    view = new ConnectedComputersContentView(document.createElement('div'));
    document.body.appendChild(view.element);
    await vi.waitFor(() => expect(view!.element.textContent).toContain('buildbox'));
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'e' }));
    let readOnlyInput = view.element.querySelector<HTMLInputElement>('input[name="autoApproveReadOnly"]')!;
    const bypass = view.element.querySelector<HTMLInputElement>('input[name="bypassCommandApproval"]')!;
    bypass.click();
    expect(readOnlyInput.disabled).toBe(true);
    expect(readOnlyInput.checked).toBe(readOnly);
    view.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(view!.element.querySelector('form')).toBeNull());
    expect(view.element.querySelector('dd:last-child')?.textContent).toBe('BYPASS — all commands');
    expect(view.element.querySelector('.krypton-computers__row')?.textContent).toContain('BYPASS');
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'e' }));
    readOnlyInput = view.element.querySelector<HTMLInputElement>('input[name="autoApproveReadOnly"]')!;
    const reopenedBypass = view.element.querySelector<HTMLInputElement>('input[name="bypassCommandApproval"]')!;
    expect(reopenedBypass.checked).toBe(true);
    expect(readOnlyInput.disabled).toBe(true);
    expect(readOnlyInput.checked).toBe(readOnly);
    reopenedBypass.click();
    expect(readOnlyInput.disabled).toBe(false);
    expect(readOnlyInput.checked).toBe(readOnly);
    view.element.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await vi.waitFor(() => expect(view!.element.querySelector('form')).toBeNull());
    expect(view.element.querySelector('dd:last-child')?.textContent).toBe(readOnly ? 'Read-only auto-approval' : 'Always ask');
    expect(view.element.querySelector('.krypton-computers__row')?.textContent).not.toContain('BYPASS');
  });

  it('discards an unsaved bypass grant when the editor is cancelled', async () => {
    mocks.listen.mockResolvedValue(() => undefined);
    mocks.invoke.mockResolvedValue(list('configured'));
    view = new ConnectedComputersContentView(document.createElement('div'));
    document.body.appendChild(view.element);
    await vi.waitFor(() => expect(view!.element.textContent).toContain('buildbox'));
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'e' }));
    view.element.querySelector<HTMLInputElement>('input[name="bypassCommandApproval"]')!.click();
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.element.querySelector('.krypton-computers__row')?.textContent).not.toContain('BYPASS');
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'e' }));
    expect(view.element.querySelector<HTMLInputElement>('input[name="bypassCommandApproval"]')?.checked).toBe(false);
    expect(view.element.querySelector<HTMLInputElement>('input[name="autoApproveReadOnly"]')?.disabled).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalledWith('computer_profile_save', expect.anything());
  });
});
