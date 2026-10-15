import { describe, expect, it } from 'vitest';

import { dictationPreviewParts } from '../../harness-dictation';
import { DictationControl, DictationPreview, type DictationControlProps } from './index';

const IDLE: DictationControlProps = { phase: 'idle', active: false, language: 'en' };

const writes = (el: HTMLElement, run: () => void): number => {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
};

const mount = (props: DictationControlProps = IDLE): DictationControl => {
  const control = new DictationControl();
  control.update(props);
  return control;
};

describe('DictationControl', () => {
  it('emits the idle button with both language chords', () => {
    const control = mount();

    expect(control.el.outerHTML).toBe(
      '<button class="acp-harness__dictation acp-harness__dictation--idle" type="button" ' +
        'data-dictation-toggle="" aria-label="Start English dictation" aria-pressed="false" ' +
        'title="English: Cmd+D · Thai: Cmd+Shift+D">' +
        '<span class="acp-harness__dictation-dot" aria-hidden="true">●</span>' +
        '<span data-dictation-label="" aria-live="polite">MIC</span>' +
        '<span class="acp-harness__dictation-key">⌘D</span>' +
        '<span class="acp-harness__dictation-key">⇧D</span>' +
        '</button>',
    );
  });

  it('renders every phase label', () => {
    const control = mount();
    const label = control.el.querySelector('[data-dictation-label]');
    expect(label?.textContent).toBe('MIC');

    control.update({ phase: 'starting', active: true, language: 'en' });
    expect(label?.textContent).toBe('MIC en');
    expect(control.el.className).toBe('acp-harness__dictation acp-harness__dictation--starting');

    control.update({ phase: 'listening', active: true, language: 'th' });
    expect(label?.textContent).toBe('REC th');
    expect(control.el.className).toBe('acp-harness__dictation acp-harness__dictation--listening');

    control.update({ phase: 'stopping', active: true, language: 'th' });
    expect(label?.textContent).toBe('FINALIZING…');
    expect(control.el.className).toBe('acp-harness__dictation acp-harness__dictation--stopping');
  });

  it('shows one chord while a session runs and re-derives the pair when it ends', () => {
    const control = mount();
    expect(control.el.querySelectorAll('.acp-harness__dictation-key')).toHaveLength(2);

    control.update({ phase: 'listening', active: true, language: 'en' });
    expect(control.el.querySelectorAll('.acp-harness__dictation-key')).toHaveLength(1);
    expect(control.el.getAttribute('aria-label')).toBe('Stop dictation');
    expect(control.el.getAttribute('aria-pressed')).toBe('true');
    expect(control.el.getAttribute('title')).toBe('Stop dictation (Cmd+D)');

    control.update(IDLE);
    expect(control.el.querySelectorAll('.acp-harness__dictation-key')).toHaveLength(2);
    expect(control.el.className).toBe('acp-harness__dictation acp-harness__dictation--idle');
    expect(control.el.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles on click and detaches that listener on dispose()', () => {
    let toggles = 0;
    const control = new DictationControl();
    control.update({ ...IDLE, onToggle: (): void => { toggles += 1; } });

    control.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggles).toBe(1);

    control.dispose();
    control.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggles).toBe(1);
  });

  it('writes nothing when the phase has not moved', () => {
    const control = mount({ phase: 'listening', active: true, language: 'en' });
    const count = writes(control.el, () => {
      control.update({ phase: 'listening', active: true, language: 'en' });
    });
    expect(count).toBe(0);
  });
});

describe('DictationPreview', () => {
  it('splits the draft around the spoken text and ends with the caret', () => {
    const preview = new DictationPreview();
    preview.update(dictationPreviewParts('convert the UI', 11, 'the', 'user interface'));

    expect(preview.el.outerHTML).toBe(
      '<span class="acp-harness__input">convert the' +
        '<span data-dictation-leading=""> </span>' +
        '<span class="acp-harness__dictation-final" data-dictation-final="">the </span>' +
        '<span class="acp-harness__dictation-interim" data-dictation-interim="">user interface</span>' +
        '<span data-dictation-trailing=""></span>' +
        '<span class="acp-harness__caret"></span> UI</span>',
    );
  });

  it('keeps every node while the interim text grows', () => {
    const preview = new DictationPreview();
    preview.update(dictationPreviewParts('note: ', 6, '', 'refac'));
    const interim = preview.el.querySelector('[data-dictation-interim]');
    const caret = preview.el.querySelector('.acp-harness__caret');

    preview.update(dictationPreviewParts('note: ', 6, '', 'refactor the composer'));

    expect(preview.el.querySelector('[data-dictation-interim]')).toBe(interim);
    expect(interim?.textContent).toBe('refactor the composer');
    expect(preview.el.querySelector('.acp-harness__caret')).toBe(caret);
  });

  it('writes nothing when no speech result moved', () => {
    const preview = new DictationPreview();
    const parts = dictationPreviewParts('note: ', 6, 'done', '');
    preview.update(parts);

    const count = writes(preview.el, () => {
      preview.update(dictationPreviewParts('note: ', 6, 'done', ''));
    });

    expect(count).toBe(0);
  });
});
