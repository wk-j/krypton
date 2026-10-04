// Krypton — ACP Harness View: timeline controller (specs 253–267).
//
// Extracted from acp-harness-view.ts (spec 275). Owns the `#timeline` command,
// the capture/review overlay, and the pending-suggestion count the lane chrome
// shows as a badge.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { loadConfig } from '../config';
import { timelineConflictsPrompt, timelineTracePrompt } from './harness-prompts';
import { errorText } from './harness-permission-scan';
import type { HarnessLane } from './harness-view-types';
import type { HarnessTimelineHost } from './harness-view-host';
import { TimelineCapture, type TimelineCaptureOptions } from './timeline-capture';
import {
  TIMELINE_USAGE,
  parseTimelineCommand,
  type TimelineEvent,
  type TimelineListResponse,
  type TimelineMergeResult,
  type TimelineMergeUndoResult,
  type TimelineSuggestion,
  type TimelineSuggestionListResponse,
  type TimelineSuggestionSettings,
  type TimelineTopicSemanticResult,
} from './timeline';

export class HarnessTimelineController {
  capture: TimelineCapture | null = null;
  pendingCount = 0;
  automaticSuggestions = true;
  private suggestionUnlisten: UnlistenFn | null = null;

  constructor(private readonly host: HarnessTimelineHost) {}

  /** Follow backend suggestion events for the registered harness. */
  async subscribe(): Promise<void> {
    this.suggestionUnlisten = await listen<{
      harnessId: string;
      laneLabel: string;
      suggestionId: string;
      pendingCount: number;
    }>('acp-timeline-suggestion', (event) => {
      if (event.payload.harnessId !== this.host.harnessMemoryId) return;
      this.pendingCount = Math.max(0, event.payload.pendingCount);
      this.host.flashChip(`timeline · รอตรวจทาน ${this.pendingCount} รายการ · #timeline review`);
      this.host.render();
      void this.refreshSuggestions();
    });
  }

  dispose(): void {
    this.suggestionUnlisten?.();
    this.suggestionUnlisten = null;
    this.capture?.dispose();
    this.capture = null;
  }

  closeCapture(): void {
    if (!this.capture) return;
    this.capture.dispose();
    this.capture = null;
    this.host.syncOrchestratorConsoleVisibility();
  }

  async refreshSuggestions(): Promise<TimelineSuggestionListResponse | null> {
    if (!this.host.harnessMemoryId || this.host.remoteRuntimeId) {
      this.pendingCount = 0;
      return null;
    }
    try {
      const listing = await invoke<TimelineSuggestionListResponse>('timeline_suggestion_list', {
        harnessId: this.host.harnessMemoryId,
      });
      this.pendingCount = listing.suggestions.length;
      this.host.render();
      return listing;
    } catch (e) {
      console.warn('[acp-harness] timeline suggestion refresh failed:', e);
      return null;
    }
  }

  async refreshSuggestionSettings(): Promise<void> {
    if (!this.host.harnessMemoryId || this.host.remoteRuntimeId) return;
    try {
      const settings = await invoke<TimelineSuggestionSettings>('timeline_suggestion_settings', {
        harnessId: this.host.harnessMemoryId,
      });
      this.automaticSuggestions = settings.automaticSuggestions;
    } catch (e) {
      console.warn('[acp-harness] timeline settings refresh failed:', e);
    }
  }

  semanticOptions(
    harnessId: string,
    config: Awaited<ReturnType<typeof loadConfig>>,
  ): TimelineCaptureOptions['semantic'] {
    const typesafe = config.typesafe;
    const mode = typesafe?.timeline_topics.mode;
    if (!typesafe?.enabled || (mode !== 'shadow' && mode !== 'suggest')) return undefined;
    return {
      mode,
      debounceMs: typesafe.timeline_topics.debounce_ms,
      maxCandidates: typesafe.timeline_topics.max_candidates,
      suggest: (request) => invoke<TimelineTopicSemanticResult>('timeline_topic_suggest', {
        harnessId,
        request,
      }),
      cancel: (requestId) => invoke<boolean>('timeline_topic_suggest_cancel', { requestId }),
    };
  }

