// Krypton — ACP Harness View: live voice controller (spec 280).
//
// One realtime voice session, bound to one lane. WebKit owns the media
// (mic capture with echo cancellation, Opus, playback); Rust owns the two
// steps that need the Codex OAuth token — signaling and the sideband socket —
// so the token never reaches this webview. The voice model delegates real work;
// each delegation becomes an ordinary prompt on the bound lane, and the lane's
// progress and final answer are appended back for the model to speak.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { esc } from './harness-format';
import { errorText } from './harness-permission-scan';
import type { HarnessLiveVoiceHost } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';
import {
  LiveDelegationLedger,
  LiveTranscript,
  SESSION_CLOSE,
  TURN_CANCELLED_TEXT,
  delegationAppends,
  finalMessageText,
  liveErrorMessage,
  parseLiveCommand,
  parseLiveServerEvent,
  permissionRequestText,
  rejectedDelegationText,
  renderLiveInstructions,
  type LiveClientMessage,
  type LivePhase,
  type LiveServerEvent,
} from './live-voice';
import type { HarnessLaneStatus, StopReason } from './types';

/** Output RMS above which the model counts as speaking (OMP `OUTPUT_ACTIVE_LEVEL`). */
const SPEAKING_LEVEL = 0.015;
const LEVEL_INTERVAL_MS = 100;
const METER_SEGMENTS = 8;
const DATA_CHANNEL_TIMEOUT_MS = 20_000;
const END_NOTE_MS = 4_000;

interface LiveSignal {
  generation: number;
  answerSdp: string;
  callId: string;
}

interface LiveSession {
  laneId: string;
  voice: string;
  generation: number | null;
  phase: LivePhase;
  started: boolean;
  muted: boolean;
  delivering: number;
  ledger: LiveDelegationLedger;
  transcript: LiveTranscript;
  inputLevel: number;
  outputLevel: number;
  pc: RTCPeerConnection | null;
  mic: MediaStream | null;
  audioEl: HTMLAudioElement;
  ctx: AudioContext | null;
  inAnalyser: AnalyserNode | null;
  outAnalyser: AnalyserNode | null;
  levelTimer: number | null;
  unlisten: UnlistenFn[];
  sendChain: Promise<void>;
}

function rms(analyser: AnalyserNode | null, buffer: Float32Array<ArrayBuffer>): number {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.sqrt(sum / buffer.length);
}

function meter(level: number): string {
  const on = Math.min(METER_SEGMENTS, Math.round(level * 40));
  return '█'.repeat(on) + '░'.repeat(METER_SEGMENTS - on);
}

export class HarnessLiveVoiceController {
  private session: LiveSession | null = null;
  private endNote: { laneId: string; text: string; error: boolean; until: number } | null = null;
  private readonly levelBuffer = new Float32Array(1024);

  constructor(private readonly host: HarnessLiveVoiceHost) {}

  /** The bound lane id, or null when no session runs. */
  get laneId(): string | null {
    return this.session?.laneId ?? null;
  }

  /** `#live [voice] | stop | mute`. */
  async runCommand(lane: HarnessLane, args: string[]): Promise<void> {
    const command = parseLiveCommand(args);
    if ('error' in command) {
      this.host.flashChip(command.error);
      return;
    }
    if (command.kind === 'stop') {
      if (this.session) this.stop('stopped');
      else this.host.flashChip('live: no session');
      return;
    }
    if (command.kind === 'mute') {
      this.toggleMute();
      return;
    }
    await this.start(lane, command.voice);
  }

  toggleMute(): void {
    const s = this.session;
    if (!s) {
      this.host.flashChip('live: no session');
      return;
    }
    s.muted = !s.muted;
    for (const track of s.mic?.getAudioTracks() ?? []) track.enabled = !s.muted;
    if (s.muted) s.inputLevel = 0;
    this.refreshPhase(s);
    this.host.flashChip(s.muted ? 'live: muted' : 'live: unmuted');
  }

