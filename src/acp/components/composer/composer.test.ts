import { describe, expect, it } from 'vitest';

import { Composer, type ComposerDraftProps, type ComposerPaletteProps } from './index';
import type { BackgroundTask } from '../../harness-view-types';

// Spec 302 §6.1.
//
// `renderComposer` used to CONCATENATE fragments, and four of them returned the
// empty string when they had nothing to say: the peer strip, the live-voice
// strip, the staging strip and each of the four inline palettes. The component
// keeps one node per child for its lifetime and sets `hidden` instead — which
// only works if the child's own stylesheet beats the UA's `[hidden]` rule back.
// It did not for the palettes, and four empty bordered bars stacked up above
// the input line on every idle composer.

const EMPTY_PALETTE: ComposerPaletteProps = { rows: [], cursor: 0, hint: [] };

function idleProps(): ComposerDraftProps {
  return {
    kind: 'draft',
    accent: '#c77dff',
    background: { tasks: [], now: 0 },
    command: false,
    memory: false,
    dictating: false,
    meta: {
      segments: [{ id: 'text', text: 'idle' }],
      running: false,
      chips: [],
      branch: null,
      helpHint: [{ keys: ['?'], label: 'help' }],
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

  it('prints the peer readout last in the chrome row, and keeps it there when the row repaints', () => {
    const composer = new Composer();
    const props = idleProps();
    composer.update({ ...props, peer: { ...props.peer, inboxDepth: 1 } });
    composer.update({
      ...props,
      meta: { ...props.meta, branch: { ref: 'master', title: '' } },
      peer: { ...props.peer, inboxDepth: 1 },
    });

    const run = composer.el.querySelector('.acp-harness__composer-meta');
    const last = run?.lastElementChild as HTMLElement | null | undefined;
    expect(last?.className).toBe('acp-harness__composer-peer');
    expect(last?.hidden).toBe(false);
    expect(last?.textContent).toBe('▼1 lane mail queued');
    expect(composer.el.querySelectorAll('.acp-harness__composer-peer')).toHaveLength(1);
  });

  it('swaps to the decision row without leaving the draft children behind', () => {
    const composer = new Composer();
    composer.update(idleProps());
    composer.update({
      kind: 'decision',
      accent: '#c77dff',
      background: { tasks: [], now: 0 },
      liveVoice: { kind: 'hidden' },
      decision: { label: 'perm', hint: [{ keys: ['a'], label: 'accept' }, { keys: ['r'], label: 'reject' }] },
    });

    expect(composer.el.className).toContain('acp-harness__composer--permission');
    expect(composer.el.querySelector('.acp-harness__input-line')).toBeNull();
    expect(composer.el.querySelector('.acp-harness__slash-palette')).toBeNull();
    expect(composer.el.querySelector('.acp-harness__permission-row')).not.toBeNull();
  });

  it('keeps background activity visible across decision pre-emption and clears it for another lane', () => {
    const composer = new Composer();
    const task: BackgroundTask = {
      id: 'job-1', toolCallId: 'call-1', command: 'mvn test',
      observation: { kind: 'claude-output', outputPath: '/tmp/job-1.output' },
      startedAt: 1_000, state: 'running', exitCode: null, endedAt: null, bytes: 0,
      lastLine: 'Building', pid: null, cpuPercent: null, rssMb: null, missStreak: 0,
    };
    const background = { tasks: [task], now: 3_000 };
    const props = { ...idleProps(), background };
    composer.update(props);
    const strip = composer.el.querySelector<HTMLElement>('.acp-harness__background-strip')!;
    const draft = composer.el.querySelector('.acp-harness__input');
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain('mvn test');
    task.lastLine = 'Tests started';
    composer.patchBackgroundTasks({ tasks: [task], now: 4_000 });
    expect(strip.textContent).toContain('Tests started');
    expect(composer.el.querySelector('.acp-harness__input')).toBe(draft);
    composer.update({
      kind: 'decision', accent: props.accent, background,
      liveVoice: { kind: 'hidden' }, decision: { label: 'perm', hint: [] },
    });
    expect(composer.el.querySelector('.acp-harness__background-strip')).toBe(strip);
    expect(strip.hidden).toBe(false);
    expect(composer.el.querySelector('.acp-harness__permission-row')).not.toBeNull();
    composer.update(idleProps());
    expect(strip.hidden).toBe(true);
    expect(strip.textContent).not.toContain('mvn test');
    composer.update({ kind: 'empty' });
    expect(composer.el.querySelector('.acp-harness__background-strip')).toBeNull();
    composer.dispose();
  });
});
