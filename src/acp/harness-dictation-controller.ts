// Krypton — ACP Harness View: composer dictation controller (spec 246).
//
// Extracted from acp-harness-view.ts (spec 275). Owns the live speech
// recognition session; `DictationControl` / `DictationPreview` (spec 302 §6.6)
// paint it. A speech result invalidates the composer region and the components
// update from the session — the controller never reaches into the DOM.

import {
  collectDictationResults,
  combineDictationText,
  dictationErrorMessage,
  insertDictationText,
  speechRecognitionConstructor,
  type HarnessDictationSession,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from './harness-dictation';
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
      this.host.invalidate('composer');
    };
    recognition.onresult = (event: SpeechRecognitionEventLike): void => {
      if (this.session?.token !== token) return;
      const result = collectDictationResults(event);
      session.finalText = result.finalText;
      session.interimText = result.interimText;
      this.host.invalidate('composer');
    };
    recognition.onerror = (event: SpeechRecognitionErrorEventLike): void => {
      if (this.session?.token !== token) return;
      this.finish(token, dictationErrorMessage(event.error));
    };
    recognition.onend = (): void => this.finish(token);
    this.host.element.focus({ preventScroll: true });
    this.host.invalidate('composer');
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
    this.host.invalidate('composer');
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
      this.host.invalidate('composer');
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
    if (render) this.host.invalidate('composer');
  }
}
