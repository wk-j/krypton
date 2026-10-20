// Spec 302 §6.7 — `LiveVoiceStrip`.
//
// `patchStrip()` is what this component deletes: it re-finds the strip through
// `composerEl.querySelector('[data-live-strip]')` on every sample and writes
// five `textContent`s. Here the levels arrive as props, and the METER TEXT —
// not the raw level — is the dependency, so the nine samples out of ten that
// do not cross a segment boundary write nothing at all. The `data-live-*`
// attributes stay in the markup; they are the controller's handle until it
// holds the component instead.

import './live-voice-strip.css';

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import type { LivePhase } from '../../live-voice';
import type { ComponentDef } from '../types';

/** OMP parity: eight cells, full scale at RMS 0.2. */
const METER_SEGMENTS = 8;

/** The strip's key hint follows the microphone's push-to-talk state. */
const LIVE_KEYS: Record<'muted' | 'unmuted', string> = {
  muted: '⌘⇧L stop · hold left ⌥ to talk',
  unmuted: '⌘⇧L stop · release left ⌥ to mute',
};

export interface LiveVoiceSessionProps {
  readonly kind: 'session';
  readonly phase: LivePhase;
  /** The realtime voice name, e.g. `alloy`. */
  readonly voice: string;
  /** Microphone RMS, 0‥1. */
  readonly inputLevel: number;
  /** Model-output RMS, 0‥1. */
  readonly outputLevel: number;
  /** `you: …` / `live: …`, or the connecting placeholder. */
  readonly line: string;
  readonly muted: boolean;
}

export interface LiveVoiceNoteProps {
  readonly kind: 'note';
  readonly text: string;
  readonly error: boolean;
}

export type LiveVoiceStripProps =
  | LiveVoiceSessionProps
  | LiveVoiceNoteProps
  | { readonly kind: 'hidden' };

export function liveVoiceMeter(level: number): string {
  const on = Math.min(METER_SEGMENTS, Math.round(level * 40));
  return '█'.repeat(on) + '░'.repeat(METER_SEGMENTS - on);
}

export class LiveVoiceStrip extends Component<LiveVoiceStripProps> {
  private readonly labelEl: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly phaseTextEl: HTMLElement;
  private readonly voiceEl: HTMLElement;
  private readonly inMeterEl: HTMLElement;
  private readonly outMeterEl: HTMLElement;
  private readonly lineEl: HTMLElement;
  private readonly keysEl: HTMLElement;

  constructor() {
    super(el('div', { class: 'acp-harness__live' }));
    this.labelEl = el('span', { class: 'acp-harness__live-label', text: 'LIVE' });
    this.phaseTextEl = el('span', { attrs: { 'data-live-phase': true } });
    this.phaseEl = el('span', { class: 'acp-harness__live-phase' }, this.phaseTextEl);
    this.voiceEl = el('span', { class: 'acp-harness__live-voice' });
    this.inMeterEl = el('span', {
      class: 'acp-harness__live-meter acp-harness__live-meter--in',
      attrs: { 'data-live-in': true },
    });
    this.outMeterEl = el('span', {
      class: 'acp-harness__live-meter acp-harness__live-meter--out',
      attrs: { 'data-live-out': true },
    });
    this.lineEl = el('span', { class: 'acp-harness__live-line' });
    this.keysEl = el('span', {
      class: 'acp-harness__live-keys',
      attrs: { 'data-live-keys': true },
    });
  }

  protected readDeps(next: LiveVoiceStripProps): readonly unknown[] {
    if (next.kind === 'hidden') return ['hidden'];
    if (next.kind === 'note') return ['note', next.text, next.error];
    return [
      'session',
      next.phase,
      next.voice,
      liveVoiceMeter(next.inputLevel),
      liveVoiceMeter(next.outputLevel),
      next.line,
      next.muted,
    ];
  }

  protected syncClasses(next: LiveVoiceStripProps): void {
    const modifier = next.kind === 'session'
      ? `acp-harness__live--${next.phase}`
      : next.kind === 'note'
        ? `acp-harness__live--${next.error ? 'error' : 'ended'}`
        : null;
    this.el.className = classes('acp-harness__live', modifier);
    this.el.hidden = next.kind === 'hidden';
  }

  protected paint(next: LiveVoiceStripProps): void {
    this.syncClasses(next);
    if (next.kind === 'hidden') {
      syncOrder(this.el, []);
      return;
    }
    if (next.kind === 'note') {
      // The end note is not patched by anyone, so it carries no handles.
      this.el.removeAttribute('data-live-strip');
      this.lineEl.removeAttribute('data-live-line');
      this.lineEl.textContent = next.text;
      syncOrder(this.el, [this.labelEl, this.lineEl]);
      return;
    }
    setAttr(this.el, 'data-live-strip', true);
    setAttr(this.lineEl, 'data-live-line', true);
    this.phaseTextEl.textContent = next.phase;
    this.voiceEl.textContent = next.voice;
    this.inMeterEl.textContent = liveVoiceMeter(next.inputLevel);
    this.outMeterEl.textContent = liveVoiceMeter(next.outputLevel);
    this.lineEl.textContent = next.line;
    this.keysEl.textContent = LIVE_KEYS[next.muted ? 'muted' : 'unmuted'];
    syncOrder(this.el, [
      this.labelEl,
      this.phaseEl,
      this.voiceEl,
      this.inMeterEl,
      this.outMeterEl,
      this.lineEl,
      this.keysEl,
    ]);
  }
}

export const def: ComponentDef = {
  id: 'live-voice-strip',
  blocks: [
    'acp-harness__live',
    'acp-harness__live-label',
    'acp-harness__live-phase',
    'acp-harness__live-voice',
    'acp-harness__live-meter',
    'acp-harness__live-line',
    'acp-harness__live-keys',
  ],
};
