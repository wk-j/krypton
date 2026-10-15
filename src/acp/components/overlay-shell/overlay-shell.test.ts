import { afterEach, describe, expect, it } from 'vitest';

import { OverlayShell, type OverlayShellProps } from './index';

const shells: OverlayShell[] = [];

const mount = (props: OverlayShellProps): OverlayShell => {
  const shell = new OverlayShell();
  shells.push(shell);
  shell.update(props);
  return shell;
};

const body = (text: string): HTMLElement => {
  const node = document.createElement('div');
  node.className = 'acp-review__body';
  node.textContent = text;
  return node;
};

const review = (over: Partial<OverlayShellProps> = {}): OverlayShellProps => ({
  open: true,
  name: 'review',
  block: 'acp-review',
  title: 'Review quality matrix',
  sub: 'this session · in-memory · not persisted',
  body: body('rows'),
  ...over,
});

afterEach(() => {
  for (const shell of shells.splice(0)) shell.dispose();
});

describe('OverlayShell', () => {
  it('emits the overlay root, the panel, the head and the caller body', () => {
    const shell = mount(review());

    expect(shell.el.outerHTML).toBe(
      '<aside class="acp-harness__review-overlay">' +
        '<div class="acp-review__panel">' +
        '<header class="acp-review__head">' +
        '<span class="acp-review__title">Review quality matrix</span>' +
        '<span class="acp-review__sub">this session · in-memory · not persisted</span>' +
        '</header>' +
        '<div class="acp-review__body">rows</div>' +
        '</div></aside>',
    );
  });

  it('hides itself while closed and reveals itself when opened', () => {
    const shell = mount(review({ open: false }));
    expect(shell.el.hidden).toBe(true);
    expect(shell.isOpen).toBe(false);

    shell.update(review({ open: true }));
    expect(shell.el.hidden).toBe(false);
    expect(shell.isOpen).toBe(true);
  });

  it('emits no sub node when the caller has no subtitle', () => {
    const shell = mount(review({ sub: undefined }));
    expect(shell.el.querySelector('.acp-review__sub')).toBeNull();

    shell.update(review({ sub: 'back' }));
    expect(shell.el.querySelector('.acp-review__sub')?.textContent).toBe('back');

    shell.update(review({ sub: undefined }));
    expect(shell.el.querySelector('.acp-review__sub')).toBeNull();
  });

  it('mounts the key-hint bar as the foot, unwrapped, with the caller markup', () => {
    const shell = mount(review({
      hints: {
        style: 'kbd',
        block: 'acp-review__foot',
        hints: [
          { keys: ['h', 'l'], label: 'switch lane' },
          { keys: ['esc'], label: 'close' },
        ],
        note: 'read-only — observation, not a score',
        noteClass: 'acp-review__foot-note',
      },
    }));

    const panel = shell.el.firstElementChild;
    const foot = panel?.lastElementChild;
    expect(foot?.className).toBe('acp-review__foot');
    expect(foot?.innerHTML).toBe(
      '<span><kbd>h</kbd> <kbd>l</kbd> switch lane</span>' +
        '<span><kbd>esc</kbd> close</span>' +
        '<span class="acp-review__foot-note">read-only — observation, not a score</span>',
    );
  });

  it('keeps the head and the foot nodes across a body swap', () => {
    const shell = mount(review({
      hints: { style: 'kbd', block: 'acp-review__foot', hints: [{ keys: ['esc'], label: 'close' }] },
    }));
    const panel = shell.el.firstElementChild as HTMLElement;
    const head = panel.firstElementChild;
    const foot = panel.lastElementChild;
    const first = panel.children[1];

    shell.update(review({
      body: body('other rows'),
      hints: { style: 'kbd', block: 'acp-review__foot', hints: [{ keys: ['esc'], label: 'close' }] },
    }));

    expect(panel.firstElementChild).toBe(head);
    expect(panel.lastElementChild).toBe(foot);
    expect(panel.children[1]).not.toBe(first);
    expect(panel.children[1].textContent).toBe('other rows');
    expect(first.isConnected).toBe(false);
    expect(panel.children.length).toBe(3);
  });

  it('shows the empty state instead of the body, and drops the foot with it', () => {
    const shell = mount(review({
      empty: 'No reviews recorded.',
      hints: { style: 'kbd', block: 'acp-review__foot', hints: [{ keys: ['esc'], label: 'close' }] },
    }));
    const panel = shell.el.firstElementChild as HTMLElement;

    expect(panel.children.length).toBe(2);
    expect(panel.children[1].outerHTML).toBe('<div class="acp-review__empty">No reviews recorded.</div>');

    shell.update(review({
      hints: { style: 'kbd', block: 'acp-review__foot', hints: [{ keys: ['esc'], label: 'close' }] },
    }));
    expect(panel.children.length).toBe(3);
    expect(panel.querySelector('.acp-review__empty')).toBeNull();
    expect(panel.lastElementChild?.className).toBe('acp-review__foot');
  });

  it('closes the shell that was open when a second one opens', () => {
    let priorityOpen = true;
    const priority = mount({
      open: true,
      name: 'priority',
      block: 'acp-priority',
      title: 'Review priority',
      body: body('ranges'),
      onAutoClose: () => {
        priorityOpen = false;
      },
    });
    expect(priority.el.hidden).toBe(false);

    const matrix = mount(review());

    expect(priority.el.hidden).toBe(true);
    expect(priority.isOpen).toBe(false);
    expect(priorityOpen).toBe(false);
    expect(matrix.el.hidden).toBe(false);
    expect(matrix.isOpen).toBe(true);
  });

  it('reopens a shell that was closed for another one, with the same props', () => {
    const priorityProps: OverlayShellProps = {
      open: true,
      name: 'priority',
      block: 'acp-priority',
      title: 'Review priority',
      body: body('ranges'),
    };
    const priority = mount(priorityProps);
    mount(review());
    expect(priority.el.hidden).toBe(true);

    priority.update(priorityProps);

    expect(priority.el.hidden).toBe(false);
    expect(priority.isOpen).toBe(true);
  });

  it('does not close a shell that is merely repainted while open', () => {
    const shell = mount(review());
    shell.update(review({ title: 'Review quality matrix', body: body('more rows') }));

    expect(shell.el.hidden).toBe(false);
    expect(shell.isOpen).toBe(true);
  });

  it('leaves the registry on dispose, so a later opener does not touch it', () => {
    const stale = mount(review({ name: 'priority', block: 'acp-priority', title: 'Review priority' }));
    expect(stale.isOpen).toBe(true);

    stale.dispose();
    expect(stale.isOpen).toBe(false);

    mount(review());

    // Still visible: a disposed shell is nobody's business to hide.
    expect(stale.el.hidden).toBe(false);
  });

  it('skips the repaint while its dependency tuple holds', () => {
    const props = review();
    const shell = mount(props);
    const panel = shell.el.firstElementChild as HTMLElement;
    const children = [...panel.children];

    shell.update(props);

    expect([...panel.children]).toStrictEqual(children);
  });

  it('re-derives every class when the caller renames the block', () => {
    const shell = mount(review());
    shell.update(review({ name: 'priority', block: 'acp-priority', title: 'Review priority' }));

    expect(shell.el.className).toBe('acp-harness__priority-overlay');
    expect(shell.el.querySelector('.acp-priority__panel')).not.toBeNull();
    expect(shell.el.querySelector('.acp-priority__title')?.textContent).toBe('Review priority');
    expect(shell.el.querySelector('.acp-review__panel')).toBeNull();
  });

  it('takes a full root class for the roots the -overlay suffix never reaches', () => {
    const shell = mount(review({ name: undefined, rootClass: 'remote-harness-picker' }));

    expect(shell.el.className).toBe('remote-harness-picker');
  });

  it('drops the panel wrapper so the child-combinator rules keep matching', () => {
    const list = document.createElement('ul');
    list.className = 'acp-harness__model-list';
    const shell = mount({
      open: true,
      rootClass: 'acp-harness__model-picker',
      block: 'acp-harness__model',
      title: '// model · claude-1',
      sub: 'j/k move · enter switch · esc cancel',
      body: list,
      parts: { panel: null, head: 'acp-harness__model-head', title: null, sub: null },
    });

    expect(shell.el.outerHTML).toBe(
      '<aside class="acp-harness__model-picker">' +
        '<header class="acp-harness__model-head">' +
        '<span>// model · claude-1</span>' +
        '<span>j/k move · enter switch · esc cancel</span>' +
        '</header>' +
        '<ul class="acp-harness__model-list"></ul>' +
        '</aside>',
    );
  });

  it('writes the title straight into the head when the caller has no title span', () => {
    const ticket = (sub: string): OverlayShellProps => review({
      block: 'acp-ticket',
      name: 'ticket',
      title: 'local tickets + GitHub',
      sub,
      parts: { titleAsText: true, sub: 'acp-ticket__sub' },
    });
    const shell = mount(ticket('target: claude-1 · idle'));
    const head = shell.el.querySelector('.acp-ticket__head');

    expect(head?.innerHTML).toBe(
      'local tickets + GitHub<span class="acp-ticket__sub">target: claude-1 · idle</span>',
    );

    shell.update(ticket('target: no active lane'));
    expect(head?.firstChild?.nodeValue).toBe('local tickets + GitHub');
    expect(head?.childNodes.length).toBe(2);
  });

  it('places extras as siblings of the body, before the foot', () => {
    const note = document.createElement('div');
    note.className = 'acp-harness__session-empty';
    note.textContent = 'no sessions for this project';
    const foot: OverlayShellProps['hints'] = {
      style: 'kbd',
      block: 'acp-review__foot',
      hints: [{ keys: ['esc'], label: 'close' }],
    };
    const shell = mount(review({ extras: [note], hints: foot }));
    const panel = shell.el.firstElementChild as HTMLElement;

    expect([...panel.children].map((child) => child.className)).toStrictEqual([
      'acp-review__head',
      'acp-review__body',
      'acp-harness__session-empty',
      'acp-review__foot',
    ]);

    shell.update(review({ hints: foot }));
    expect(note.isConnected).toBe(false);
    expect(panel.children.length).toBe(3);
  });

  it('carries root and panel attributes, and drops the ones that stop being derived', () => {
    const shell = mount(review({
      name: 'ticket',
      block: 'acp-ticket',
      rootAttrs: { role: 'dialog', tabindex: '0' },
      panelAttrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Working ticket' },
    }));
    const panel = shell.el.firstElementChild as HTMLElement;

    expect(shell.el.getAttribute('role')).toBe('dialog');
    expect(shell.el.getAttribute('tabindex')).toBe('0');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-label')).toBe('Working ticket');

    shell.update(review({
      name: 'ticket',
      block: 'acp-ticket',
      rootAttrs: { role: 'dialog' },
      panelAttrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Working ticket' },
    }));

    expect(shell.el.hasAttribute('tabindex')).toBe(false);
    expect(shell.el.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-label')).toBe('Working ticket');
  });
});