  async start(lane: HarnessLane, voice: string): Promise<void> {
    if (this.session) {
      const bound = this.host.lanes.find((l) => l.id === this.session?.laneId);
      this.host.flashChip(`live already active on ${bound?.displayName ?? 'another lane'}`);
      return;
    }
    if (!lane.client || lane.status === 'starting' || lane.status === 'error' || lane.status === 'stopped') {
      this.host.flashChip(`live: lane ${lane.status}`);
      return;
    }
    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
    if (!mediaDevices?.getUserMedia || typeof RTCPeerConnection !== 'function') {
      this.host.flashChip('live: microphone or WebRTC unavailable in this webview');
      return;
    }
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    const s: LiveSession = {
      laneId: lane.id,
      voice,
      generation: null,
      phase: 'connecting',
      started: false,
      muted: false,
      delivering: 0,
      ledger: new LiveDelegationLedger(),
      transcript: new LiveTranscript(),
      inputLevel: 0,
      outputLevel: 0,
      pc: null,
      mic: null,
      audioEl,
      // Created inside the key/Enter gesture so WebKit lets it run.
      ctx: new AudioContext(),
      inAnalyser: null,
      outAnalyser: null,
      levelTimer: null,
      unlisten: [],
      sendChain: Promise.resolve(),
    };
    this.session = s;
    this.endNote = null;
    this.host.render();
    try {
      await this.connect(s, lane, mediaDevices);
    } catch (e) {
      if (this.session === s) this.stop(liveErrorMessage(errorText(e)), true);
    }
  }

