import { afterEach, describe, expect, it } from 'vitest';

import type { AcpBackendDescriptor, AcpSessionInfo } from '../../types';
import { SessionPicker, type SessionPickerProps } from './index';

const BACKENDS: readonly AcpBackendDescriptor[] = [
  { id: 'claude', display_name: 'Claude Code', command: 'claude' },
  { id: 'codex', display_name: 'Codex', command: 'codex' },
];

const SESSIONS: readonly AcpSessionInfo[] = [
  {
    sessionId: '4f2a9c1d7e3b55aa',
    cwd: '/Users/wk/Source/krypton',
    title: '  harness components  ',
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  { sessionId: 'short', cwd: '/Users/wk/Source/other', title: null, updatedAt: null },
];

const pickers: SessionPicker[] = [];

const base = (over: Partial<SessionPickerProps> = {}): SessionPickerProps => ({
  open: true,
  phase: 'sessions',
  backends: BACKENDS,
  running: new Map([['claude', 2]]),
  backendCursor: 0,
  backendId: 'claude',
  sessions: SESSIONS,
  sessionCursor: 0,
  capabilities: { canList: true, canResume: true, canLoad: false },
  nextCursor: null,
  error: null,
  projectDir: '/Users/wk/Source/krypton',
  ...over,
});

const mount = (props: SessionPickerProps): SessionPicker => {
  const picker = new SessionPicker();
  pickers.push(picker);
  picker.update(props);
  return picker;
};

const watch = (node: Node): MutationObserver => {
  const observer = new MutationObserver(() => {
    /* read synchronously through takeRecords() */
  });
  observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  return observer;
};

const headSpans = (picker: SessionPicker): (string | null)[] =>
  [...(picker.el.querySelector('header')?.children ?? [])].map((span) => span.textContent);

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
});

