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
      block: 'acp-harness__lane-sandbox',
      text: 'auto-edit ⇧⇥',
      title: 'Auto-edit — file edits are auto-accepted; commands still ask. Shift+Tab to change.',
    },
    {
      key: 'directive',
      block: 'acp-harness__directive-chip acp-harness__directive-chip--set',
      text: 'directive 0301-impl',
      title: 'Cmd+P then . to change',
      data: { 'open-directive-picker': '1' },
    },
  ],
  branch: { text: '⎇ main', title: '/Users/wk/Source/krypton on main' },
  helpHint: '? help',
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
        '<span class="acp-harness__lane-sandbox" title="Auto-edit — file edits are auto-accepted; ' +
        'commands still ask. Shift+Tab to change.">auto-edit ⇧⇥</span>' +
        '<span class="acp-harness__directive-chip acp-harness__directive-chip--set" ' +
        'title="Cmd+P then . to change" data-open-directive-picker="1">directive 0301-impl</span>' +
        '<span class="acp-harness__project-status" title="/Users/wk/Source/krypton on main">' +
        '<span class="acp-harness__project-branch">⎇ main</span></span>' +
        '</div>' +
        '<div class="acp-harness__composer-tools">' +
        '<span class="acp-harness__help-hint">? help</span>' +
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
    const directive = meta.el.querySelector('.acp-harness__directive-chip');
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
    expect(meta.el.querySelector('.acp-harness__directive-chip')).toBe(directive);
    expect(meta.el.querySelector('.acp-harness__project-branch')).toBe(branch);
  });

  it('updates the directive segment alone when only the directive moves', () => {
    const meta = mount();
    const status = meta.el.querySelector('.acp-harness__memory-chip');

    meta.update({
      ...BASE,
      chips: [
        BASE.chips[0],
        { ...BASE.chips[1], text: 'directive 0302-catalog (next send)',
          block: 'acp-harness__directive-chip acp-harness__directive-chip--set acp-harness__directive-chip--pending' },
      ],
    });

    expect(meta.el.querySelector('.acp-harness__memory-chip')).toBe(status);
    expect(meta.el.querySelector('.acp-harness__directive-chip')?.textContent)
      .toBe('directive 0302-catalog (next send)');
    expect(meta.el.querySelector('.acp-harness__directive-chip')?.className)
      .toBe('acp-harness__directive-chip acp-harness__directive-chip--set acp-harness__directive-chip--pending');
  });

  it('nests the triage marker inside the directive chip and drops it again', () => {
    const meta = mount({
      ...BASE,
      chips: [
        { ...BASE.chips[1], extra: { class: 'acp-harness__directive-chip__triage', text: '◆ lane', title: 'attention triage lane' } },
      ],
    });

    const chip = meta.el.querySelector('.acp-harness__directive-chip');
    expect(chip?.innerHTML).toBe(
      'directive 0301-impl <span class="acp-harness__directive-chip__triage" ' +
        'title="attention triage lane">◆ lane</span>',
    );

    meta.update({ ...BASE, chips: [BASE.chips[1]] });
    expect(meta.el.querySelector('.acp-harness__directive-chip__triage')).toBeNull();
    expect(chip?.textContent).toBe('directive 0301-impl');
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
    meta.update({ ...BASE, chips: [BASE.chips[1]] });
    expect(meta.el.querySelector('.acp-harness__lane-sandbox')).toBeNull();
    expect(meta.el.querySelector('.acp-harness__directive-chip')).not.toBeNull();
  });

  it('opens the directive picker from the chip, and stops after dispose()', () => {
    let opened = 0;
    const meta = new ComposerMeta();
    meta.update({ ...BASE, onOpenDirective: (): void => { opened += 1; } });
    const chip = meta.el.querySelector<HTMLElement>('.acp-harness__directive-chip');

    chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toBe(1);

    meta.dispose();
    chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toBe(1);
  });

  it('leaves whatever the composer mounted in the tools slot alone', () => {
    const meta = mount();
    const mic = document.createElement('button');
    meta.toolsEl.appendChild(mic);

    meta.update({ ...BASE, helpHint: '? help · esc' });

    expect(mic.parentElement).toBe(meta.toolsEl);
    expect(meta.toolsEl.firstElementChild?.textContent).toBe('? help · esc');
  });
});
