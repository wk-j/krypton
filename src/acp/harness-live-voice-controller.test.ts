// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { HarnessLiveVoiceController } from './harness-live-voice-controller';
import type { HarnessLiveVoiceHost } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const controllers: HarnessLiveVoiceController[] = [];

function setup(laneName = 'OMP-2') {
  const track = { enabled: true, stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  let resolveCapture!: (stream: MediaStream) => void;
  const capture = new Promise<MediaStream>((resolve) => { resolveCapture = resolve; });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => capture } });
  const attached: boolean[] = [];
  const close = vi.fn();
  vi.stubGlobal('RTCPeerConnection', class {
    addTrack(audio: MediaStreamTrack): void { attached.push(audio.enabled); }
    createDataChannel(): { readyState: string } { return { readyState: 'open' }; }
    async createOffer(): Promise<{ sdp: string }> { return { sdp: 'offer' }; }
    async setLocalDescription(): Promise<void> {}
    async setRemoteDescription(): Promise<void> {}
    close = close;
  });
  vi.stubGlobal('AudioContext', class {
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
    createAnalyser(): { getFloatTimeDomainData(buffer: Float32Array): void } {
      return { getFloatTimeDomainData: (buffer) => buffer.fill(0.2) };
    }
    createMediaStreamSource(): { connect(): void } { return { connect: () => {} }; }
  });
  const lane = { id: `lane-${laneName}`, displayName: laneName, client: {}, status: 'idle' } as HarnessLane;
  const other = { id: `other-${laneName}`, displayName: `${laneName}-other`, client: {}, status: 'idle' } as HarnessLane;
  let activeLaneId = lane.id;
  const element = document.createElement('div');
  document.body.appendChild(element);
  const flashChip = vi.fn();
  const host: HarnessLiveVoiceHost = {
    element,
    lanes: [lane, other],
    get activeLaneId() { return activeLaneId; },
    flashChip,
    patchLiveVoice: vi.fn(),
    invalidate: vi.fn(),
    deliverLivePrompt: async () => 'started',
  };
  const ctl = new HarnessLiveVoiceController(host);
  controllers.push(ctl);
  const show = (laneId: string): void => { activeLaneId = laneId; };
  const start = (): Promise<void> => ctl.start(lane, 'sol');
  /** Delivers a Rust event to the newest listener, i.e. this controller's session. */
  const rustEvent = (name: string, payload: unknown): void => {
    const calls = vi.mocked(listen).mock.calls.filter(([n]) => n === name);
    const handler = calls[calls.length - 1]?.[1];
    handler?.({ event: name, id: 1, payload });
  };
  const connect = async (): Promise<void> => {
    const pending = start();
    resolveCapture(stream);
    await pending;
    rustEvent('live-voice-event', { generation: 7, payload: JSON.stringify({ type: 'session.started' }) });
  };
  const press = (init: KeyboardEventInit = {}): boolean => {
    const event = new KeyboardEvent('keydown', { code: 'AltLeft', key: 'Alt', altKey: true, ...init });
    window.dispatchEvent(event);
    return ctl.handleKeyDown(event);
  };
  const release = (init: KeyboardEventInit = {}): void => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', ...init }));
  };
  return { ctl, lane, other, show, flashChip, element, track, stream, attached, close, resolveCapture, start, connect, press, release, rustEvent };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockResolvedValue({ generation: 7, answerSdp: 'answer', callId: 'call' });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  for (const ctl of controllers.splice(0)) ctl.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('live microphone hold-to-talk', () => {
  it('attaches a muted track, opens only during a hold, and closes without ending the session', async () => {
    const h = setup();
    await h.connect();
    expect(h.attached).toEqual([false]);
    expect(h.track.enabled).toBe(false);
    expect(h.ctl.stripProps(h.lane)).toMatchObject({ phase: 'muted', muted: true });

    h.press();
    expect(h.track.enabled).toBe(true);
    vi.advanceTimersByTime(100);
    expect(h.ctl.stripProps(h.lane)).toMatchObject({ phase: 'listening', muted: false });
    const props = h.ctl.stripProps(h.lane);
    expect(props.kind === 'session' ? props.inputLevel : 0).toBeGreaterThan(0.1);

    h.release();
    expect(h.track.enabled).toBe(false);
    expect(h.ctl.stripProps(h.lane)).toMatchObject({ phase: 'muted', muted: true, inputLevel: 0 });
    expect(h.ctl.laneId).toBe(h.lane.id);
    expect(h.track.stop).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it.each<KeyboardEventInit>([
    { code: 'AltRight' }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { repeat: true },
  ])('does not start sending for a non-bare or repeated press: %j', async (init) => {
    const h = setup();
    await h.connect();
    h.press(init);
    expect(h.track.enabled).toBe(false);
  });

  it('cancels on another key and cannot reopen until Left Option is released', async () => {
    const h = setup();
    await h.connect();
    h.press();
    expect(h.track.enabled).toBe(true);
    const shortcut = new KeyboardEvent('keydown', { code: 'KeyC', altKey: true, cancelable: true });
    window.dispatchEvent(shortcut);
    expect(h.track.enabled).toBe(false);
    expect(shortcut.defaultPrevented).toBe(false);
    h.release({ code: 'KeyC', altKey: true });
    h.press({ repeat: true });
    h.press();
    expect(h.track.enabled).toBe(false);
    h.release();
    h.press();
    expect(h.track.enabled).toBe(true);
  });

  it.each(['blur', 'hidden', 'focusout'])('closes on %s and never resumes merely on focus return', async (reason) => {
    const h = setup();
    await h.connect();
    h.press();
    expect(h.track.enabled).toBe(true);
    if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else if (reason === 'hidden') {
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      hidden.mockReturnValue(false);
    } else h.element.dispatchEvent(new FocusEvent('focusout', { relatedTarget: document.body }));
    expect(h.track.enabled).toBe(false);
    window.dispatchEvent(new Event('focus'));
    h.press({ repeat: true });
    expect(h.track.enabled).toBe(false);
    h.release();
    h.press();
    expect(h.track.enabled).toBe(true);
  });

  it('keeps a hold while focus moves within the same Harness', async () => {
    const h = setup();
    await h.connect();
    const input = document.createElement('input');
    h.element.appendChild(input);
    h.press();
    h.element.dispatchEvent(new FocusEvent('focusout', { relatedTarget: input }));
    expect(h.track.enabled).toBe(true);
  });

  it('honors release while microphone permission is still pending', async () => {
    const h = setup();
    const pending = h.start();
    h.press();
    h.release();
    h.resolveCapture(h.stream);
    await pending;
    expect(h.attached).toEqual([false]);
    expect(h.track.enabled).toBe(false);
  });

  it('honors a still-active hold when capture arrives', async () => {
    const h = setup();
    const pending = h.start();
    h.press();
    h.resolveCapture(h.stream);
    await pending;
    expect(h.attached).toEqual([true]);
    h.release();
    expect(h.track.enabled).toBe(false);
  });

  it('stops late capture from an ended session without touching a new session', async () => {
    const old = setup();
    const pending = old.start();
    old.press();
    old.ctl.stop('stopped');
    const next = setup();
    await next.connect();
    next.press();
    old.resolveCapture(old.stream);
    await pending;
    expect(old.track.stop).toHaveBeenCalledOnce();
    expect(old.attached).toEqual([]);
    expect(next.track.enabled).toBe(true);
    next.release();
    expect(next.track.enabled).toBe(false);
  });

  it('opens the microphone only while the bound lane is on screen', async () => {
    const h = setup();
    await h.connect();
    h.show(h.other.id);
    expect(h.press()).toBe(false);
    expect(h.track.enabled).toBe(false);
    h.release();
    h.show(h.lane.id);
    expect(h.press()).toBe(true);
    expect(h.track.enabled).toBe(true);
  });
});

describe('one live session per app', () => {
  it('refuses a session from another Harness view until the first one ends', async () => {
    const first = setup('OMP-1');
    await first.connect();
    const second = setup('OMP-2');
    await second.start();
    expect(second.flashChip).toHaveBeenCalledWith(expect.stringContaining('OMP-1'));
    expect(second.ctl.laneId).toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'live_voice_signal')).toHaveLength(1);

    first.ctl.stop('stopped');
    await second.connect();
    expect(second.ctl.laneId).toBe(second.lane.id);
  });

  it('releases the microphone and peer when Rust reports the call superseded', async () => {
    const h = setup();
    await h.connect();
    h.press();
    h.rustEvent('live-voice-closed', { generation: 7, error: 'superseded' });
    expect(h.ctl.laneId).toBeNull();
    expect(h.track.enabled).toBe(false);
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
  });
});
