import { describe, expect, it } from 'vitest';

import { Chip, type ChipProps } from './index';

const paint = (props: ChipProps): Chip => {
  const chip = new Chip();
  chip.update(props);
  return chip;
};

describe('Chip', () => {
  it('emits the caller block, so the existing stylesheet keeps working', () => {
    const chip = paint({ block: 'acp-harness__lane-model', text: 'claude-sonnet-4-5', title: 'model claude-sonnet-4-5' });

    expect(chip.el.outerHTML).toBe(
      '<span class="acp-harness__lane-model" title="model claude-sonnet-4-5">claude-sonnet-4-5</span>',
    );
  });

  it('places content as text, icon, trailing — the mcp chip shape', () => {
    const chip = paint({
      block: 'acp-harness__lane-mcp',
      tone: 'on',
      text: 'mcp ',
      icon: { id: 'check', cls: 'acp-harness__icon--dot' },
      trailing: ' 14',
      title: 'tools/list 14',
    });

    expect(chip.el.className).toBe('acp-harness__lane-mcp acp-harness__lane-mcp--on');
    expect(chip.el.textContent).toBe('mcp  14');
    const icon = chip.el.querySelector('svg');
    expect(icon?.getAttribute('class')).toBe('acp-harness__icon acp-harness__icon--dot');
    expect(icon?.firstElementChild?.getAttribute('href')).toBe('#krypton-icon-check');
  });

  it('renders an icon-led chip with no leading text', () => {
    const chip = paint({
      block: 'acp-harness__lane-sandbox',
      icon: { id: 'warn', cls: 'acp-harness__icon--dot' },
      text: '',
      trailing: ' unsandboxed',
    });

    expect(chip.el.firstChild?.nodeName).toBe('svg');
    expect(chip.el.textContent).toBe(' unsandboxed');
  });

  it('drops the tone modifier when the tone goes back to neutral', () => {
    const chip = new Chip();
    chip.update({ block: 'acp-harness__lane-model', text: 'gpt-5', tone: 'warn' });
    expect(chip.el.className).toBe('acp-harness__lane-model acp-harness__lane-model--warn');

    chip.update({ block: 'acp-harness__lane-model', text: 'gpt-5', tone: 'neutral' });
    expect(chip.el.className).toBe('acp-harness__lane-model');
  });

  it('removes a title that is no longer supplied instead of leaving a stale one', () => {
    const chip = new Chip();
    chip.update({ block: 'b', text: 'x', title: 'why' });
    chip.update({ block: 'b', text: 'x' });
    expect(chip.el.hasAttribute('title')).toBe(false);
  });

  it('skips the repaint while its dependency tuple holds', () => {
    const chip = paint({ block: 'b', text: 'x' });
    const node = chip.el.firstChild;
    chip.update({ block: 'b', text: 'x' });
    expect(chip.el.firstChild).toBe(node);
  });

  it('escapes nothing by hand — text goes through the DOM, not a string builder', () => {
    const chip = paint({ block: 'b', text: '<script>alert(1)</script>' });
    expect(chip.el.querySelector('script')).toBeNull();
    expect(chip.el.textContent).toBe('<script>alert(1)</script>');
  });
});