  async openSuggestionReview(lane: HarnessLane): Promise<void> {
    if (!this.host.harnessMemoryId) {
      this.host.flashChip('ใช้ timeline ไม่ได้: ยังไม่ได้ลงทะเบียน project กับ Harness');
      return;
    }
    try {
      const [pending, listing, config] = await Promise.all([
        invoke<TimelineSuggestionListResponse>('timeline_suggestion_list', {
          harnessId: this.host.harnessMemoryId,
        }),
        invoke<TimelineListResponse>('timeline_list', { harnessId: this.host.harnessMemoryId }),
        loadConfig(),
      ]);
      this.pendingCount = pending.suggestions.length;
      const suggestion = pending.suggestions[0];
      if (!suggestion) {
        this.host.flashChip('timeline · ไม่มีข้อเสนอที่รอตรวจทาน');
        this.host.render();
        return;
      }
      this.closeCapture();
      const harnessId = this.host.harnessMemoryId;
      this.capture = new TimelineCapture({
        mount: this.host.element,
        events: listing.events,
        recorderLane: lane.displayName,
        suggestion,
        semantic: this.semanticOptions(harnessId, config),
        save: (request) => invoke<TimelineEvent>('timeline_suggestion_confirm', {
          harnessId,
          suggestionId: suggestion.id,
          request,
        }),
        dismiss: () => invoke<TimelineSuggestion>('timeline_suggestion_dismiss', {
          harnessId,
          suggestionId: suggestion.id,
        }).then(() => undefined),
        close: () => this.closeCapture(),
        saved: (event) => {
          this.closeCapture();
          this.host.appendTranscript(lane, 'system', `ยืนยัน timeline แล้ว · ${event.id} · ${event.path}`);
          this.host.flashChip(`ยืนยัน timeline แล้ว · ${event.path}`);
          void this.refreshSuggestions();
        },
        dismissed: () => {
          this.closeCapture();
          this.host.appendTranscript(lane, 'system', `ยกเลิกข้อเสนอ timeline แล้ว · ${suggestion.id}`);
          this.host.flashChip(`ยกเลิก timeline แล้ว · ${suggestion.id}`);
          void this.refreshSuggestions();
        },
      });
      this.host.syncOrchestratorConsoleVisibility();
      const malformed = pending.diagnostics.length + listing.diagnostics.length;
      if (malformed > 0) this.host.flashChip(`เปิดหน้าตรวจทาน timeline แล้ว · พบ record ผิดรูปแบบ ${malformed} รายการ`);
    } catch (e) {
      this.host.flashChip(`เปิดหน้าตรวจทาน timeline ไม่สำเร็จ: ${errorText(e)}`);
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

  async openCapture(
    lane: HarnessLane,
    initialTopic: string,
  ): Promise<void> {
    if (!this.host.harnessMemoryId) {
      this.host.flashChip('ใช้ timeline ไม่ได้: ยังไม่ได้ลงทะเบียน project กับ Harness');
      return;
    }
    try {
      const [listing, config] = await Promise.all([
        invoke<TimelineListResponse>('timeline_list', { harnessId: this.host.harnessMemoryId }),
        loadConfig(),
      ]);
      this.closeCapture();
      const harnessId = this.host.harnessMemoryId;
      this.capture = new TimelineCapture({
        mount: this.host.element,
        events: listing.events,
        recorderLane: lane.displayName,
        initialTopic,
        semantic: this.semanticOptions(harnessId, config),
        save: (request) => invoke<TimelineEvent>('timeline_record', { harnessId, request }),
        close: () => this.closeCapture(),
        saved: (event) => {
          this.closeCapture();
          this.host.appendTranscript(lane, 'system', `บันทึก timeline แล้ว · ${event.id} · ${event.path}`);
          this.host.flashChip(`บันทึก timeline แล้ว · ${event.path}`);
          this.host.render();
        },
      });
      this.host.syncOrchestratorConsoleVisibility();
      if (listing.diagnostics.length > 0) {
        this.host.flashChip(`เปิด timeline แล้ว · พบ record ผิดรูปแบบ ${listing.diagnostics.length} รายการ`);
      }
    } catch (e) {
      this.host.flashChip(`เปิดแบบฟอร์ม timeline ไม่สำเร็จ: ${errorText(e)}`);
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
      this.host.flashChip(
        '#timeline แบบ local storage/review/browser ใช้ไม่ได้ใน remote Harness แต่ยังใช้ trace ได้',
      );
      return;
    }
    if (command.kind === 'review') {
      await this.openSuggestionReview(lane);
      return;
    }
    if (command.kind === 'conflicts') {
      // spec 267: the lane agent finds, judges, and closes conflicts itself.
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
          await this.refreshSuggestionSettings();
        } else {
          const settings = await invoke<TimelineSuggestionSettings>('timeline_suggestion_set_enabled', {
            harnessId: this.host.harnessMemoryId,
            enabled: command.state === 'on',
          });
          this.automaticSuggestions = settings.automaticSuggestions;
        }
        this.host.flashChip(`ข้อเสนอ timeline อัตโนมัติ · ${this.automaticSuggestions ? 'เปิด' : 'ปิด'}`);
      } catch (e) {
        this.host.flashChip(`ตั้งค่า timeline ไม่สำเร็จ: ${errorText(e)}`);
      }
      return;
    }
    if (command.kind === 'merge' || command.kind === 'mergeUndo') {
      await this.runMerge(lane, command);
      return;
    }
    if (command.kind === 'add') {
      await this.openCapture(lane, command.topic);
      return;
    }
    await this.openBrowser(command.topic);
  }

  /**
   * spec 263: repair topics that were already split. `.krypton/` is gitignored,
   * so the backend backs every touched file up before rewriting and this reports
   * the undo in the same line — the human should never have to find it later.
   */
  async runMerge(
    lane: HarnessLane,
    command: { kind: 'merge'; from: string; into: string } | { kind: 'mergeUndo' },
  ): Promise<void> {
    if (!this.host.harnessMemoryId) {
      this.host.flashChip('ใช้ timeline ไม่ได้: ยังไม่ได้ลงทะเบียน project กับ Harness');
      return;
    }
    try {
      if (command.kind === 'mergeUndo') {
        const undone = await invoke<TimelineMergeUndoResult>('timeline_merge_undo', {
          harnessId: this.host.harnessMemoryId,
        });
        const message = `ย้อน merge timeline แล้ว · คืน ${undone.restoredEvents} event กลับไปที่ ${undone.fromTopicId}`;
        this.host.appendTranscript(lane, 'system', message);
        this.host.flashChip(message);
        return;
      }
      const merged = await invoke<TimelineMergeResult>('timeline_merge_topics', {
        harnessId: this.host.harnessMemoryId,
        from: command.from,
        into: command.into,
      });
      const message = `รวม topic timeline แล้ว · ย้าย ${merged.movedEvents} event จาก "${merged.fromTopicTitle}" ไปที่ "${merged.intoTopicTitle}" (${merged.intoTopicId}) · สำรองไฟล์เดิมไว้ที่ ${merged.backupPath} · ย้อนกลับด้วย #timeline merge undo`;
      this.host.appendTranscript(lane, 'system', message);
      this.host.flashChip(message);
    } catch (e) {
      this.host.flashChip(`รวม topic timeline ไม่สำเร็จ: ${errorText(e)}`);
    }
  }
}
