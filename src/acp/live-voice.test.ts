import { describe, expect, it } from 'vitest';

import {
  CONTEXT_CHUNK_BYTES,
  LiveDelegationLedger,
  LiveTranscript,
  chunkLiveContext,
  delegationAppends,
  parseLiveCommand,
  parseLiveServerEvent,
} from './live-voice';

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

describe('parseLiveServerEvent', () => {
  it('reads a delegation frame as observed on the wire', () => {
    const frame = JSON.stringify({
      type: 'delegation.created',
      item: {
        id: 'item_1',
        type: 'delegation',
        content: [{ type: 'input_text', text: 'check the branch' }, { type: 'other', text: 'x' }],
        handoff_id: 'handoff_1',
        target: 'client',
        user_bidi_turn_id: 'turn_1',
      },
      offset_ms: 7000,
    });
    expect(parseLiveServerEvent(frame)).toEqual({ type: 'delegation.created', id: 'item_1', text: 'check the branch' });
  });

  it('rejects a delegation aimed at another target', () => {
    const frame = JSON.stringify({ type: 'delegation.created', item: { id: 'i', type: 'delegation', target: 'server', content: [] } });
    expect(parseLiveServerEvent(frame)).toBeNull();
  });

  it('reads turn.done, nested errors and unknown types', () => {
    expect(parseLiveServerEvent('{"type":"turn.done","turn":{"role":"assistant","transcript":" On main."}}'))
      .toEqual({ type: 'turn.done', role: 'assistant', transcript: ' On main.' });
    expect(parseLiveServerEvent('{"type":"error","error":{"message":"quota"}}')).toEqual({ type: 'error', message: 'quota' });
    expect(parseLiveServerEvent('{"type":"session.output_audio.delta"}'))
      .toEqual({ type: 'ignored', wireType: 'session.output_audio.delta' });
    expect(parseLiveServerEvent('not json')).toBeNull();
    expect(parseLiveServerEvent('[1]')).toBeNull();
  });
});

describe('chunkLiveContext', () => {
  it('keeps every chunk within the byte limit without splitting a code point', () => {
    const text = 'ก'.repeat(400) + '😀'.repeat(200);
    const chunks = chunkLiveContext(text);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(utf8(chunk)).toBeLessThanOrEqual(CONTEXT_CHUNK_BYTES);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('emits nothing for empty text', () => {
    expect(chunkLiveContext('')).toEqual([]);
    expect(delegationAppends('d', '')).toEqual([]);
  });
});

describe('LiveTranscript', () => {
  it('accumulates pieces until turn.done, then starts a new line', () => {
    const t = new LiveTranscript();
    t.add('user', ' Hey,');
    t.add('user', ' can you');
    expect(t.latest()).toEqual({ role: 'user', text: 'Hey, can you', final: false });
    t.finish('user', ' Hey, can you check');
    expect(t.latest()).toEqual({ role: 'user', text: 'Hey, can you check', final: true });
    t.add('user', ' Thanks');
    expect(t.latest()).toEqual({ role: 'user', text: 'Thanks', final: false });
  });
});

describe('LiveDelegationLedger', () => {
  it('reports progress and the final text only for a bound turn', () => {
    const ledger = new LiveDelegationLedger();
    ledger.appendText('untagged turn text');
    expect(ledger.flushProgress()).toBeNull();
    expect(ledger.takeFinal()).toBeNull();

    ledger.delivered('d1', 'started');
    ledger.appendText('Looking at git.');
    expect(ledger.flushProgress()).toEqual({ id: 'd1', text: 'Looking at git.' });
    ledger.appendText('On main.');
    expect(ledger.takeFinal()).toEqual({ id: 'd1', text: 'On main.' });
    expect(ledger.current).toBeNull();
  });

  it('binds a queued delegation only when its turn starts', () => {
    const ledger = new LiveDelegationLedger();
    ledger.delivered('d1', 'queued');
    expect(ledger.current).toBeNull();
    ledger.promptStarted('d1');
    expect(ledger.current).toBe('d1');
  });

  it('lets a steered delegation take over the running turn', () => {
    const ledger = new LiveDelegationLedger();
    ledger.delivered('d1', 'started');
    ledger.delivered('d2', 'steered');
    ledger.appendText('done');
    expect(ledger.takeFinal()).toEqual({ id: 'd2', text: 'done' });
  });
});

describe('parseLiveCommand', () => {
  it('parses voices, stop, mute and rejects junk', () => {
    expect(parseLiveCommand([])).toEqual({ kind: 'start', voice: 'sol' });
    expect(parseLiveCommand(['Maple'])).toEqual({ kind: 'start', voice: 'maple' });
    expect(parseLiveCommand(['stop'])).toEqual({ kind: 'stop' });
    expect(parseLiveCommand(['mute'])).toEqual({ kind: 'mute' });
    expect(parseLiveCommand(['robot'])).toHaveProperty('error');
    expect(parseLiveCommand(['sol', 'x'])).toHaveProperty('error');
  });
});
