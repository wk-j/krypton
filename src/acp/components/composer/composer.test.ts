import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Composer, type ComposerDraftProps, type ComposerPaletteProps } from './index';

// Spec 302 §6.1.
//
// `renderComposer` used to CONCATENATE fragments, and four of them returned the
// empty string when they had nothing to say: the peer strip, the live-voice
// strip, the staging strip and each of the four inline palettes. The component
// keeps one node per child for its lifetime and sets `hidden` instead — which
// only works if the child's own stylesheet beats the UA's `[hidden]` rule back.
// It did not for the palettes, and four empty bordered bars stacked up above
// the input line on every idle composer.

const EMPTY_PALETTE: ComposerPaletteProps = { rows: [], cursor: 0, hint: '' };

function idleProps(): ComposerDraftProps {
  return {
    kind: 'draft',
    accent: '#c77dff',
    command: false,
    memory: false,
    dictating: false,
    meta: {
      segments: [{ id: 'text', text: 'idle' }],
      running: false,
      chips: [],
      branch: null,
      helpHint: '? help',
    },
    dictation: null,
    peer: { laneStatus: 'idle', pendingPeers: [], inboxDepth: 0 },
    liveVoice: { kind: 'hidden' },
    staging: { images: [] },
    mention: EMPTY_PALETTE,
    slash: EMPTY_PALETTE,
    hash: EMPTY_PALETTE,
    verb: EMPTY_PALETTE,
    draft: { laneName: 'OMP-1', running: false, draft: '', cursor: 0, ghost: null, dictation: null },
  };
}

/** A sheet's `display` for a block must lose to that block's `[hidden]`. */
function hidesWhenHidden(dir: string, file: string, block: string): boolean {
  const css = readFileSync(join(import.meta.dirname, '..', dir, file), 'utf8');
  const rule = new RegExp(`\\.${block}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`, 'u');
  return rule.test(css);
}

describe('Composer', () => {
  it('shows only the chrome and the input line when nothing else has content', () => {
    const composer = new Composer();
    composer.update(idleProps());

    const visible = [...composer.el.children].filter((child) => !(child as HTMLElement).hidden);
    expect(visible.map((child) => child.className)).toEqual([
      'acp-harness__composer-chrome',
      'acp-harness__input-line',
    ]);
  });

  it('keeps every optional child mounted so it never has to be rebuilt', () => {
    const composer = new Composer();
    composer.update(idleProps());

    // Four palettes, peer strip, live-voice strip, staging strip: present but
    // hidden.
    const hidden = [...composer.el.children].filter((child) => (child as HTMLElement).hidden);
    expect(hidden).toHaveLength(7);
  });

  it('gives every optional child a stylesheet rule that honours `hidden`', () => {
    // `display: flex` on the block outranks the UA's `[hidden] { display: none }`,
    // so each of these sheets has to say it again itself.
    const offenders = (
      [
        ['inline-palette', 'inline-palette.css', 'acp-harness__slash-palette'],
        ['peer-strip', 'peer-strip.css', 'acp-harness__composer-peer'],
        ['staging-strip', 'staging-strip.css', 'acp-harness__staging'],
        ['live-voice-strip', 'live-voice-strip.css', 'acp-harness__live'],
      ] as const
    ).filter(([dir, file, block]) => !hidesWhenHidden(dir, file, block));
    expect(offenders).toEqual([]);
  });

  it('swaps to the decision row without leaving the draft children behind', () => {
    const composer = new Composer();
    composer.update(idleProps());
    composer.update({
      kind: 'decision',
      accent: '#c77dff',
      liveVoice: { kind: 'hidden' },
      decision: { label: 'perm', hint: 'a accept · A all · r reject · R all' },
    });

    expect(composer.el.className).toContain('acp-harness__composer--permission');
    expect(composer.el.querySelector('.acp-harness__input-line')).toBeNull();
    expect(composer.el.querySelector('.acp-harness__slash-palette')).toBeNull();
    expect(composer.el.querySelector('.acp-harness__permission-row')).not.toBeNull();
  });
});
