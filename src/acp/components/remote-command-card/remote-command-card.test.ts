import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteCommandPayload } from '../../harness-view-types';
import { RemoteCommandCard } from './index';

const payload: RemoteCommandPayload = { source: 'cli', computerId: 'host-with-a-long-requested-name', command: 'printf "  first\\n"', cwd: null, result: null, error: null, outcomeUnknown: false, displayTruncated: [] };
const cards: RemoteCommandCard[] = [];
function mount(data = payload, status = 'pending'): RemoteCommandCard {
  const card = new RemoteCommandCard();
  cards.push(card);
  document.body.append(card.el);
  card.update({ payload: data, status, hintLabel: null });
  return card;
}
afterEach(() => { for (const card of cards.splice(0)) card.dispose(); document.body.replaceChildren(); });

describe('RemoteCommandCard', () => {
  it('exposes full metadata through titles and a keyboard hint without extra generic output', () => {
    const card = mount();
    expect(card.el.textContent).toContain('Pending');
    expect(card.el.querySelector('[title="host-with-a-long-requested-name"]')).not.toBeNull();
    expect(card.el.querySelector('.acp-remote-command-card__command')?.getAttribute('title')).toBe(payload.command);
    const details = card.el.querySelector('[data-remote-command-details]')!;
    card.setHint('ab');
    expect(details.querySelector('kbd')?.textContent).toBe('ab');
    card.setHint(null);
    expect(details.querySelector('kbd')).toBeNull();
    expect(card.el.querySelector('[data-started-at]')).toBeNull();
  });

  it('shows at most four lines with separate stream labels and failure stderr first', () => {
    const result = { exitCode: 2, outcome: 'completed' as const, stdout: '  one\ntwo\nthree\nfour', stderr: '<script>bad</script>\n  detail', truncated: true };
    const card = mount({ ...payload, result, displayTruncated: ['stdout'] }, 'completed');
    const streams = [...card.el.querySelectorAll('[data-stream]')];
    expect(streams.map((stream) => stream.getAttribute('data-stream'))).toEqual(['stderr', 'stdout']);
    expect(streams[0].querySelector('pre')?.textContent).toBe('<script>bad</script>\n  detail');
    expect(streams[1].querySelector('pre')?.textContent).toBe('  one\ntwo');
    expect(card.el.querySelector('script')).toBeNull();
    expect(card.el.textContent).toContain('Failed · exit 2');
    expect(card.el.textContent).toContain('More output in Details.');
    expect(card.el.textContent).toContain('Backend output limit reached.');
    expect(card.el.textContent).toContain('Display limit reached: stdout.');
  });

  it('keeps settled state and output nodes during late streaming replay and failure updates', () => {
    const result = { exitCode: 0, outcome: 'completed' as const, stdout: 'first', stderr: '', truncated: false };
    const card = mount({ ...payload, result }, 'completed');
    const output = card.el.querySelector('pre')!;
    const first = output.firstChild;
    card.update({ payload: { ...payload, result: { ...result, stdout: 'first\nsecond' } }, status: 'in_progress', hintLabel: null });
    expect(card.el.dataset.state).toBe('done');
    expect(card.el.querySelector('pre')).toBe(output);
    expect(output.firstChild).toBe(first);
    expect(output.textContent).toBe('first\nsecond');
    card.update({ payload: { ...payload, result }, status: 'failed', hintLabel: null });
    expect(card.el.textContent).toContain('Tool failed');
  });

  it('retains malformed result diagnostics separately and never claims remote success', () => {
    const card = mount(payload, 'completed');
    card.update({ payload, status: 'completed', hintLabel: null, diagnostics: [{ label: 'output', text: '{broken\n1\n2\n3\n4' }] });
    expect(card.el.textContent).toContain('Remote result not reported');
    expect(card.el.querySelector('[data-stream]')?.textContent).toContain('Diagnostic (output)');
    expect(card.el.querySelector('pre')?.textContent).toBe('{broken\n1\n2\n3');
    expect(card.el.textContent).toContain('More output in Details.');
  });

});
