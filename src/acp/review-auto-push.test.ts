import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpHarnessView } from './acp-harness-view';
import type { ReviewEventPayload } from './harness-view-types';
import type { PushReport, XenonStatus } from './xenon-push';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const reviewUrl = 'https://xenon.example.com/r/wk-j.krypton/review/2026-09-25-result';
const status: XenonStatus = {
  enabled: true,
  configured: true,
  baseUrl: 'https://xenon.example.com',
  project: 'wk-j.krypton',
  token: 'configured',
  queued: 0,
  autoPush: ['review'],
};
const report: PushReport = {
  pushed: 1,
  unchanged: 0,
  blocked: 0,
  failed: 0,
  queued: 0,
  baseUrl: status.baseUrl,
  project: status.project,
  items: [{
    kind: 'review', slug: '2026-09-25-result', title: 'Result', state: 'pushed',
    url: reviewUrl,
  }],
};

function reviewEvent(overrides: Partial<ReviewEventPayload> = {}): ReviewEventPayload {
  return {
    harnessId: 'hm-1', laneLabel: 'Codex-2', id: 'rev-1',
    slug: '2026-09-25-result', state: 'registered', registered: true,
    ...overrides,
  };
}

function makeView(remoteRuntimeId: string | null = null): {
  receive: (payload: ReviewEventPayload) => void;
  appendTranscript: ReturnType<typeof vi.fn>;
  publishLinkFromPushReport: ReturnType<typeof vi.fn>;
} {
  const appendTranscript = vi.fn();
  const publishLinkFromPushReport = vi.fn();
  const view = Object.assign(Object.create(AcpHarnessView.prototype), {
    reviews: new Map(),
    lanes: [{ displayName: 'Codex-2' }],
    projectDir: '/repo',
    remoteRuntimeId,
    raiseReviewCard: vi.fn(),
    updateReviewCard: vi.fn(),
    appendTranscript,
    scheduleLaneRender: vi.fn(),
    publishLinkFromPushReport,
  }) as AcpHarnessView;
  return {
    receive: (payload) => (view as unknown as { handleReviewEvent: (event: ReviewEventPayload) => void })
      .handleReviewEvent(payload),
    appendTranscript,
    publishLinkFromPushReport,
  };
}

describe('Review Board auto-push', () => {
  beforeEach(() => invokeMock.mockReset());

  it('publishes only the registered bundle and reports its Xenon URL', async () => {
    invokeMock.mockResolvedValueOnce(status as never).mockResolvedValueOnce(report as never);
    const view = makeView();
    view.receive(reviewEvent());

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'xenon_status', { cwd: '/repo' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'xenon_push', {
      cwd: '/repo', kind: 'review', slug: '2026-09-25-result', force: false, attention: [],
    });
    await vi.waitFor(() => expect(view.appendTranscript).toHaveBeenCalledWith(
      expect.anything(), 'system', expect.stringContaining(reviewUrl),
    ));
    expect(view.publishLinkFromPushReport).toHaveBeenCalledWith(report);
  });

  it('ignores pending, repeat registration, and remote-runtime events', () => {
    const view = makeView();
    view.receive(reviewEvent({ state: 'pending', registered: undefined }));
    view.receive(reviewEvent({ registered: false }));
    makeView('remote-1').receive(reviewEvent());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('leaves the Board local when Xenon is opted in but not configured', async () => {
    invokeMock.mockResolvedValueOnce({ ...status, configured: false, token: 'missing' } as never);
    const view = makeView();
    view.receive(reviewEvent());
    await vi.waitFor(() => expect(view.appendTranscript).toHaveBeenCalledWith(
      expect.anything(), 'system', expect.stringContaining('not ready'),
    ));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('does not publish when review is absent from auto_push', async () => {
    invokeMock.mockResolvedValueOnce({ ...status, autoPush: ['attention'] } as never);
    const view = makeView();
    view.receive(reviewEvent());
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(view.appendTranscript).not.toHaveBeenCalled();
  });

  it('reports a failed push without losing the local Board', async () => {
    invokeMock.mockResolvedValueOnce(status as never)
      .mockRejectedValueOnce(new Error('server offline'));
    const view = makeView();
    view.receive(reviewEvent());
    await vi.waitFor(() => expect(view.appendTranscript).toHaveBeenCalledWith(
      expect.anything(), 'system', expect.stringContaining('server offline'),
    ));
    expect(view.publishLinkFromPushReport).not.toHaveBeenCalled();
  });
});
