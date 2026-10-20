import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { HarnessTimelineHost } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';
import { HarnessTimelineController } from './harness-timeline-controller';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

function setup(remoteRuntimeId: string | null = null) {
  const host = {
    harnessMemoryId: 'h1', remoteRuntimeId,
    flashChip: vi.fn(), enqueueSystemPrompt: vi.fn(async () => true),
  } as unknown as HarnessTimelineHost;
  return { host, controller: new HarnessTimelineController(host) };
}
const lane = { status: 'idle' } as HarnessLane;

beforeEach(() => { vi.resetAllMocks(); });

describe('autonomous Timeline state', () => {
  it('loads numeric legacy count and migrated recording preference without starting a turn', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(24).mockResolvedValueOnce({ automaticRecording: false });
    const { host, controller } = setup();
    expect(controller.automaticRecording).toBe(true);
    await controller.refreshPendingCount();
    await controller.refreshSettings();
    expect(controller.pendingCount).toBe(24);
    expect(controller.automaticRecording).toBe(false);
    expect(invoke).toHaveBeenCalledWith('timeline_pending_count', { harnessId: 'h1' });
    expect(invoke).toHaveBeenCalledWith('timeline_settings', { harnessId: 'h1' });
    expect(host.enqueueSystemPrompt).not.toHaveBeenCalled();
    expect(host.flashChip).not.toHaveBeenCalled();
  });

  it('updates only migration state for matching events, without opening UI or a model turn', async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);
    const { host, controller } = setup();
    await controller.subscribe();
    expect(listen).toHaveBeenCalledWith('acp-timeline-changed', expect.any(Function));
    const handler = vi.mocked(listen).mock.calls[0][1];
    handler({ event: 'acp-timeline-changed', id: 1, payload: { harnessId: 'other', pendingCount: 9 } });
    expect(controller.pendingCount).toBe(0);
    handler({ event: 'acp-timeline-changed', id: 2, payload: { harnessId: 'h1', pendingCount: 23 } });
    expect(controller.pendingCount).toBe(23);
    expect(invoke).not.toHaveBeenCalled();
    expect(host.enqueueSystemPrompt).not.toHaveBeenCalled();
    expect(host.flashChip).not.toHaveBeenCalled();
    controller.dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('does not read local storage or subscribe for remote Harnesses', async () => {
    const { controller } = setup('remote-1');
    await controller.subscribe();
    await controller.refreshPendingCount();
    await controller.refreshSettings();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('changes automatic recording without starting migration or a model turn', async () => {
    vi.mocked(invoke).mockResolvedValue({ automaticRecording: false });
    const { host, controller } = setup();
    controller.pendingCount = 24;
    await controller.runCommand(lane, '#timeline auto off');
    expect(invoke).toHaveBeenCalledWith('timeline_set_enabled', { harnessId: 'h1', enabled: false });
    expect(controller.automaticRecording).toBe(false);
    expect(controller.pendingCount).toBe(24);
    expect(host.enqueueSystemPrompt).not.toHaveBeenCalled();
  });

  it('opens read-only browser history with an optional topic', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(34123).mockResolvedValueOnce(undefined);
    const { host, controller } = setup();
    await controller.runCommand(lane, '#timeline open upload validation');
    expect(invoke).toHaveBeenCalledWith('open_url', {
      url: 'http://127.0.0.1:34123/timeline?harness=h1&topic=upload+validation',
    });
    expect(host.enqueueSystemPrompt).not.toHaveBeenCalled();
  });

  it('starts conflict work only on explicit command, and refuses a busy lane', async () => {
    const { host, controller } = setup();
    await controller.runCommand(lane, '#timeline conflicts auth');
    expect(host.enqueueSystemPrompt).toHaveBeenCalledOnce();
    await controller.runCommand({ status: 'busy' } as HarnessLane, '#timeline conflicts auth');
    expect(host.enqueueSystemPrompt).toHaveBeenCalledOnce();
  });
});
