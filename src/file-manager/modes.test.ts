// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { filterEntries } from './filter';
import { handleConfirmKey, handleFilterKey, handlePromptKey, handleSearchKey, type ModeCtx } from './modes';
import { createState } from './state';
import { entry, key } from './test-fixtures';

function fakeCtx() {
  const state = createState('/r');
  state.entries = [entry('alpha'), entry('beta')];
  state.filtered = [...state.entries];
  const ctx = {
    state,
    refilter: vi.fn(() => { state.filtered = filterEntries(state.entries, state.filterText); }),
    renderList: vi.fn(),
    renderStatus: vi.fn(),
    renderBreadcrumb: vi.fn(),
    moveSearchCursor: vi.fn(),
    selectSearchResult: vi.fn(),
    scheduleSearchUpdate: vi.fn(),
    cancelSearchUpdate: vi.fn(),
  } satisfies ModeCtx;
  return ctx;
}

describe('handlePromptKey', () => {
  it('types, deletes, submits and cancels', () => {
    const ctx = fakeCtx();
    const onSubmit = vi.fn();
    ctx.state.prompt = { label: 'L', value: 'ab', onSubmit };
    handlePromptKey(ctx, key('Backspace'));
    handlePromptKey(ctx, key('c'));
    handlePromptKey(ctx, key('x', { ctrl: true }));
    expect(ctx.state.prompt?.value).toBe('ac');
    expect(ctx.renderStatus).toHaveBeenCalledTimes(3);
    handlePromptKey(ctx, key('Enter'));
    expect(onSubmit).toHaveBeenCalledWith('ac');
    expect(ctx.state.prompt).toBeNull();
    ctx.state.prompt = { label: 'L', value: '', onSubmit };
    handlePromptKey(ctx, key('Escape'));
    expect(ctx.state.prompt).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('handleFilterKey', () => {
  it('Enter keeps the text, Escape clears and resets the cursor', () => {
    const ctx = fakeCtx();
    ctx.state.filterMode = true;
    handleFilterKey(ctx, key('b'));
    expect(ctx.state.filtered.map((e) => e.name)).toEqual(['beta']);
    handleFilterKey(ctx, key('Enter'));
    expect(ctx.state.filterMode).toBe(false);
    expect(ctx.state.filterText).toBe('b');
    ctx.state.filterMode = true;
    ctx.state.cursor = 1;
    handleFilterKey(ctx, key('Escape'));
    expect(ctx.state.filterText).toBe('');
    expect(ctx.state.cursor).toBe(0);
    expect(ctx.state.filtered).toHaveLength(2);
  });

  it('swallows non-printable keys without re-filtering', () => {
    const ctx = fakeCtx();
    expect(handleFilterKey(ctx, key('ArrowLeft'))).toBe(true);
    expect(ctx.refilter).not.toHaveBeenCalled();
  });
});

describe('handleSearchKey', () => {
  it('routes ctrl+j / ctrl+k / arrows, ctrl+u clears, Escape tears down', () => {
    const ctx = fakeCtx();
    const s = ctx.state.search;
    s.active = true;
    s.text = 'ab';
    s.pool = ['x'];
    s.poolLower = ['x'];
    s.results = ['x'];
    handleSearchKey(ctx, key('j', { ctrl: true }));
    handleSearchKey(ctx, key('ArrowUp'));
    expect(ctx.moveSearchCursor.mock.calls).toEqual([[1], [-1]]);
    handleSearchKey(ctx, key('u', { ctrl: true }));
    expect(s.text).toBe('');
    expect(ctx.scheduleSearchUpdate).toHaveBeenCalledTimes(1);
    handleSearchKey(ctx, key('q'));
    expect(s.text).toBe('q');
    expect(ctx.renderBreadcrumb).toHaveBeenCalledTimes(2);
    handleSearchKey(ctx, key('Enter'));
    expect(ctx.selectSearchResult).toHaveBeenCalledTimes(1);
    handleSearchKey(ctx, key('Escape'));
    expect(s).toMatchObject({ active: false, text: '', pool: [], poolLower: [], results: [] });
    expect(ctx.cancelSearchUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('handleConfirmKey', () => {
  it('runs only on y; any other key cancels (P11)', () => {
    const ctx = fakeCtx();
    const action = vi.fn();
    ctx.state.confirmAction = action;
    expect(handleConfirmKey(ctx, key('n'))).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(ctx.state.confirmAction).toBeNull();
    expect(ctx.renderStatus).toHaveBeenCalledTimes(1);
    ctx.state.confirmAction = action;
    handleConfirmKey(ctx, key('y'));
    expect(action).toHaveBeenCalledTimes(1);
    expect(ctx.state.confirmAction).toBeNull();
  });
});
