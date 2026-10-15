import { describe, expect, it } from 'vitest';

import type { LanePeekSnapshot } from '../../harness-view-types';
import { ThoughtCard, type ThoughtCardProps } from './index';

function snapshot(thought: LanePeekSnapshot['thought']): LanePeekSnapshot {
  return {
    laneId: 'lane-1',
    displayName: 'claude-1',
    status: 'busy',
    active: true,
    stopped: false,
    visualIndex: 0,
    inboxDepth: 0,
    pendingPeers: [],
    latestInterLane: null,
    latestPermission: null,
    latestMeaningful: null,
    error: null,
    thought,
  };
}

function props(thought: LanePeekSnapshot['thought']): ThoughtCardProps {
  return { snapshot: snapshot(thought), projectDir: null };
}

/** Drive the teletype to the end: the print head advances one code point per pass. */
function drain(card: ThoughtCard, next: ThoughtCardProps, passes = 40): void {
  for (let i = 0; i < passes; i++) card.update(next);
}

describe('ThoughtCard', () => {
  it('emits the rail card the peek thought slot has today', () => {
    const card = new ThoughtCard(true);
    card.update(props({ phase: 'delta', text: 'the tail window' }));

    expect(card.el.tagName).toBe('ASIDE');
    expect(card.el.className).toBe('acp-harness__lane-thought');
    expect(card.el.dataset.laneId).toBe('lane-1');
    expect(card.el.dataset.phase).toBe('delta');
    expect(card.el.querySelector('.acp-harness__lane-thought-name')?.textContent)
      .toBe('claude-1');
    expect(card.el.querySelector('.acp-harness__lane-thought-label')?.textContent)
      .toBe('thinking');
    expect(card.body.className).toContain('acp-harness__lane-thought-body');
  });

  it('accumulates appended text into the body nodes it already owns', () => {
    const card = new ThoughtCard(true);
    card.update(props({ phase: 'delta', text: 'abc' }));
    const ghost = card.body.querySelector('.acp-harness__thought-ghost');
    const fresh = card.body.querySelector('.acp-harness__thought-fresh');
    expect(ghost).not.toBeNull();

    const shownFirst = card.body.textContent ?? '';
    drain(card, props({ phase: 'delta', text: 'abcdef ghij' }));

    expect(card.body.querySelector('.acp-harness__thought-ghost')).toBe(ghost);
    expect(card.body.querySelector('.acp-harness__thought-fresh')).toBe(fresh);
    expect((card.body.textContent ?? '').length).toBeGreaterThan(shownFirst.length);
    expect(card.body.textContent).toContain('abcdef ghij');
  });

  it('seals the live body and then writes nothing', () => {
    const card = new ThoughtCard(true);
    drain(card, props({ phase: 'delta', text: 'ported the thought card' }));
    expect(card.body.classList.contains('acp-harness__msg-body--thought-teletype')).toBe(true);
    expect(card.isLive).toBe(true);

    const sealed = props({ phase: 'seal', text: 'ported the thought card' });
    card.seal(sealed);

    expect(card.isLive).toBe(false);
    expect(card.body.classList.contains('acp-harness__msg-body--thought-teletype')).toBe(false);
    expect(card.body.querySelector('.acp-harness__thought-caret')).toBeNull();
    expect(card.body.textContent).toBe('ported the thought card');
    expect(card.el.dataset.phase).toBe('seal');
    expect(card.el.querySelector('.acp-harness__lane-thought-label')?.textContent).toBe('thought');

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(card.el, { subtree: true, childList: true, attributes: true, characterData: true });
    card.update(sealed);
    mutations += observer.takeRecords().length;
    observer.disconnect();
    expect(mutations).toBe(0);
  });

  it('a second seal is a no-op — the transition happens once', () => {
    const card = new ThoughtCard(true);
    drain(card, props({ phase: 'delta', text: 'one' }));
    card.seal(props({ phase: 'seal', text: 'one' }));
    const body = card.body.firstChild;

    card.seal(props({ phase: 'seal', text: 'two' }));
    expect(card.body.firstChild).toBe(body);
    expect(card.body.textContent).toBe('one');
  });

  it('repaints a static card when the sealed text is replaced', () => {
    const card = new ThoughtCard(false);
    card.update(props({ phase: 'seal', text: 'first' }));
    // A sealed thought goes through the markdown renderer, which adds its own
    // block trailer; the text is what matters.
    expect(card.body.textContent?.trim()).toBe('first');

    card.update(props({ phase: 'seal', text: 'second' }));
    expect(card.body.textContent?.trim()).toBe('second');
    expect(card.el.querySelector('.acp-harness__lane-thought-label')?.textContent).toBe('thought');
  });

  it('empties the body when the lane has no thought left', () => {
    const card = new ThoughtCard(false);
    card.update(props({ phase: 'seal', text: 'something' }));
    card.update(props(null));

    expect(card.el.dataset.phase).toBe('empty');
    expect(card.body.childNodes.length).toBe(0);
    expect(card.el.querySelector('.acp-harness__lane-thought-label')?.textContent).toBe('thought');
  });

  it('follows the lane the slot switched to', () => {
    const card = new ThoughtCard(false);
    card.update(props({ phase: 'seal', text: 'x' }));
    card.update({
      snapshot: { ...snapshot({ phase: 'seal', text: 'x' }), laneId: 'lane-9', displayName: 'codex-1' },
      projectDir: null,
    });

    expect(card.el.dataset.laneId).toBe('lane-9');
    expect(card.el.querySelector('.acp-harness__lane-thought-name')?.textContent).toBe('codex-1');
  });

  it('keeps its head nodes across every update', () => {
    const card = new ThoughtCard(false);
    card.update(props({ phase: 'seal', text: 'a' }));
    const name = card.el.querySelector('.acp-harness__lane-thought-name');
    const body = card.body;

    card.update(props({ phase: 'seal', text: 'b' }));
    expect(card.el.querySelector('.acp-harness__lane-thought-name')).toBe(name);
    expect(card.body).toBe(body);
  });
});