describe('SessionPicker', () => {
  it('lists the backends, keyed by id rather than by index', () => {
    const picker = mount(base({ phase: 'backend' }));

    expect(picker.el.outerHTML).toBe(
      '<aside class="acp-harness__session-picker">' +
        '<header class="acp-harness__session-head">' +
        '<span>// resume session</span>' +
        '<span>j/k move · enter list · esc cancel</span>' +
        '</header>' +
        '<ul class="acp-harness__session-list">' +
        '<li class="acp-harness__session-row acp-harness__session-row--active" data-session-backend="claude">' +
        '<span class="acp-harness__session-title">Claude</span>' +
        '<span class="acp-harness__session-meta">claude</span>' +
        '<span class="acp-harness__session-action">2 running</span>' +
        '</li>' +
        '<li class="acp-harness__session-row" data-session-backend="codex">' +
        '<span class="acp-harness__session-title">Codex</span>' +
        '<span class="acp-harness__session-meta">codex</span>' +
        '<span class="acp-harness__session-action">select</span>' +
        '</li>' +
        '</ul>' +
        '</aside>',
    );
  });

  it('renders the loading phase as a note with no list', () => {
    const picker = mount(base({ phase: 'loading' }));

    expect(headSpans(picker)).toStrictEqual(['// Claude sessions', 'initializing...']);
    expect(picker.el.querySelector('ul')).toBeNull();
    expect(picker.el.querySelector('.acp-harness__session-empty')?.textContent).toBe(
      'loading sessions',
    );
  });

  it('renders the error phase with the reason and the recovery keys', () => {
    const picker = mount(base({ phase: 'error', error: 'probe exited 1' }));

    expect(headSpans(picker)).toStrictEqual([
      '// Claude sessions',
      'b switch backend · n fresh · esc cancel',
    ]);
    expect(picker.el.querySelector('.acp-harness__session-empty')?.textContent).toBe(
      'probe exited 1',
    );
  });

  it('falls back to a generic reason when the error phase carries none', () => {
    const picker = mount(base({ phase: 'error' }));

    expect(picker.el.querySelector('.acp-harness__session-empty')?.textContent).toBe(
      'session list unavailable',
    );
  });

  it('names the backend generically before one is chosen', () => {
    const picker = mount(base({ phase: 'loading', backendId: null }));

    expect(headSpans(picker)[0]).toBe('// backend sessions');
  });

  it('lists sessions with their short id, age and foreign cwd', () => {
    const picker = mount(base());
    const rows = [...picker.el.querySelectorAll('li')];

    expect(headSpans(picker)).toStrictEqual([
      '// Claude sessions',
      'enter resume · b backend · n fresh · esc cancel',
    ]);
    expect(rows[0].outerHTML).toBe(
      '<li class="acp-harness__session-row acp-harness__session-row--active">' +
        '<span class="acp-harness__session-title">harness components</span>' +
        '<span class="acp-harness__session-meta">4f2a9c1d · 5m ago</span>' +
        '<span class="acp-harness__session-action">resume</span>' +
        '</li>',
    );
    expect(rows[1].querySelector('.acp-harness__session-title')?.textContent).toBe(
      'untitled session',
    );
    expect(rows[1].querySelector('.acp-harness__session-meta')?.textContent).toBe(
      'short · /Users/wk/Source/other',
    );
  });

  it('offers load, then list only, as the capabilities shrink', () => {
    const picker = mount(base({ capabilities: { canList: true, canResume: false, canLoad: true } }));
    expect(picker.el.querySelector('.acp-harness__session-action')?.textContent).toBe('load');
    expect(headSpans(picker)[1]).toBe('enter load · b backend · n fresh · esc cancel');

    picker.update(base({ capabilities: { canList: true, canResume: false, canLoad: false } }));
    expect(picker.el.querySelector('.acp-harness__session-action')?.textContent).toBe('list only');
    expect(picker.el.querySelector('li')?.className).toBe(
      'acp-harness__session-row acp-harness__session-row--active acp-harness__session-row--disabled',
    );
  });

  it('announces a further page in the head', () => {
    const picker = mount(base({ nextCursor: 'page-2' }));

    expect(headSpans(picker)[1]).toBe(
      'enter resume · b backend · n fresh · PageDown more · esc cancel',
    );
  });

  it('keeps the empty and error notes as siblings BELOW the list', () => {
    const picker = mount(base({ sessions: [], error: 'listing truncated' }));

    expect([...picker.el.children].map((child) => child.className)).toStrictEqual([
      'acp-harness__session-head',
      'acp-harness__session-list',
      'acp-harness__session-empty',
      'acp-harness__session-error',
    ]);
    expect(picker.el.querySelector('.acp-harness__session-empty')?.textContent).toBe(
      'no sessions for this project',
    );
    expect(picker.el.querySelector('.acp-harness__session-error')?.textContent).toBe(
      'listing truncated',
    );
  });

  it('drops the notes again once a listing succeeds', () => {
    const picker = mount(base({ sessions: [], error: 'listing truncated' }));
    picker.update(base());

    expect([...picker.el.children].map((child) => child.className)).toStrictEqual([
      'acp-harness__session-head',
      'acp-harness__session-list',
    ]);
  });

  it('swaps phases without discarding the list it will come back to', () => {
    const picker = mount(base());
    const list = picker.el.querySelector('ul');
    const row = picker.el.querySelector('li');

    picker.update(base({ phase: 'loading' }));
    picker.update(base());

    expect(picker.el.querySelector('ul')).toBe(list);
    expect(picker.el.querySelector('li')).toBe(row);
  });

  it('moves --active without rebuilding a row', () => {
    const picker = mount(base({ sessionCursor: 0 }));
    const rows = [...picker.el.querySelectorAll('li')];
    const untouchedChild = rows[1].firstChild;

    picker.update(base({ sessionCursor: 1 }));

    expect([...picker.el.querySelectorAll('li')]).toStrictEqual(rows);
    expect(rows[0].className).toBe('acp-harness__session-row');
    expect(rows[1].className).toBe(
      'acp-harness__session-row acp-harness__session-row--active',
    );
    expect(rows[1].firstChild).toBe(untouchedChild);
  });

  it('re-derives the row class after the cursor comes back', () => {
    const picker = mount(base({ sessionCursor: 1 }));
    picker.update(base({ sessionCursor: 0 }));
    picker.update(base({ sessionCursor: 1 }));

    const rows = [...picker.el.querySelectorAll('li')];
    expect(rows[1].className).toBe('acp-harness__session-row acp-harness__session-row--active');
    expect(rows[0].className).toBe('acp-harness__session-row');
  });

  it('writes nothing to the DOM when the props say the same thing', () => {
    const picker = mount(base());
    const observer = watch(picker.el);

    picker.update(base());

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });
});
