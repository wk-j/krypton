// Krypton — ACP Harness View: read-only history, settings and migration state.
// Timeline intake runs in ordinary local lane turns, never in this controller.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { timelineConflictsPrompt, timelineTracePrompt } from './harness-prompts';
import { errorText } from './harness-permission-scan';
import type { HarnessLane } from './harness-view-types';
import type { HarnessTimelineHost } from './harness-view-host';
import { TIMELINE_USAGE, parseTimelineCommand, type TimelineSettings } from './timeline';

export class HarnessTimelineController {
  pendingCount = 0;
  automaticRecording = true;
  private changedUnlisten: UnlistenFn | null = null;

  constructor(private readonly host: HarnessTimelineHost) {}

  async subscribe(): Promise<void> {
    if (this.host.remoteRuntimeId) return;
    this.changedUnlisten = await listen<{ harnessId: string; pendingCount: number }>(
      'acp-timeline-changed',
      (event) => {
        if (event.payload.harnessId !== this.host.harnessMemoryId) return;
        this.pendingCount = Math.max(0, event.payload.pendingCount);
      },
    );
  }

  dispose(): void {
    this.changedUnlisten?.();
    this.changedUnlisten = null;
  }

  async refreshPendingCount(): Promise<void> {
    if (!this.host.harnessMemoryId || this.host.remoteRuntimeId) {
      this.pendingCount = 0;
      return;
    }
    try {
      this.pendingCount = await invoke<number>('timeline_pending_count', {
        harnessId: this.host.harnessMemoryId,
      });
    } catch (e) {
      console.warn('[acp-harness] timeline pending count failed:', e);
    }
  }

  async refreshSettings(): Promise<void> {
    if (!this.host.harnessMemoryId || this.host.remoteRuntimeId) return;
    try {
      const settings = await invoke<TimelineSettings>('timeline_settings', {
        harnessId: this.host.harnessMemoryId,
      });
      this.automaticRecording = settings.automaticRecording;
    } catch (e) {
      console.warn('[acp-harness] timeline settings refresh failed:', e);
    }
  }

  async openBrowser(topic: string): Promise<void> {
    if (!this.host.harnessMemoryId) {
      this.host.flashChip('ใช้ timeline ไม่ได้: ยังไม่ได้ลงทะเบียน project กับ Harness');
      return;
    }
    const port = await invoke<number>('get_hook_server_port').catch(() => 0);
    if (!port) {
      this.host.flashChip('ใช้ timeline ไม่ได้: hook server ยังไม่พร้อม');
      return;
    }
    const query = new URLSearchParams({ harness: this.host.harnessMemoryId });
    if (topic) query.set('topic', topic);
    const url = `http://127.0.0.1:${port}/timeline?${query.toString()}`;
    try {
      await invoke('open_url', { url });
      this.host.flashChip(url);
    } catch (e) {
      this.host.flashChip(`เปิด timeline ไม่สำเร็จ: ${errorText(e)}`);
    }
  }

  async runCommand(lane: HarnessLane, text: string): Promise<void> {
    const command = parseTimelineCommand(text);
    if (command.kind === 'usage') {
      this.host.flashChip(TIMELINE_USAGE);
      return;
    }
    if (command.kind === 'trace') {
      if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
        this.host.flashChip('lane busy - #cancel first');
        return;
      }
      await this.host.enqueueSystemPrompt(
        lane,
        timelineTracePrompt(command.topic),
        undefined,
        'กำลังไล่ timeline',
      );
      return;
    }
    if (this.host.remoteRuntimeId) {
      this.host.flashChip('#timeline แบบ local storage/browser ใช้ไม่ได้ใน remote Harness แต่ยังใช้ trace ได้');
      return;
    }
    if (command.kind === 'conflicts') {
      if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
        this.host.flashChip('lane busy - #cancel first');
        return;
      }
      await this.host.enqueueSystemPrompt(
        lane,
        timelineConflictsPrompt(command.topic),
        undefined,
        'กำลังตรวจข้อขัดกันใน timeline',
      );
      return;
    }
    if (command.kind === 'auto') {
      if (!this.host.harnessMemoryId) {
        this.host.flashChip('ใช้ timeline ไม่ได้: ยังไม่ได้ลงทะเบียน project กับ Harness');
        return;
      }
      try {
        if (command.state === 'status') {
          await this.refreshSettings();
        } else {
          const settings = await invoke<TimelineSettings>('timeline_set_enabled', {
            harnessId: this.host.harnessMemoryId,
            enabled: command.state === 'on',
          });
          this.automaticRecording = settings.automaticRecording;
        }
        this.host.flashChip(`บันทึก timeline อัตโนมัติ · ${this.automaticRecording ? 'เปิด' : 'ปิด'}`);
      } catch (e) {
        this.host.flashChip(`ตั้งค่า timeline ไม่สำเร็จ: ${errorText(e)}`);
      }
      return;
    }
    await this.openBrowser(command.topic);
  }
}
