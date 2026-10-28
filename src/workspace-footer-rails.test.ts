import { describe, expect, it } from 'vitest';

import { railsFooterView, type RailsFooterEntry } from './workspace-footer-rails';

const entry = (
  state: RailsFooterEntry['state'],
  findings = 0,
  failedCheck: string | null = null,
): RailsFooterEntry => ({ state, findings, failedCheck });

describe('railsFooterView', () => {
  it('hides with no sources or when every source is none', () => {
    expect(railsFooterView([])).toBeNull();
    expect(railsFooterView([entry('none'), entry('none', 4)])).toBeNull();
  });

  it('shows clean as RAILS ✓, neutral', () => {
    expect(railsFooterView([entry('clean'), entry('none')])).toMatchObject({ text: 'RAILS ✓', fault: false });
  });

  it('sums findings across the harnesses reporting findings, neutral', () => {
    const view = railsFooterView([entry('findings', 2), entry('clean'), entry('findings', 3), entry('running')]);
    expect(view).toMatchObject({ text: 'RAILS 5', fault: false });
    expect(view?.title).toBe('Rails: 5 open findings — see the Rails tab');
  });

  it('lets a failed check win over findings and errors, and only it is a fault', () => {
    const view = railsFooterView([entry('findings', 3), entry('check_failed', 0, 'typecheck'), entry('error')]);
    expect(view).toMatchObject({ text: 'RAILS ✗ typecheck', fault: true });
    expect(railsFooterView([entry('error'), entry('findings', 1)])).toMatchObject({ text: 'RAILS error', fault: false });
  });

  it('counts further failed harnesses after the first check name', () => {
    const view = railsFooterView([entry('check_failed', 0, 'test'), entry('check_failed', 0, 'lint')]);
    expect(view?.text).toBe('RAILS ✗ test +1');
    expect(railsFooterView([entry('check_failed')])?.text).toBe('RAILS ✗');
  });

  it('orders the neutral states: findings > paused > running > clean', () => {
    expect(railsFooterView([entry('running'), entry('paused')])?.text).toBe('RAILS paused');
    expect(railsFooterView([entry('clean'), entry('running')])?.text).toBe('RAILS …');
    expect(railsFooterView([entry('paused'), entry('findings', 1)])?.text).toBe('RAILS 1');
    for (const state of ['running', 'paused', 'error', 'findings', 'clean'] as const) {
      expect(railsFooterView([entry(state, 1)])?.fault).toBe(false);
    }
  });
});
