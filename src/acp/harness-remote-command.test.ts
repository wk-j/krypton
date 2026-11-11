import { describe, expect, it } from 'vitest';
import { remoteCommandLimitNotes, remoteCommandPreview, remoteCommandState, remoteCommandStatus } from './harness-remote-command';
import type { RemoteCommandPayload } from './harness-view-types';

const request: RemoteCommandPayload = {
  source: 'mcp', computerId: 'build', command: 'pwd', cwd: null, result: null, error: null, outcomeUnknown: false, displayTruncated: [],
};
const result = (exitCode: number | null): RemoteCommandPayload => ({ ...request, result: { exitCode, outcome: 'completed', stdout: '', stderr: '', truncated: false } });

describe('remote command presentation', () => {
  it('distinguishes tool lifecycle from a conclusive remote exit', () => {
    expect(remoteCommandState(request, 'pending').label).toBe('Pending');
    expect(remoteCommandState(request, 'in_progress').label).toBe('In progress');
    expect(remoteCommandState(result(0), 'completed').label).toBe('Done · exit 0');
    expect(remoteCommandState(result(27), 'completed').label).toBe('Failed · exit 27');
    expect(remoteCommandState(result(null), 'completed').label).toBe('Completed · exit not reported');
    expect(remoteCommandState(request, 'completed').label).toBe('Remote result not reported');
    expect(remoteCommandState(request, 'failed').label).toBe('Tool failed');
    expect(remoteCommandState(request, 'cancelled').label).toBe('Cancelled · remote outcome unconfirmed');
    expect(remoteCommandState(result(0), 'cancelled').label).toBe('Done · exit 0');
  });

  it('prioritises unknown outcome and contradictory final failures over success snapshots', () => {
    expect(remoteCommandState({ ...result(0), outcomeUnknown: true }, 'failed').label).toBe('Outcome unknown');
    expect(remoteCommandState({ ...result(7), result: { ...result(7).result!, outcome: 'unknown' } }, 'completed').label).toBe('Outcome unknown');
    expect(remoteCommandState(result(0), 'failed').label).toBe('Tool failed');
    expect(remoteCommandState({ ...request, error: 'Remote command declined or approval expired' }, 'failed').label).toBe('Not run');
    expect(remoteCommandState({ ...request, error: 'some other error' }, 'completed').label).toBe('Tool failed');
    expect(remoteCommandStatus('failed', 'in_progress')).toBe('failed');
    expect(remoteCommandStatus('completed', 'pending')).toBe('completed');
    expect(remoteCommandStatus('completed', 'failed')).toBe('failed');
  });

  it('shares four preview lines across streams and preserves meaningful whitespace', () => {
    const payload = { ...result(2), result: { ...result(2).result!, stdout: '  first\n\nthird\nfourth\nfifth\n', stderr: 'bad\n  detail\n' } };
    expect(remoteCommandPreview(payload, 'completed')).toEqual({ streams: [{ stream: 'stderr', text: 'bad\n  detail' }, { stream: 'stdout', text: '  first\n' }], more: true });
    const done = { ...payload, result: { ...payload.result, exitCode: 0 } };
    expect(remoteCommandPreview(done, 'completed').streams).toEqual([{ stream: 'stdout', text: '  first\n\nthird\nfourth' }]);
    expect(remoteCommandPreview(result(0), 'completed')).toEqual({ streams: [], more: false });
    expect(remoteCommandPreview(request, 'pending')).toEqual({ streams: [], more: false });
  });

  it('keeps backend and display truncation independent of outcome', () => {
    const payload = { ...result(0), displayTruncated: ['command', 'stderr'] as const, result: { ...result(0).result!, truncated: true } };
    expect(remoteCommandState(payload, 'completed').state).toBe('done');
    expect(remoteCommandLimitNotes(payload)).toBe('Backend output limit reached. Display limit reached: command, stderr.');
    expect(remoteCommandLimitNotes(request)).toBe('');
  });
});
