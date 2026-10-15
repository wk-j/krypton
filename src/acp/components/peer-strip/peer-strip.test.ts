import { describe, expect, it } from 'vitest';

import type { PendingPeerSummary } from '../../inter-lane';
import { PeerStrip, type PeerStripProps } from './index';

const peer = (toDisplayName: string, ageMs: number): PendingPeerSummary => ({
  toLaneId: `${toDisplayName}-id`,
  toDisplayName,
  envelopeId: `env-${toDisplayName}`,
  sentAt: Date.now() - ageMs,
});

const IDLE: PeerStripProps = { laneStatus: 'idle', pendingPeers: [], inboxDepth: 0 };

const writes = (el: HTMLElement, run: () => void): number => {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
};

const mount = (props: PeerStripProps): PeerStrip => {
  const strip = new PeerStrip();
  strip.update(props);
  return strip;
};

describe('PeerStrip', () => {
  it('names the awaited peer and what #cancel drops', () => {
    const strip = mount({ ...IDLE, pendingPeers: [peer('codex-1', 6 * 60_000)] });

    expect(strip.el.outerHTML).toBe(
      '<div class="acp-harness__composer-peer" role="status">' +
        '⇆ awaiting codex-1 · 5m+ · #cancel drops pending lane-mail wait</div>',
    );
  });

  it('counts awaited peers rather than listing them', () => {
    const strip = mount({
      ...IDLE,
      laneStatus: 'awaiting_peer',
      pendingPeers: [peer('codex-1', 20 * 60_000), peer('grok-1', 30_000)],
    });

    expect(strip.el.textContent)
      .toBe('⇆ awaiting 2 peers · 15m+ · #cancel drops pending lane-mail wait');
  });

  it('falls back to the inbox depth, singular and plural', () => {
    const strip = mount({ ...IDLE, inboxDepth: 1 });
    expect(strip.el.textContent).toBe('▼1 lane mail queued');

    strip.update({ ...IDLE, inboxDepth: 3 });
    expect(strip.el.textContent).toBe('▼3 lane mails queued');
  });

  it('keeps the soft awaiting line when the lane waits with an empty queue', () => {
    const strip = mount({ ...IDLE, laneStatus: 'awaiting_peer' });
    expect(strip.el.textContent).toBe('awaiting lane mail · #cancel drops pending wait');
  });

  it('hides itself when there is nothing to say, and re-derives on the way back', () => {
    const strip = mount({ ...IDLE, inboxDepth: 2 });
    expect(strip.el.hidden).toBe(false);

    strip.update(IDLE);
    expect(strip.el.hidden).toBe(true);
    expect(strip.el.textContent).toBe('');

    strip.update({ ...IDLE, inboxDepth: 2 });
    expect(strip.el.hidden).toBe(false);
    expect(strip.el.className).toBe('acp-harness__composer-peer');
  });

  it('writes nothing while the age bucket holds', () => {
    const props: PeerStripProps = { ...IDLE, pendingPeers: [peer('codex-1', 6 * 60_000)] };
    const strip = mount(props);

    const count = writes(strip.el, () => {
      strip.update({ ...props, pendingPeers: [...props.pendingPeers] });
    });

    expect(count).toBe(0);
  });

  it('repaints when the age bucket moves on', () => {
    const strip = mount({ ...IDLE, pendingPeers: [peer('codex-1', 2 * 60_000)] });
    expect(strip.el.textContent).toContain('1m+');

    strip.update({ ...IDLE, pendingPeers: [peer('codex-1', 20 * 60_000)] });
    expect(strip.el.textContent).toContain('15m+');
  });
});
