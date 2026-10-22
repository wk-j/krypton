import { describe, expect, it } from 'vitest';

import type { FollowUpAction } from '../../assist/types';
import { FollowUpRail } from './index';

function action(over: Partial<FollowUpAction> = {}): FollowUpAction {
  return { followUpKind: 'run', label: 'install the app', target: 'make install', hintLabel: null, ...over };
}

describe('FollowUpRail', () => {
  it('renders one non-tabbable button per action, keyed by index, with the full target', () => {
    const rail = new FollowUpRail();
    const long = `npm run build -- --mode production ${'x'.repeat(120)}`;
    rail.update({
      actions: [
        action(),
        action({ followUpKind: 'open', label: 'open the docs', target: 'http://localhost:5173/docs' }),
        action({ label: 'build it', target: long }),
      ],
    });

    const buttons = [...rail.el.querySelectorAll<HTMLButtonElement>('button.acp-harness__followups-btn')];
    expect(buttons.map((b) => b.dataset.followUpIndex)).toEqual(['0', '1', '2']);
    expect(buttons.every((b) => b.type === 'button' && b.tabIndex === -1)).toBe(true);
    expect(buttons[0].getAttribute('aria-label')).toBe('Run make install');
    expect(buttons[1].className).toContain('acp-harness__followups-btn--open');
    expect(buttons[1].getAttribute('aria-label')).toBe('Open http://localhost:5173/docs');
    expect(buttons[2].querySelector('.acp-harness__followups-target')?.textContent).toBe(long);
    rail.dispose();
  });

  it('shows a hint badge only while the open-hint layer has labelled the action', () => {
    const actions = [action(), action({ target: 'npm test', label: 'run the tests' })];
    const rail = new FollowUpRail();
    rail.update({ actions });
    const badges = (): string[] =>
      [...rail.el.querySelectorAll('.acp-harness__followups-hint')].map((n) => n.textContent ?? '');
    expect(badges()).toEqual(['', '']);

    // The hint layer mutates the item's own array in place, as it does for every target.
    actions[1].hintLabel = 'd';
    rail.update({ actions });
    expect(badges()).toEqual(['', 'd']);

    actions[1].hintLabel = null;
    rail.update({ actions });
    expect(badges()).toEqual(['', '']);
    rail.dispose();
  });

  it('keeps its nodes when nothing it paints has changed', () => {
    const rail = new FollowUpRail();
    rail.update({ actions: [action()] });
    const button = rail.el.querySelector('button');
    rail.update({ actions: [action()] });
    expect(rail.el.querySelector('button')).toBe(button);
    rail.dispose();
  });
});
