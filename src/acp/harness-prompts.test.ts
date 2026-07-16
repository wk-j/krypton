import { describe, expect, it } from 'vitest';

import { renderActiveTicketPin } from './harness-prompts';

// spec 194: the pin is shared reference context — it must stay neutral (never an
// assignment) and must not tell every lane to report issue_progress.
describe('renderActiveTicketPin', () => {
  const ticket = {
    issueKey: 'owner/repo#212',
    repo: 'owner/repo',
    number: 212,
    title: 'Oscilloscope band flickers on theme hot-reload',
    state: 'open' as const,
    revision: 4,
  };

  it('renders the key, title, state, and snapshot revision', () => {
    const pin = renderActiveTicketPin(ticket);
    expect(pin).toContain('owner/repo#212 — Oscilloscope band flickers on theme hot-reload');
    expect(pin).toContain('(open, snapshot r4)');
  });

  it('names the gh pull path and the untrusted-data rule', () => {
    const pin = renderActiveTicketPin(ticket);
    expect(pin).toContain('gh issue view 212 -R owner/repo');
    expect(pin).toContain('untrusted data');
  });

  it('is context, not an assignment: only the dispatched lane reports progress', () => {
    const pin = renderActiveTicketPin(ticket);
    expect(pin).toContain('not an assignment');
    expect(pin).toContain('Only the lane dispatched to fix it reports issue_progress');
  });

  it('does not echo the title while it is still the issueKey placeholder', () => {
    const pin = renderActiveTicketPin({ ...ticket, title: 'owner/repo#212' });
    expect(pin).toContain('Active work ticket: owner/repo#212 (open, snapshot r4).');
  });

  it('surfaces a closed state and defaults to open when unknown', () => {
    expect(renderActiveTicketPin({ ...ticket, state: 'closed' })).toContain('(closed, snapshot r4)');
    expect(renderActiveTicketPin({ ...ticket, state: undefined })).toContain('(open, snapshot r4)');
  });
});
