// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { StatusBar } from './index';

describe('StatusBar', () => {
  it.each([
    ['normal', 'krypton-file-manager__status'],
    ['prompt', 'krypton-file-manager__status krypton-file-manager__status--prompt'],
    ['filter', 'krypton-file-manager__status krypton-file-manager__status--filter'],
    ['error', 'krypton-file-manager__status krypton-file-manager__status--error'],
    ['confirm', 'krypton-file-manager__status krypton-file-manager__status--confirm'],
  ] as const)('%s → %s', (tone, cls) => {
    const s = new StatusBar();
    s.update({ text: 't', tone });
    expect(s.el.className).toBe(cls);
    expect(s.el.textContent).toBe('t');
  });

  it('tone null keeps the previous class (P7)', () => {
    const s = new StatusBar();
    s.update({ text: 'boom', tone: 'error' });
    s.update({ text: 'Copied: /x', tone: null });
    expect(s.el.className).toBe('krypton-file-manager__status krypton-file-manager__status--error');
    expect(s.el.textContent).toBe('Copied: /x');
  });
});
