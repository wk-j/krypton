import { describe, expect, it } from 'vitest';

import { SPINNER_FRAMES, Spinner, currentSpinnerGlyph, tickAllSpinners } from './index';

const nextFrameAfter = (glyph: string): string =>
  SPINNER_FRAMES[(SPINNER_FRAMES.indexOf(glyph) + 1) % SPINNER_FRAMES.length];

const running = (): Spinner => {
  const spinner = new Spinner();
  spinner.update({ running: true });
  return spinner;
};

describe('Spinner', () => {
  it('emits the spinner span on a braille frame while running', () => {
    const spinner = running();

    expect(spinner.el.tagName).toBe('SPAN');
    expect(spinner.el.className).toBe('acp-harness__spinner');
    expect(SPINNER_FRAMES).toContain(spinner.el.textContent);

    spinner.dispose();
  });

  it('advances every mounted spinner on a tick', () => {
    const a = running();
    const b = running();
    const expected = nextFrameAfter(currentSpinnerGlyph());

    tickAllSpinners();

    expect(a.el.textContent).toBe(expected);
    expect(b.el.textContent).toBe(expected);
    expect(currentSpinnerGlyph()).toBe(expected);

    a.dispose();
    b.dispose();
  });

  it('keeps the ticked frame across an update that changes nothing else', () => {
    const spinner = running();
    tickAllSpinners();
    tickAllSpinners();
    const glyph = spinner.el.textContent;

    spinner.update({ running: true });

    expect(spinner.el.textContent).toBe(glyph);
    expect(glyph).toBe(currentSpinnerGlyph());

    spinner.dispose();
  });

  it('drops the block class and shows the terminal glyph when the work ends', () => {
    const spinner = running();

    spinner.update({ running: false, terminalGlyph: '✓' });

    expect(spinner.el.outerHTML).toBe('<span>✓</span>');
    expect(spinner.el.hasAttribute('class')).toBe(false);

    spinner.dispose();
  });

  it('empties the span when no terminal glyph is supplied — the idle lane symbol', () => {
    const spinner = running();

    spinner.update({ running: false });

    expect(spinner.el.outerHTML).toBe('<span></span>');

    spinner.dispose();
  });

  it('stops following the tick once it has shown a terminal glyph', () => {
    const spinner = running();
    spinner.update({ running: false, terminalGlyph: '✗' });

    tickAllSpinners();

    expect(spinner.el.textContent).toBe('✗');

    spinner.dispose();
  });

  it('re-derives the block class when the work starts again', () => {
    const spinner = running();
    spinner.update({ running: false, terminalGlyph: '✓' });

    spinner.update({ running: true });
    const expected = nextFrameAfter(currentSpinnerGlyph());
    tickAllSpinners();

    expect(spinner.el.className).toBe('acp-harness__spinner');
    expect(spinner.el.textContent).toBe(expected);

    spinner.dispose();
  });

  it('is no longer ticked after dispose()', () => {
    const spinner = running();
    const glyph = spinner.el.textContent;

    spinner.dispose();
    tickAllSpinners();

    expect(spinner.el.textContent).toBe(glyph);
  });

  it('keeps its text node across a tick and across a no-op update', () => {
    const spinner = running();
    const node = spinner.el.firstChild;

    tickAllSpinners();
    spinner.update({ running: true });

    expect(spinner.el.firstChild).toBe(node);

    spinner.dispose();
  });
});
