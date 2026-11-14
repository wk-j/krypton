import { describe, expect, it } from 'vitest';

import { createLaneDecoder } from './decoder';
import { rawToolUpdate } from './test-utils';
import { TOOL_STATE_TERMINAL_CAP } from './tool';
import type { LaneDecoder, LaneEvent, OmpBackgroundStatus } from './types';

function launch(decoder: LaneDecoder, id = 'call-1', jobId = 'bg_1'): LaneEvent[] {
  decoder.event(rawToolUpdate('tool_call', {
    toolCallId: id, kind: 'execute', status: 'pending', rawInput: { command: 'sleep 20', async: true },
  }));
  return decoder.event(rawToolUpdate('tool_call_update', {
    toolCallId: id, status: 'completed', rawOutput: {
      content: [{ type: 'text', text: 'Backgrounded as job bg_1 (no deadline)' }],
      details: { async: { state: 'running', jobId, type: 'bash' } },
    },
  }));
}

function snapshot(over: Partial<OmpBackgroundStatus> = {}): OmpBackgroundStatus {
  return {
    id: 'bg_1', toolCallId: 'call-1', state: 'running', startedAt: 1_000,
    endedAt: null, exitCode: null, pid: null, lastLine: '', ...over,
  };
}

const requested = [{ id: 'bg_1', toolCallId: 'call-1' }];

describe('OMP Bash background observations (spec 398)', () => {
  it('separates the completed launch row from live job state and real output', () => {
    const decoder = createLaneDecoder('omp');
    const events = launch(decoder);
    expect(events[0]).toMatchObject({ type: 'tool', view: { status: 'completed' } });
    expect(events[1]).toMatchObject({
      type: 'background_task', activity: { command: 'sleep 20', status: {
        id: 'bg_1', toolCallId: 'call-1', state: 'running', lastLine: '',
      } },
    });
    const update = decoder.event(rawToolUpdate('tool_call_update', {
      toolCallId: 'call-1', status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: '$ misleading command echo' } }],
      rawOutput: {
        content: [{ type: 'text', text: 'first\n\u001b[32mLatest output\u001b[0m\u0007' }],
        details: { async: { state: 'running', jobId: 'bg_1', type: 'bash' } },
      },
    }));
    expect(update.find((event) => event.type === 'background_task')).toMatchObject({
      activity: { status: { lastLine: 'Latest output' } },
    });
  });

  it('handles promotion without requiring the async input flag', () => {
    const decoder = createLaneDecoder('omp');
    decoder.event(rawToolUpdate('tool_call', {
      toolCallId: 'call-1', kind: 'execute', rawInput: { command: 'npm run build' }, status: 'in_progress',
    }));
    const events = decoder.event(rawToolUpdate('tool_call_update', {
      toolCallId: 'call-1', status: 'completed', rawOutput: {
        details: { async: { state: 'running', jobId: 'bg_1', type: 'bash' } },
      },
    }));
    expect(events.find((event) => event.type === 'background_task')).toMatchObject({ activity: { command: 'npm run build' } });
  });

  it('rejects quoted prose, malformed metadata, other backends and orphan updates', () => {
    expect(launch(createLaneDecoder('claude')).some((event) => event.type === 'background_task')).toBe(false);
    const decoder = createLaneDecoder('omp');
    for (const details of [undefined, { async: { state: 'running', jobId: 'bg_1' } },
      { async: { state: 'running', jobId: ' ', type: 'bash' } },
      { async: { state: 'running', jobId: 'bg_1', type: 'eval' } }]) {
      const events = decoder.event(rawToolUpdate('tool_call', {
        toolCallId: 'call-1', kind: 'execute', status: 'completed', rawInput: { command: 'echo quoted', async: true },
        rawOutput: { content: [{ type: 'text', text: 'Backgrounded as job bg_1' }], details },
      }));
      expect(events.some((event) => event.type === 'background_task')).toBe(false);
    }
    expect(decoder.event(rawToolUpdate('tool_call_update', {
      toolCallId: 'unknown', rawOutput: { details: { async: { state: 'running', jobId: 'bg_1', type: 'bash' } } },
    }))).toEqual([]);
  });

  it('keeps a known running job after tool retention eviction and forgets it on reset', () => {
    const decoder = createLaneDecoder('omp');
    launch(decoder);
    for (let i = 0; i <= TOOL_STATE_TERMINAL_CAP; i++) {
      decoder.event(rawToolUpdate('tool_call', { toolCallId: `later-${i}`, status: 'completed' }));
    }
    const completion = rawToolUpdate('tool_call_update', {
      toolCallId: 'call-1', rawOutput: {
        details: { async: { state: 'completed', jobId: 'bg_1', type: 'bash' } },
        content: [{ type: 'text', text: 'Final output' }],
      },
    });
    expect(decoder.event(completion)).toMatchObject([{
      type: 'background_task', activity: { command: 'sleep 20', status: { state: 'completed', lastLine: 'Final output' } },
    }]);
    decoder.reset();
    expect(decoder.event(completion)).toEqual([]);
  });

  it('validates exact snapshot identities before returning any state', () => {
    const decoder = createLaneDecoder('omp');
    for (const jobs of [[], [snapshot({ id: 'foreign' })], [snapshot({ toolCallId: 'another-launch' })],
      [snapshot(), snapshot()], [snapshot({ pid: 0x40000000 })],
      [snapshot({ state: 'unavailable' })], [snapshot({ state: 'completed', pid: 123 })],
      [snapshot({ startedAt: null })]]) {
      expect(() => decoder.backgroundSnapshot({ jobs }, requested)).toThrow();
    }
    expect(decoder.backgroundSnapshot({ jobs: [snapshot({
      state: 'unavailable', startedAt: null,
    })] }, requested)).toEqual([snapshot({ state: 'unavailable', startedAt: null })]);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('keeps honest %s metadata with no invented exit code', (state) => {
    const decoder = createLaneDecoder('omp');
    const result = decoder.backgroundSnapshot({ jobs: [snapshot({ state, endedAt: 2_000 })] }, requested);
    expect(result[0]).toMatchObject({ state, exitCode: null, endedAt: 2_000, pid: null });
  });
});
