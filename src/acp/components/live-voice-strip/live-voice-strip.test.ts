import { describe, expect, it } from 'vitest';

import { LiveVoiceStrip, liveVoiceMeter, type LiveVoiceStripProps } from './index';

const SESSION: LiveVoiceStripProps = {
  kind: 'session',
  phase: 'listening',
  voice: 'alloy',
  inputLevel: 0.1,
  outputLevel: 0.05,
  line: 'you: refactor the composer',
  muted: false,
};

const writes = (el: HTMLElement, run: () => void): number => {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
};

const mount = (props: LiveVoiceStripProps = SESSION): LiveVoiceStrip => {
  const strip = new LiveVoiceStrip();
  strip.update(props);
  return strip;
};

describe('LiveVoiceStrip', () => {
  it('clamps the meter at eight cells', () => {
    expect(liveVoiceMeter(0)).toBe('░░░░░░░░');
    expect(liveVoiceMeter(0.9)).toBe('████████');
  });

  it('writes nothing when a level tick stays inside the same cell', () => {
    const strip = mount();

    const count = writes(strip.el, () => {
      strip.update({ ...SESSION, kind: 'session', inputLevel: 0.104, outputLevel: 0.052 });
    });

    expect(count).toBe(0);
  });

  it('repaints the meter when the level crosses a cell', () => {
    const strip = mount();
    const meter = strip.el.querySelector('[data-live-in]');

    strip.update({ ...SESSION, kind: 'session', inputLevel: 0.15 });

    expect(strip.el.querySelector('[data-live-in]')).toBe(meter);
    expect(meter?.textContent).toBe('██████░░');
  });

  it('re-derives the phase class when muted and back', () => {
    const strip = mount();

    strip.update({ ...SESSION, kind: 'session', phase: 'muted', muted: true });
    expect(strip.el.className).toBe('acp-harness__live acp-harness__live--muted');

    strip.update(SESSION);
    expect(strip.el.className).toBe('acp-harness__live acp-harness__live--listening');
  });

  it('tints the note red on an error', () => {
    const strip = mount({ kind: 'note', text: 'live failed: no mic', error: true });
    expect(strip.el.className).toBe('acp-harness__live acp-harness__live--error');
    expect(strip.el.querySelector('.acp-harness__live-line')?.textContent).toBe('live failed: no mic');
  });

  it('hides itself with no session and no note, and comes back whole', () => {
    const strip = mount();

    strip.update({ kind: 'hidden' });
    expect(strip.el.hidden).toBe(true);
    expect(strip.el.className).toBe('acp-harness__live');
    expect(strip.el.childNodes).toHaveLength(0);

    strip.update(SESSION);
    expect(strip.el.hidden).toBe(false);
    expect(strip.el.childNodes).toHaveLength(7);
    expect(strip.el.querySelector('[data-live-line]')?.textContent).toBe('you: refactor the composer');
  });
});
