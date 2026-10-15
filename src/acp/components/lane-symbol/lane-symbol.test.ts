import { describe, expect, it } from 'vitest';

import type { HarnessLaneStatus } from '../../types';
import { tickAllSpinners } from '../spinner';
import { LaneSymbol, statusLabel } from './index';

describe('LaneSymbol', () => {
  it('renders every status in the vocabulary', () => {
    const cases: readonly { status: HarnessLaneStatus; inner: string }[] = [
      { status: 'starting', inner: '#krypton-icon-status-starting' },
      { status: 'idle', inner: '' },
      { status: 'busy', inner: 'spinner' },
      { status: 'needs_permission', inner: '#krypton-icon-status-perm' },
      { status: 'awaiting_peer', inner: '#krypton-icon-status-peer' },
      { status: 'error', inner: '#krypton-icon-status-error' },
      { status: 'stopped', inner: '#krypton-icon-status-error' },
    ];

    for (const { status, inner } of cases) {
      const symbol = new LaneSymbol();
      symbol.update({ status });
      expect(symbol.el.className).toBe(`acp-harness__lane-symbol acp-harness__lane-symbol--${status}`);
      if (inner === '') {
        expect(symbol.el.childNodes.length).toBe(0);
      } else if (inner === 'spinner') {
        expect(symbol.el.querySelector('.acp-harness__spinner')).not.toBeNull();
      } else {
        expect(symbol.el.querySelector('use')?.getAttribute('href')).toBe(inner);
      }
      symbol.dispose();
    }
  });

  it('keeps the status vocabulary unchanged', () => {
    expect([
      statusLabel('starting'),
      statusLabel('idle'),
      statusLabel('busy'),
      statusLabel('needs_permission'),
      statusLabel('awaiting_peer'),
      statusLabel('error'),
      statusLabel('stopped'),
    ]).toEqual(['starting', 'idle', 'busy', 'action required', 'awaiting peer', 'error', 'stopped']);
  });

  it('re-derives the whole class string, so the old status modifier cannot linger', () => {
    const symbol = new LaneSymbol();
    symbol.update({ status: 'needs_permission' });
    expect(symbol.el.className).toContain('--needs_permission');

    symbol.update({ status: 'idle' });
    expect(symbol.el.className).toBe('acp-harness__lane-symbol acp-harness__lane-symbol--idle');
    expect(symbol.el.className).not.toContain('needs_permission');
    symbol.dispose();
  });

  it('drops the spinner and unregisters it from the tick when the lane stops being busy', () => {
    const symbol = new LaneSymbol();
    symbol.update({ status: 'busy' });
    const glyph = symbol.el.querySelector<HTMLElement>('.acp-harness__spinner');
    expect(glyph).not.toBeNull();
    const first = glyph?.textContent;
    tickAllSpinners();
    expect(glyph?.textContent).not.toBe(first);

    symbol.update({ status: 'idle' });
    expect(symbol.el.querySelector('.acp-harness__spinner')).toBeNull();

    const parked = glyph?.textContent;
    tickAllSpinners();
    tickAllSpinners();
    expect(glyph?.textContent).toBe(parked);
    symbol.dispose();
  });

  it('writes nothing while the status holds', () => {
    const symbol = new LaneSymbol();
    symbol.update({ status: 'error' });
    const icon = symbol.el.firstChild;
    symbol.update({ status: 'error' });
    expect(symbol.el.firstChild).toBe(icon);
    symbol.dispose();
  });

  it('unregisters the spinner on dispose, not only on a status change', () => {
    const symbol = new LaneSymbol();
    symbol.update({ status: 'busy' });
    const glyph = symbol.el.querySelector<HTMLElement>('.acp-harness__spinner');
    symbol.dispose();

    const parked = glyph?.textContent;
    tickAllSpinners();
    expect(glyph?.textContent).toBe(parked);
  });
});
