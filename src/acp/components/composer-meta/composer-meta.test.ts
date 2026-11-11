import { describe, expect, it } from 'vitest';

import { ComposerMeta, type ComposerMetaProps } from './index';

const BASE: ComposerMetaProps = {
  segments: [
    { id: 'verb', text: 'reviewing' },
    { id: 'elapsed', text: '2:14' },
    { id: 'queued', text: '3 queued' },
  ],
  running: true,
  chips: [
    {
      key: 'permission-mode',
      block: 'acp-harness__composer-mode',
      text: 'auto-edit',
      title: 'Auto-edit — file edits are auto-accepted; commands still ask. Shift+Tab to change.',
    },
  ],
  branch: { ref: 'main', title: '/Users/wk/Source/krypton on main' },
  helpHint: [{ keys: ['?'], label: 'help' }],
};

const writes = (el: HTMLElement, run: () => void): number => {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
};

const mount = (props: ComposerMetaProps = BASE): ComposerMeta => {
  const meta = new ComposerMeta();
  meta.update(props);
  return meta;
};

describe('ComposerMeta', () => {
  it('emits the chrome row: status segments, chips, branch, help', () => {
    const meta = mount();

    expect(meta.el.outerHTML).toBe(
      '<div class="acp-harness__composer-chrome">' +
        '<div class="acp-harness__composer-meta">' +
        '<span class="acp-harness__memory-chip acp-harness__memory-chip--running">' +
        '<span class="acp-harness__meta-seg" data-seg="verb">reviewing</span>' +
        '<span class="acp-harness__meta-seg" data-seg="elapsed">2:14</span>' +
        '<span class="acp-harness__meta-seg" data-seg="queued">3 queued</span>' +
        '</span>' +
        '<span class="acp-harness__composer-mode" title="Auto-edit — file edits are auto-accepted; ' +
        'commands still ask. Shift+Tab to change.">auto-edit</span>' +
        '<span class="acp-harness__project-status" title="/Users/wk/Source/krypton on main">' +
        '<svg class="acp-harness__icon" aria-hidden="true"><use href="#krypton-icon-branch"></use></svg>' +
        '<span class="acp-harness__project-branch">main</span></span>' +
        '</div>' +
        '<div class="acp-harness__composer-tools">' +
        '<span class="acp-harness__help-hint"><span class="krypton-key-hint"><kbd>?</kbd> help</span></span>' +
        '</div>' +
        '</div>',
    );
  });

  it('writes nothing when the tick lands on the same elapsed second', () => {
    const meta = mount();

    const count = writes(meta.el, () => {
      meta.update({ ...BASE, segments: [...BASE.segments] });
    });

    expect(count).toBe(0);
  });

  it('advances the elapsed segment without touching the chips or the branch', () => {
    const meta = mount();
    const elapsed = meta.el.querySelector('[data-seg="elapsed"]');
    const mode = meta.el.querySelector('.acp-harness__composer-mode');
    const branch = meta.el.querySelector('.acp-harness__project-branch');

    meta.update({
      ...BASE,
      segments: [
        { id: 'verb', text: 'reviewing' },
        { id: 'elapsed', text: '2:15' },
        { id: 'queued', text: '3 queued' },
      ],
    });

    expect(meta.el.querySelector('[data-seg="elapsed"]')).toBe(elapsed);
    expect(elapsed?.textContent).toBe('2:15');
    expect(meta.el.querySelector('.acp-harness__composer-mode')).toBe(mode);
    expect(meta.el.querySelector('.acp-harness__project-branch')).toBe(branch);
  });

  it('updates the mode chip alone, in place, when only the mode moves', () => {
    const meta = mount();
    const status = meta.el.querySelector('.acp-harness__memory-chip');
    const mode = meta.el.querySelector('.acp-harness__composer-mode');

    meta.update({
      ...BASE,
      chips: [{ ...BASE.chips[0], text: 'bypass', tone: 'warn' }],
    });

    expect(meta.el.querySelector('.acp-harness__memory-chip')).toBe(status);
    expect(meta.el.querySelector('.acp-harness__composer-mode')).toBe(mode);
    expect(mode?.textContent).toBe('bypass');
    expect(mode?.className).toBe('acp-harness__composer-mode acp-harness__composer-mode--warn');
  });

  it('re-derives the running modifier when the lane goes idle and back', () => {
    const meta = mount();
    const status = meta.el.querySelector<HTMLElement>('.acp-harness__memory-chip');

    meta.update({ ...BASE, running: false });
    expect(status?.className).toBe('acp-harness__memory-chip');

    meta.update(BASE);
    expect(status?.className).toBe('acp-harness__memory-chip acp-harness__memory-chip--running');
  });

  it('removes the branch when the project status goes away', () => {
    const meta = mount();
    meta.update({ ...BASE, branch: null });
    expect(meta.el.querySelector('.acp-harness__project-status')).toBeNull();
  });

  it('drops a chip that is no longer painted', () => {
    const meta = mount();
    meta.update({ ...BASE, chips: [] });
    expect(meta.el.querySelector('.acp-harness__composer-mode')).toBeNull();
    expect(meta.el.querySelector('.acp-harness__project-status')).not.toBeNull();
  });

  it('leaves whatever the composer mounted in the tools slot alone', () => {
    const meta = mount();
    const mic = document.createElement('button');
    meta.toolsEl.appendChild(mic);

    meta.update({ ...BASE, helpHint: [{ keys: ['?'], label: 'help' }, { keys: ['Esc'], label: '' }] });

    expect(mic.parentElement).toBe(meta.toolsEl);
    expect(meta.toolsEl.firstElementChild?.textContent).toBe('? help · Esc');
  });
});
