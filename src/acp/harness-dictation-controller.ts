// Krypton — ACP Harness View: composer dictation controller (spec 246).
//
// Extracted from acp-harness-view.ts (spec 275). Owns the live speech
// recognition session and paints its preview into the composer the view renders.

import {
  DICTATION_LANG_ENGLISH,
  collectDictationResults,
  combineDictationText,
  dictationErrorMessage,
  dictationLanguageLabel,
  dictationPreviewParts,
  insertDictationText,
  speechRecognitionConstructor,
  type HarnessDictationSession,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from './harness-dictation';
import { esc } from './harness-format';
import type { HarnessLane } from './harness-view-types';
import type { HarnessDictationHost } from './harness-view-host';

export type ActiveDictationSession = HarnessDictationSession & { recognition: SpeechRecognitionLike };

export class HarnessDictationController {
  session: ActiveDictationSession | null = null;
  token = 0;

  constructor(private readonly host: HarnessDictationHost) {}

  /** The session when it belongs to `laneId`, else null. */
  sessionFor(laneId: string): ActiveDictationSession | null {
    return this.session?.laneId === laneId ? this.session : null;
  }

  renderInput(session: ActiveDictationSession): string {
    const parts = dictationPreviewParts(
      session.baseDraft,
      session.insertAt,
      session.finalText,
      session.interimText,
    );
    return (
      `${esc(parts.before)}` +
      `<span data-dictation-leading>${esc(parts.leading)}</span>` +
      `<span class="acp-harness__dictation-final" data-dictation-final>${esc(parts.finalText)}</span>` +
      `<span class="acp-harness__dictation-interim" data-dictation-interim>${esc(parts.interimText)}</span>` +
      `<span data-dictation-trailing>${esc(parts.trailing)}</span>` +
      `<span class="acp-harness__caret">█</span>${esc(parts.after)}`
    );
  }

  renderControl(lane: HarnessLane, session: ActiveDictationSession | null): string {
    if (!session && !speechRecognitionConstructor()) return '';
    const active = session?.laneId === lane.id;
    const phase = active ? session.phase : 'idle';
    const language = dictationLanguageLabel(session?.lang ?? DICTATION_LANG_ENGLISH);
    const label = phase === 'starting'
      ? `MIC ${language}`
      : phase === 'listening'
        ? `REC ${language}`
        : phase === 'stopping'
          ? 'FINALIZING…'
          : 'MIC';
    const ariaLabel = active ? 'Stop dictation' : 'Start English dictation';
    const title = active
      ? 'Stop dictation (Cmd+D)'
      : 'English: Cmd+D · Thai: Cmd+Shift+D';
    const keys = active
      ? '<span class="acp-harness__dictation-key">⌘D</span>'
      : '<span class="acp-harness__dictation-key">⌘D</span>'
        + '<span class="acp-harness__dictation-key">⇧D</span>';
    return (
      `<button class="acp-harness__dictation acp-harness__dictation--${phase}" type="button" ` +
      `data-dictation-toggle aria-label="${ariaLabel}" aria-pressed="${active}" title="${title}">` +
      `<span class="acp-harness__dictation-dot" aria-hidden="true">●</span>` +
      `<span data-dictation-label aria-live="polite">${label}</span>` +
      `${keys}</button>`
    );
  }

  patchComposer(): void {
    const session = this.session;
    if (!session || session.laneId !== this.host.activeLaneId) return;
    const parts = dictationPreviewParts(
      session.baseDraft,
      session.insertAt,
      session.finalText,
      session.interimText,
    );
    const updates: Array<[string, string]> = [
      ['[data-dictation-leading]', parts.leading],
      ['[data-dictation-final]', parts.finalText],
      ['[data-dictation-interim]', parts.interimText],
      ['[data-dictation-trailing]', parts.trailing],
    ];
    const composerEl = this.host.composerEl;
    for (const [selector, text] of updates) {
      const element = composerEl.querySelector<HTMLElement>(selector);
      if (element) element.textContent = text;
    }
    const button = composerEl.querySelector<HTMLButtonElement>('[data-dictation-toggle]');
    const label = button?.querySelector<HTMLElement>('[data-dictation-label]');
    if (!button || !label) return;
    button.className = `acp-harness__dictation acp-harness__dictation--${session.phase}`;
    const language = dictationLanguageLabel(session.lang);
    label.textContent = session.phase === 'starting'
      ? `MIC ${language}`
      : session.phase === 'listening'
        ? `REC ${language}`
        : 'FINALIZING…';
  }

  start(lane: HarnessLane, lang: string): void {
    if (this.session || !this.host.canStartDictation(lane)) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      this.host.flashChip('dictation unavailable in this webview');
      return;
    }

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Recognition();
    } catch {
      this.host.flashChip('dictation failed to start');
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    const token = ++this.token;
    const session: ActiveDictationSession = {
      token,
      laneId: lane.id,
      phase: 'starting',
      lang,
      baseDraft: lane.draft,
      insertAt: lane.cursor,
      finalText: '',
      interimText: '',
      cancelRequested: false,
      recognition,
    };
    this.session = session;
    recognition.onstart = (): void => {
      if (this.session?.token !== token || session.phase !== 'starting') return;
      session.phase = 'listening';
      this.patchComposer();
    };
    recognition.onresult = (event: SpeechRecognitionEventLike): void => {
      if (this.session?.token !== token) return;
      const result = collectDictationResults(event);
      session.finalText = result.finalText;
      session.interimText = result.interimText;
      this.patchComposer();
    };
    recognition.onerror = (event: SpeechRecognitionErrorEventLike): void => {
      if (this.session?.token !== token) return;
      this.finish(token, dictationErrorMessage(event.error));
    };
    recognition.onend = (): void => this.finish(token);
    this.host.element.focus({ preventScroll: true });
    this.host.renderComposer();
    try {
      recognition.start();
    } catch {
      this.finish(token, 'dictation failed to start');
    }
  }

  stop(): void {
    const session = this.session;
    if (!session || session.phase === 'stopping') return;
    session.phase = 'stopping';
    this.patchComposer();
    try {
      session.recognition.stop();
    } catch {
      this.finish(session.token, 'dictation failed to stop');
    }
  }

  finish(token: number, message?: string): void {
    const session = this.session;
    if (!session || session.token !== token || session.cancelRequested) return;
    this.session = null;
    this.token += 1;
    session.recognition.onstart = null;
    session.recognition.onresult = null;
    session.recognition.onerror = null;
    session.recognition.onend = null;
    const lane = this.host.lanes.find((candidate) => candidate.id === session.laneId);
    const speech = combineDictationText(session.finalText, session.interimText);
    if (lane && speech) {
      const inserted = insertDictationText(session.baseDraft, session.insertAt, speech);
      this.host.setDraft(lane, inserted.text, inserted.cursor);
    } else {
      this.host.renderComposer();
    }
    if (lane?.id === this.host.activeLaneId) this.host.element.focus({ preventScroll: true });
    if (message) this.host.flashChip(message);
    else if (!speech) this.host.flashChip('no speech heard');
  }

  abort(render = true): void {
    const session = this.session;
    if (!session) return;
    session.cancelRequested = true;
    this.session = null;
    this.token += 1;
    session.recognition.onstart = null;
    session.recognition.onresult = null;
    session.recognition.onerror = null;
    session.recognition.onend = null;
    const lane = this.host.lanes.find((candidate) => candidate.id === session.laneId);
    if (lane) {
      lane.draft = session.baseDraft;
      lane.cursor = session.insertAt;
    }
    try {
      session.recognition.abort();
    } catch {
      // Best-effort teardown: state and callbacks are already invalidated.
    }
    if (render) this.host.renderComposer();
  }
}
