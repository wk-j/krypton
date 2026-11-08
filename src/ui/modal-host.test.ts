// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { mountModalInActiveWindow } from './modal-host';

afterEach(() => document.body.replaceChildren());

describe('modal host', () => {
  it('mounts a modal in the focused DOM window and follows focus on reopening', () => {
    const first = document.createElement('div');
    first.className = 'krypton-window krypton-window--focused';
    const second = document.createElement('div');
    second.className = 'krypton-window';
    document.body.append(first, second);

    const modal = document.createElement('div');
    mountModalInActiveWindow(modal);
    expect(modal.parentElement).toBe(first);

    first.classList.remove('krypton-window--focused');
    second.classList.add('krypton-window--focused');
    mountModalInActiveWindow(modal);
    expect(modal.parentElement).toBe(second);
  });

  it('uses the source view window, then the document when no window exists', () => {
    const window = document.createElement('div');
    window.className = 'krypton-window';
    const view = document.createElement('div');
    window.appendChild(view);
    document.body.appendChild(window);
    const modal = document.createElement('div');

    mountModalInActiveWindow(modal, view);
    expect(modal.parentElement).toBe(window);

    window.remove();
    mountModalInActiveWindow(modal);
    expect(modal.parentElement).toBe(document.body);
  });
});