  private async connect(s: LiveSession, lane: HarnessLane, mediaDevices: MediaDevices): Promise<void> {
    s.mic = await mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.session !== s) return this.releaseMedia(s);
    if (s.ctx) {
      // Active capture lets WebKit run audio even if the gesture has expired.
      void s.ctx.resume().catch(() => {});
      s.inAnalyser = s.ctx.createAnalyser();
      s.ctx.createMediaStreamSource(s.mic).connect(s.inAnalyser);
    }
    const pc = new RTCPeerConnection();
    s.pc = pc;
    for (const track of s.mic.getAudioTracks()) pc.addTrack(track, s.mic);
    pc.ontrack = (event: RTCTrackEvent): void => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      s.audioEl.srcObject = stream;
      s.audioEl.play().catch((e: unknown) => console.warn('[live-voice] playback blocked', e));
      if (s.ctx && !s.outAnalyser) {
        s.outAnalyser = s.ctx.createAnalyser();
        s.ctx.createMediaStreamSource(stream).connect(s.outAnalyser);
      }
    };
    pc.onconnectionstatechange = (): void => {
      if (pc.connectionState === 'failed' && this.session === s) this.stop('live connection failed', true);
    };
    // The endpoint expects the `oai-events` channel in the offer; events are
    // read from the sideband, which carries the same frames.
    const channel = pc.createDataChannel('oai-events');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    s.unlisten.push(
      await listen<{ generation: number; payload: string }>('live-voice-event', (event) => {
        if (this.session === s && event.payload.generation === s.generation) {
          const parsed = parseLiveServerEvent(event.payload.payload);
          if (parsed) this.onServerEvent(s, parsed);
        }
      }),
      await listen<{ generation: number; error: string | null }>('live-voice-closed', (event) => {
        if (this.session === s && event.payload.generation === s.generation) {
          this.stop(event.payload.error ? liveErrorMessage(event.payload.error) : 'live session ended', event.payload.error !== null);
        }
      }),
    );
    if (this.session !== s) return;

    const signal = await invoke<LiveSignal>('live_voice_signal', {
      offerSdp: offer.sdp ?? '',
      instructions: renderLiveInstructions(lane.displayName),
      voice: s.voice,
    });
    if (this.session !== s) {
      void invoke('live_voice_close', { generation: signal.generation }).catch(() => {});
      return;
    }
    s.generation = signal.generation;
    await pc.setRemoteDescription({ type: 'answer', sdp: signal.answerSdp });
    await new Promise<void>((resolve, reject) => {
      if (channel.readyState === 'open') return resolve();
      const timer = window.setTimeout(() => reject(new Error('live data channel did not open')), DATA_CHANNEL_TIMEOUT_MS);
      channel.onopen = (): void => {
        window.clearTimeout(timer);
        resolve();
      };
    });
    if (this.session !== s) return;
    await invoke('live_voice_open_sideband', { generation: signal.generation });
    if (this.session !== s) return;
    s.levelTimer = window.setInterval(() => this.sampleLevels(s), LEVEL_INTERVAL_MS);
  }

  private onServerEvent(s: LiveSession, event: LiveServerEvent): void {
    switch (event.type) {
      case 'session.started':
        s.started = true;
        this.refreshPhase(s);
        return;
      case 'input_transcript.added':
        s.transcript.add('user', event.text);
        this.patchStrip(s);
        return;
      case 'output_transcript.added':
        s.transcript.add('assistant', event.text);
        this.patchStrip(s);
        return;
      case 'turn.done':
        s.transcript.finish(event.role, event.transcript);
        this.patchStrip(s);
        return;
      case 'delegation.created':
        void this.deliver(s, event.id, event.text);
        return;
      case 'session.closed':
        this.stop(event.reason === 'client_request' ? 'stopped' : `live session closed${event.reason ? ` (${event.reason})` : ''}`);
        return;
      case 'error':
        this.stop(event.message, true);
        return;
      case 'ignored':
        return;
    }
  }

  private async deliver(s: LiveSession, id: string, text: string): Promise<void> {
    const lane = this.host.lanes.find((l) => l.id === s.laneId);
    if (!lane || !text) {
      this.send(s, delegationAppends(id, rejectedDelegationText(lane ? 'empty request' : 'lane closed')));
      return;
    }
    s.delivering += 1;
    this.refreshPhase(s);
    const outcome = await this.host.deliverLivePrompt(lane, text, id);
    if (this.session !== s) return;
    s.delivering -= 1;
    s.ledger.delivered(id, outcome);
    if (outcome === 'rejected') {
      this.send(s, delegationAppends(id, rejectedDelegationText(`${lane.displayName} is ${lane.status}`)));
    }
    this.refreshPhase(s);
  }

  // ─── lane hooks (called by AcpHarnessView) ────────────────────────────────

  onMessageText(lane: HarnessLane, text: string): void {
    if (this.session?.laneId === lane.id) this.session.ledger.appendText(text);
  }

  onToolCall(lane: HarnessLane): void {
    const s = this.session;
    if (s?.laneId !== lane.id) return;
    const progress = s.ledger.flushProgress();
    if (progress) this.send(s, delegationAppends(progress.id, progress.text, 'commentary'));
  }

  onTurnEnd(lane: HarnessLane, stopReason: StopReason): void {
    const s = this.session;
    if (s?.laneId !== lane.id) return;
    const final = s.ledger.takeFinal();
    if (final) {
      const text = stopReason === 'cancelled' ? TURN_CANCELLED_TEXT : finalMessageText(final.text);
      this.send(s, delegationAppends(final.id, text));
    }
    this.refreshPhase(s);
  }

  onPromptStarted(lane: HarnessLane, delegationId: string): void {
    const s = this.session;
    if (s?.laneId !== lane.id) return;
    s.ledger.promptStarted(delegationId);
    this.refreshPhase(s);
  }

  onLaneStatus(lane: HarnessLane, status: HarnessLaneStatus): void {
    const s = this.session;
    if (s?.laneId !== lane.id) return;
    if (status === 'error' || status === 'stopped') {
      this.stop(`live ended: ${lane.displayName} ${status}`, true);
      return;
    }
    const current = s.ledger.current;
    if (status === 'needs_permission' && current) {
      const title = lane.pendingPermissions[0]?.toolCall.title ?? '';
      this.send(s, delegationAppends(current, permissionRequestText(title)));
    }
  }

  onLaneGone(lane: HarnessLane): void {
    if (this.session?.laneId === lane.id) this.stop(`live ended: ${lane.displayName} closed`);
  }

  // ─── teardown ──────────────────────────────────────────────────────────────

  stop(note: string, error = false): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (s.levelTimer !== null) window.clearInterval(s.levelTimer);
    for (const unlisten of s.unlisten) unlisten();
    const generation = s.generation;
    if (generation !== null) {
      // Graceful close first so the server ends billing, then drop the socket.
      void this.sendRaw(s, generation, SESSION_CLOSE)
        .catch(() => {})
        .finally(() => invoke('live_voice_close', { generation }).catch(() => {}));
    }
    this.releaseMedia(s);
    this.endNote = { laneId: s.laneId, text: note, error, until: Date.now() + END_NOTE_MS };
    window.setTimeout(() => {
      if (this.endNote && Date.now() >= this.endNote.until) {
        this.endNote = null;
        this.host.render();
      }
    }, END_NOTE_MS);
    if (error) this.host.flashChip(`live: ${note}`);
    this.host.render();
  }

  dispose(): void {
    this.stop('stopped');
  }

  private releaseMedia(s: LiveSession): void {
    for (const track of s.mic?.getTracks() ?? []) track.stop();
    s.pc?.close();
    s.audioEl.pause();
    s.audioEl.srcObject = null;
    void s.ctx?.close().catch(() => {});
    s.ctx = null;
  }

  // ─── wire ──────────────────────────────────────────────────────────────────

  private send(s: LiveSession, messages: LiveClientMessage[]): void {
    const generation = s.generation;
    if (generation === null) return;
    for (const message of messages) {
      s.sendChain = this.sendRaw(s, generation, message).catch((e: unknown) => {
        if (this.session === s) this.stop(liveErrorMessage(errorText(e)), true);
      });
    }
  }

  /** Serialized per session so appends reach the model in order. */
  private sendRaw(s: LiveSession, generation: number, message: LiveClientMessage): Promise<void> {
    return s.sendChain.then(() => invoke('live_voice_send', { generation, message: JSON.stringify(message) }));
  }

  // ─── phase + strip ─────────────────────────────────────────────────────────

  private sampleLevels(s: LiveSession): void {
    if (this.session !== s) return;
    s.inputLevel = s.muted ? 0 : rms(s.inAnalyser, this.levelBuffer);
    s.outputLevel = rms(s.outAnalyser, this.levelBuffer);
    this.refreshPhase(s);
  }

  private refreshPhase(s: LiveSession): void {
    let phase: LivePhase;
    if (!s.started) phase = 'connecting';
    else if (s.muted) phase = 'muted';
    else if (s.ledger.current || s.delivering > 0) phase = 'working';
    else if (s.outputLevel > SPEAKING_LEVEL) phase = 'speaking';
    else phase = 'listening';
    s.phase = phase;
    this.patchStrip(s);
  }

  /** Strip markup for the composer of `lane`; empty when nothing to show. */
  renderStrip(lane: HarnessLane): string {
    const s = this.session;
    if (s?.laneId === lane.id) {
      return (
        `<div class="acp-harness__live acp-harness__live--${s.phase}" data-live-strip>` +
        `<span class="acp-harness__live-label">LIVE</span>` +
        `<span class="acp-harness__live-phase" data-live-phase>${s.phase}</span>` +
        `<span class="acp-harness__live-voice">${esc(s.voice)}</span>` +
        `<span class="acp-harness__live-meter acp-harness__live-meter--in" data-live-in>${meter(s.inputLevel)}</span>` +
        `<span class="acp-harness__live-meter acp-harness__live-meter--out" data-live-out>${meter(s.outputLevel)}</span>` +
        `<span class="acp-harness__live-line" data-live-line>${esc(this.lineText(s))}</span>` +
        `<span class="acp-harness__live-keys">⌘⇧L stop · ⌘⌥L mute</span>` +
        `</div>`
      );
    }
    const note = this.endNote;
    if (note?.laneId === lane.id && Date.now() < note.until) {
      return (
        `<div class="acp-harness__live acp-harness__live--${note.error ? 'error' : 'ended'}">` +
        `<span class="acp-harness__live-label">LIVE</span>` +
        `<span class="acp-harness__live-line">${esc(note.text)}</span></div>`
      );
    }
    return '';
  }

  private lineText(s: LiveSession): string {
    const line = s.transcript.latest();
    if (!line) return s.started ? 'speak — the lane does the work' : 'connecting…';
    return `${line.role === 'user' ? 'you' : 'live'}: ${line.text}`;
  }

  /** Update the strip in place — level ticks must not re-render the composer. */
  private patchStrip(s: LiveSession): void {
    const strip = this.host.composerEl.querySelector<HTMLElement>('[data-live-strip]');
    if (!strip || this.session !== s) return;
    strip.className = `acp-harness__live acp-harness__live--${s.phase}`;
    const set = (selector: string, text: string): void => {
      const el = strip.querySelector<HTMLElement>(selector);
      if (el && el.textContent !== text) el.textContent = text;
    };
    set('[data-live-phase]', s.phase);
    set('[data-live-in]', meter(s.inputLevel));
    set('[data-live-out]', meter(s.outputLevel));
    set('[data-live-line]', this.lineText(s));
  }
}
