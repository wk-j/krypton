// Krypton — ACP Harness View.
// Coordinates several independent ACP subprocesses for one project directory.

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { AcpClient } from './client';
import type {
  AcpBackendDescriptor,
  AcpEvent,
  AcpMcpServerDescriptor,
  AgentInfo,
  ContentBlock,
  HarnessMemoryEntry,
  HarnessMemorySession,
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  UsageInfo,
} from './types';
import type { ContentView, PaneContentType } from '../types';
import { extractModifiedPath } from './acp-harness-memory';

type HarnessLaneStatus = 'starting' | 'idle' | 'busy' | 'needs_permission' | 'error' | 'stopped';
type ComposerFocus = 'text' | 'transcript';
type PendingExtraction = never;

interface HarnessPermission {
  requestId: number;
  toolCall: ToolCall;
  options: PermissionOption[];
  resolvedLabel?: string;
  auto?: boolean;
}

interface HarnessTranscriptItem {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'permission' | 'restart' | 'memory';
  text: string;
  status?: string;
  diff?: { title: string; unified: string };
}

interface FileTouchRecord {
  path: string;
  laneId: string;
  laneDisplayName: string;
  toolKind: 'edit' | 'write_like';
  at: number;
}

interface HarnessLane {
  id: string;
  index: number;
  backendId: string;
  displayName: string;
  accent: string;
  client: AcpClient | null;
  status: HarnessLaneStatus;
  draft: string;
  cursor: number;
  pendingPermissions: HarnessPermission[];
  transcript: HarnessTranscriptItem[];
  usage: UsageInfo | null;
  sessionId: string | null;
  supportsEmbeddedContext: boolean;
  error: string | null;
  acceptAllForTurn: boolean;
  rejectAllForTurn: boolean;
  pendingTurnExtractions: PendingExtraction[];
  currentAssistantId: string | null;
  currentThoughtId: string | null;
  toolTranscriptIds: Map<string, string>;
  toolCalls: Map<string, ToolCall | ToolCallUpdate>;
  seenTranscriptIds: Set<string>;
  stickToBottom: boolean;
}

const STICK_THRESHOLD_PX = 32;

interface HarnessSpawnSpec {
  backendId: string;
  displayName: string;
  count: number;
}

const DEFAULT_HARNESS_SPAWN: HarnessSpawnSpec[] = [
  { backendId: 'codex', displayName: 'Codex', count: 1 },
  { backendId: 'claude', displayName: 'Claude', count: 1 },
  { backendId: 'gemini', displayName: 'Gemini', count: 1 },
];

const FILE_TOUCH_WINDOW_MS = 10 * 60 * 1000;

const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

export class AcpHarnessView implements ContentView {
  readonly type: PaneContentType = 'acp_harness';
  readonly element: HTMLElement;

  private projectDir: string | null;
  private lanes: HarnessLane[] = [];
  private activeLaneId = '';
  private memoryEntries: HarnessMemoryEntry[] = [];
  private harnessMemoryId: string | null = null;
  private harnessMemoryPort: number | null = null;
  private memoryUnlisten: UnlistenFn | null = null;
  private fileTouchMap = new Map<string, FileTouchRecord>();
  private memoryDrawerOpen = false;
  private helpOpen = false;
  private memoryCursorRowId: string | null = null;
  private focus: ComposerFocus = 'text';
  private chip: string | null = null;
  private chipTimer: number | null = null;
  private systemRows: string[] = ['loading ACP backends...'];
  private closeCb: (() => void) | null = null;

  private topbarEl!: HTMLElement;
  private dashboardEl!: HTMLElement;
  private memoryOverlayEl!: HTMLElement;
  private memoryPanelEl!: HTMLElement;
  private helpOverlayEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private pretextRaf = false;
  private scrollRaf = false;
  private suppressScrollListener = false;

  constructor(projectDir: string | null = null) {
    this.projectDir = projectDir;
    this.element = document.createElement('div');
    this.element.className = 'acp-harness';
    this.element.tabIndex = 0;
    this.buildDOM();
    this.render();
    void this.start();
  }

  getWorkingDirectory(): string | null {
    return this.projectDir;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.helpOpen) {
      e.preventDefault();
      if (e.key === 'Escape' || e.key === '?' || e.key === 'q') this.toggleHelp(false);
      return true;
    }
    if (this.memoryDrawerOpen && this.handleMemoryKey(e)) return true;
    if (this.focus === 'transcript' && this.handleTranscriptKey(e)) return true;

    const lane = this.activeLane();
    if (!lane) return false;

    if (lane.pendingPermissions.length > 0) {
      return this.handlePermissionKey(e, lane);
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.helpOpen) this.toggleHelp(false);
      else if (this.memoryDrawerOpen) this.toggleMemoryDrawer(false);
      else this.enterTranscriptFocus();
      return true;
    }

    if (e.key === 'w' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.closeCb?.();
      return true;
    }

    if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (lane.status === 'busy' || lane.status === 'needs_permission') void this.cancelLane(lane);
      else this.setDraft(lane, '', 0);
      return true;
    }

    if (e.key === 'v' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      return false;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      this.activateLaneByDelta(e.shiftKey ? -1 : 1);
      return true;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.submitActiveLane();
      return true;
    }

    if (this.handleEditingKey(e, lane)) return true;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.insertDraft(lane, e.key);
      return true;
    }
    return false;
  }

  onResize(_width: number, _height: number): void {
    this.schedulePretextLayout();
    this.scheduleStickyScroll();
  }

  dispose(): void {
    for (const lane of this.lanes) {
      if (lane.client) void lane.client.dispose();
      lane.client = null;
    }
    if (this.memoryUnlisten) {
      this.memoryUnlisten();
      this.memoryUnlisten = null;
    }
    if (this.harnessMemoryId) {
      void invoke('dispose_harness_memory', { harnessId: this.harnessMemoryId });
    }
  }

  private buildDOM(): void {
    this.topbarEl = document.createElement('div');
    this.topbarEl.className = 'acp-harness__topbar';
    this.element.appendChild(this.topbarEl);

    const body = document.createElement('div');
    body.className = 'acp-harness__body';
    this.dashboardEl = document.createElement('div');
    this.dashboardEl.className = 'acp-harness__dashboard';
    this.dashboardEl.addEventListener(
      'scroll',
      (e: Event) => {
        if (e.target instanceof HTMLElement && e.target.classList.contains('acp-harness__lane-body')) {
          this.onTranscriptScroll();
        }
      },
      true,
    );
    body.appendChild(this.dashboardEl);

    this.memoryOverlayEl = document.createElement('aside');
    this.memoryOverlayEl.className = 'acp-harness__memory-overlay';
    this.memoryOverlayEl.hidden = true;
    const memoryHead = document.createElement('header');
    memoryHead.className = 'acp-harness__memory-head';
    memoryHead.textContent = 'Memory';
    this.memoryOverlayEl.appendChild(memoryHead);
    this.memoryPanelEl = document.createElement('section');
    this.memoryPanelEl.className = 'acp-harness__memory-panel';
    this.memoryOverlayEl.appendChild(this.memoryPanelEl);
    body.appendChild(this.memoryOverlayEl);

    this.helpOverlayEl = document.createElement('aside');
    this.helpOverlayEl.className = 'acp-harness__help-overlay';
    this.helpOverlayEl.hidden = true;
    body.appendChild(this.helpOverlayEl);
    this.element.appendChild(body);

    const commandCenter = document.createElement('div');
    commandCenter.className = 'acp-harness__command-center';
    this.composerEl = document.createElement('div');
    this.composerEl.className = 'acp-harness__composer';
    commandCenter.appendChild(this.composerEl);
    this.element.appendChild(commandCenter);

    this.element.addEventListener('paste', (e: ClipboardEvent) => {
      if (this.helpOpen || this.memoryDrawerOpen) return;
      const lane = this.activeLane();
      if (!lane || lane.pendingPermissions.length > 0) return;
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      e.preventDefault();
      this.insertDraft(lane, text);
    });
  }

  private async start(): Promise<void> {
    let backends: AcpBackendDescriptor[] = [];
    try {
      await this.initializeHarnessMemory();
      backends = await AcpClient.listBackends();
      this.systemRows = [];
    } catch (e) {
      this.systemRows = [`backend list failed: ${String(e)}`];
    }
    const backendIds = new Set(backends.map((backend) => backend.id));
    let index = 1;
    for (const spec of DEFAULT_HARNESS_SPAWN) {
      if (!backendIds.has(spec.backendId)) {
        this.systemRows.push(`${spec.displayName} backend not installed - skipped`);
        continue;
      }
      for (let i = 0; i < spec.count; i++) {
        const lane = this.createLane(index++, spec.backendId, `${spec.displayName}-${i + 1}`);
        this.lanes.push(lane);
        if (!this.activeLaneId) this.activeLaneId = lane.id;
        this.spawnLane(lane);
      }
    }
    if (this.lanes.length === 0) this.systemRows.push('no ACP backends available');
    this.render();
  }

  private async initializeHarnessMemory(): Promise<void> {
    const session = await invoke<HarnessMemorySession>('create_harness_memory');
    this.harnessMemoryId = session.harnessId;
    this.harnessMemoryPort = session.hookPort;
    this.memoryUnlisten = await listen<{ harnessId: string }>('acp-harness-memory-changed', (event) => {
      if (event.payload.harnessId === this.harnessMemoryId) void this.refreshMemory();
    });
    await this.refreshMemory();
  }

  private async refreshMemory(): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      this.memoryEntries = await invoke<HarnessMemoryEntry[]>('list_harness_memory', {
        harnessId: this.harnessMemoryId,
      });
      this.renderMemory();
      this.renderComposer();
    } catch (e) {
      this.flashChip(`memory unavailable: ${String(e)}`);
    }
  }

  private createLane(index: number, backendId: string, displayName: string): HarnessLane {
    return {
      id: `${backendId}-${index}`,
      index,
      backendId,
      displayName,
      accent: laneAccent(index),
      client: null,
      status: 'starting',
      draft: '',
      cursor: 0,
      pendingPermissions: [],
      transcript: [{ id: makeId(), kind: 'system', text: `starting ${displayName}...` }],
      usage: null,
      sessionId: null,
      supportsEmbeddedContext: false,
      error: null,
      acceptAllForTurn: false,
      rejectAllForTurn: false,
      pendingTurnExtractions: [],
      currentAssistantId: null,
      currentThoughtId: null,
      toolTranscriptIds: new Map(),
      toolCalls: new Map(),
      seenTranscriptIds: new Set(),
      stickToBottom: true,
    };
  }

  private async spawnLane(lane: HarnessLane): Promise<void> {
    lane.status = 'starting';
    lane.error = null;
    this.render();
    try {
      const client = await AcpClient.spawn(lane.backendId, this.projectDir, this.memoryServerForLane(lane));
      lane.client = client;
      client.onEvent((event) => this.onLaneEvent(lane, event));
      const info: AgentInfo = await client.initialize();
      lane.sessionId = info.session_id ?? null;
      lane.supportsEmbeddedContext = !!info.agent_capabilities?.promptCapabilities?.embeddedContext;
      lane.status = 'idle';
      this.appendTranscript(lane, 'system', `connected to ${lane.displayName}.`);
    } catch (e) {
      lane.status = 'error';
      lane.error = String(e);
      this.appendTranscript(lane, 'system', `error: ${String(e)}`);
    }
    this.render();
  }

  private memoryServerForLane(lane: HarnessLane): AcpMcpServerDescriptor[] {
    if (!this.harnessMemoryId || !this.harnessMemoryPort) return [];
    const harness = encodeURIComponent(this.harnessMemoryId);
    const laneLabel = encodeURIComponent(lane.displayName);
    return [{
      name: 'krypton-harness-memory',
      type: 'http',
      url: `http://127.0.0.1:${this.harnessMemoryPort}/mcp/harness/${harness}/lane/${laneLabel}`,
      headers: [],
    }];
  }

  private onLaneEvent(lane: HarnessLane, event: AcpEvent): void {
    switch (event.type) {
      case 'message_chunk':
        this.appendStreaming(lane, 'assistant', event.text);
        break;
      case 'thought_chunk':
        this.appendStreaming(lane, 'thought', event.text);
        break;
      case 'tool_call':
        this.sealStreaming(lane);
        this.renderTool(lane, event.call);
        break;
      case 'tool_call_update':
        this.renderTool(lane, event.update);
        this.observeFileTouch(lane, event.update);
        if (isMemoryTool(event.update)) void this.refreshMemory();
        break;
      case 'plan':
        this.sealStreaming(lane);
        this.renderPlan(lane, event.entries);
        break;
      case 'permission_request':
        this.sealStreaming(lane);
        this.addPermission(lane, event.requestId, event.toolCall, event.options);
        break;
      case 'usage':
        lane.usage = mergeUsage(lane.usage, event.usage);
        break;
      case 'stop':
        this.finishTurn(lane, event.stopReason);
        void this.refreshMemory();
        break;
      case 'error':
        lane.status = 'error';
        lane.error = event.message;
        lane.pendingTurnExtractions = [];
        this.appendTranscript(lane, 'system', `error: ${event.message}`);
        break;
    }
    this.render();
  }

  private async submitActiveLane(): Promise<void> {
    const lane = this.activeLane();
    if (!lane) return;
    const text = lane.draft.trim();
    if (!text) return;
    if (text.startsWith('#')) {
      await this.runHashCommand(lane, text);
      return;
    }
    if (!lane.client || lane.status === 'starting' || lane.status === 'error' || lane.status === 'stopped') {
      this.flashChip(`lane ${lane.status}`);
      return;
    }
    if (lane.status === 'busy' || lane.status === 'needs_permission') {
      this.flashChip('lane busy');
      return;
    }
    this.setDraft(lane, '', 0);
    this.appendTranscript(lane, 'user', text);
    lane.status = 'busy';
    lane.pendingTurnExtractions = [];
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    const blocks = this.buildPromptBlocks(lane, text);
    this.render();
    try {
      await lane.client.prompt(blocks);
    } catch (e) {
      lane.status = 'error';
      lane.error = String(e);
      lane.pendingTurnExtractions = [];
      this.appendTranscript(lane, 'system', `prompt failed: ${String(e)}`);
      this.render();
    }
  }

  private buildPromptBlocks(lane: HarnessLane, userText: string): ContentBlock[] {
    const userBlock: ContentBlock = {
      type: 'text',
      text: userText,
    };
    const packet = this.renderPromptMemoryPacket();
    if (!packet) return [userBlock];
    if (lane.supportsEmbeddedContext) {
      return [
        {
          type: 'resource',
          resource: {
            uri: 'krypton://acp-harness/memory.md',
            mimeType: 'text/markdown',
            text: packet,
          },
        },
        userBlock,
      ];
    }
    return [
      {
        type: 'text',
        text: packet,
      },
      userBlock,
    ];
  }

  private renderPromptMemoryPacket(): string {
    const recent = this.memoryEntries
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);
    const lines = recent.map((entry) => `- [${entry.id}] ${entry.summary}`);
    return [
      '# Krypton harness memory',
      'Tab-local memory is managed through the MCP tools memory_create, memory_update, memory_delete, memory_search, and memory_get.',
      'Use summaries as context. Call memory_get when a summary matters and you need the full detail. Create or update memory only for reusable facts.',
      lines.length ? '' : null,
      lines.length ? lines.join('\n') : null,
    ].filter((line): line is string => line !== null).join('\n');
  }

  private finishTurn(lane: HarnessLane, stopReason: StopReason): void {
    this.sealStreaming(lane);
    if (stopReason === 'cancelled') {
      this.appendTranscript(lane, 'system', 'turn cancelled');
    }
    lane.pendingTurnExtractions = [];
    lane.pendingPermissions = [];
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
    lane.status = lane.error ? 'error' : 'idle';
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    if (stopReason !== 'end_turn' && stopReason !== 'cancelled') {
      this.appendTranscript(lane, 'system', `turn ended: ${stopReason}`);
    }
    if (lane.draft.trim()) this.flashChip('lane idle - Enter to send');
  }

  private observeFileTouch(lane: HarnessLane, call: ToolCall | ToolCallUpdate): void {
    const path = extractModifiedPath(call);
    if (path && call.status === 'completed') {
      this.fileTouchMap.set(path, {
        path,
        laneId: lane.id,
        laneDisplayName: lane.displayName,
        toolKind: call.kind === 'edit' ? 'edit' : 'write_like',
        at: Date.now(),
      });
    }
  }

  private addPermission(lane: HarnessLane, requestId: number, toolCall: ToolCall, options: PermissionOption[]): void {
    const permission: HarnessPermission = { requestId, toolCall, options };
    lane.pendingPermissions.push(permission);
    lane.status = 'needs_permission';
    this.appendTranscript(lane, 'permission', this.describePermission(lane, permission));
    if (lane.acceptAllForTurn || lane.rejectAllForTurn) {
      void this.resolvePermission(lane, lane.rejectAllForTurn ? 'reject' : 'accept', true);
    }
  }

  private async resolvePermission(lane: HarnessLane, action: 'accept' | 'reject', auto: boolean): Promise<void> {
    const permission = lane.pendingPermissions[0];
    if (!permission || !lane.client) return;
    const option = pickPermissionOption(permission.options, action);
    if (action === 'accept' && !option) {
      this.flashChip('no accept option');
      return;
    }
    lane.pendingPermissions.shift();
    const label = option?.name ?? (action === 'accept' ? 'accepted' : 'rejected');
    permission.resolvedLabel = `${action === 'accept' ? 'accepted' : 'rejected'}${auto ? ' (auto for remainder of this turn)' : ''}: ${label}`;
    permission.auto = auto;
    this.appendTranscript(lane, 'permission', permission.resolvedLabel);
    try {
      await lane.client.respondPermission(permission.requestId, option?.optionId ?? null);
    } catch (e) {
      this.appendTranscript(lane, 'system', `permission reply failed: ${String(e)}`);
    }
    if (lane.pendingPermissions.length === 0 && lane.status === 'needs_permission') lane.status = 'busy';
    this.render();
  }

  private describePermission(lane: HarnessLane, permission: HarnessPermission): string {
    const call = permission.toolCall;
    const path = extractModifiedPath(call) ?? call.locations?.[0]?.path ?? call.title ?? 'unknown target';
    const lines = [`permission required`, `operation: ${call.kind ?? 'tool'}`, `path: ${path}`];
    const touch = this.fileTouchMap.get(path);
    if (touch && touch.laneId !== lane.id && Date.now() - touch.at <= FILE_TOUCH_WINDOW_MS) {
      lines.push(`also touched by ${touch.laneDisplayName} ${formatAge(Date.now() - touch.at)} ago (${touch.toolKind})`);
    }
    return lines.join('\n');
  }

  private async cancelLane(lane: HarnessLane): Promise<void> {
    if (!lane.client) return;
    lane.pendingTurnExtractions = [];
    try {
      await lane.client.cancel();
      this.appendTranscript(lane, 'system', 'cancel requested');
    } catch (e) {
      this.appendTranscript(lane, 'system', `cancel failed: ${String(e)}`);
    }
    this.render();
  }

  private async restartLane(lane: HarnessLane): Promise<void> {
    if (lane.status !== 'error' && lane.status !== 'stopped') {
      this.flashChip(`lane ${lane.status} - #cancel first`);
      return;
    }
    if (lane.client) {
      await lane.client.dispose();
      lane.client = null;
    }
    lane.pendingPermissions = [];
    lane.pendingTurnExtractions = [];
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
    lane.sessionId = null;
    lane.error = null;
    this.appendTranscript(lane, 'restart', '--- session restarted ---');
    await this.spawnLane(lane);
  }

  private async runHashCommand(lane: HarnessLane, text: string): Promise<void> {
    const parts = text.trim().split(/\s+/);
    if (parts[0] === '#cancel') {
      await this.cancelLane(lane);
      this.setDraft(lane, '', 0);
      return;
    }
    if (parts[0] === '#restart') {
      this.setDraft(lane, '', 0);
      await this.restartLane(lane);
      return;
    }
    if (parts[0] === '#mem') {
      this.flashChip('memory is agent-managed');
      this.setDraft(lane, '', 0);
      this.render();
      return;
    }
    this.flashChip('unknown command');
  }

  private render(): void {
    this.element.classList.toggle('acp-harness--transcript-focus', this.focus === 'transcript');
    this.renderTopbar();
    this.renderDashboard();
    this.renderMemory();
    this.renderHelp();
    this.renderComposer();
    this.scheduleStickyScroll();
  }

  private renderTopbar(): void {
    const counts = countStatuses(this.lanes);
    const cwd = this.projectDir ? abbreviatePath(this.projectDir) : 'no cwd';
    const shared = this.lanes.filter((lane) => lane.status === 'idle' || lane.status === 'busy').length > 1 ? ' · shared cwd' : '';
    this.topbarEl.innerHTML =
      `<span class="acp-harness__title">ACP Harness</span>` +
      `<span class="acp-harness__cwd" title="${esc(this.projectDir ?? '')}">${esc(cwd)}</span>` +
      `<span class="acp-harness__counts">${counts.idle} idle · ${counts.busy} busy · ${counts.permission} perm · ${counts.error} error${shared}</span>`;
  }

  private renderDashboard(): void {
    this.dashboardEl.innerHTML = '';
    if (this.lanes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'acp-harness__empty';
      empty.textContent = this.systemRows.join('\n') || 'no ACP lanes';
      this.dashboardEl.appendChild(empty);
      return;
    }
    for (const lane of this.lanes) {
      const active = lane.id === this.activeLaneId;
      const laneEl = document.createElement(active ? 'section' : 'div');
      laneEl.className = `acp-harness__lane ${active ? 'acp-harness__lane--active' : 'acp-harness__lane--collapsed'} acp-harness__lane--${lane.status}`;
      laneEl.style.setProperty('--acp-lane-accent', lane.accent);
      const head = document.createElement('header');
      head.className = 'acp-harness__lane-head';
      head.innerHTML = renderLaneHead(lane, active);
      laneEl.appendChild(head);
      if (active) {
        const stats = document.createElement('div');
        stats.className = 'acp-harness__lane-stats';
        stats.innerHTML = renderLaneStats(lane);
        laneEl.appendChild(stats);
        const body = document.createElement('div');
        body.className = 'acp-harness__lane-body';
        if (lane.transcript.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'acp-harness__transcript-empty';
          empty.textContent = 'lane transcript will appear here';
          body.appendChild(empty);
        } else {
          for (const item of lane.transcript) {
            const isNew = !lane.seenTranscriptIds.has(item.id);
            const streaming = item.id === lane.currentAssistantId || item.id === lane.currentThoughtId;
            body.appendChild(renderTranscriptItem(item, isNew, streaming));
            lane.seenTranscriptIds.add(item.id);
          }
        }
        laneEl.appendChild(body);
      }
      this.dashboardEl.appendChild(laneEl);
    }
    this.schedulePretextLayout();
  }

  private renderMemory(): void {
    this.memoryOverlayEl.hidden = !this.memoryDrawerOpen;
    const head = this.memoryOverlayEl.querySelector('.acp-harness__memory-head');
    if (head) {
      head.textContent = `Memory · ${this.memoryEntries.length} entries`;
    }
    this.memoryPanelEl.innerHTML = '';
    const rows = this.sortedMemoryRows();
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'acp-harness__memory-empty';
      empty.textContent = 'no memory yet';
      this.memoryPanelEl.appendChild(empty);
      return;
    }
    if (!this.memoryCursorRowId || !rows.some((entry) => entry.id === this.memoryCursorRowId)) {
      this.memoryCursorRowId = rows[0]?.id ?? null;
    }
    for (const entry of rows) {
      const row = document.createElement('div');
      const selected = entry.id === this.memoryCursorRowId;
      row.className = `acp-harness__memory-row${selected ? ' acp-harness__memory-row--cursor' : ''}`;
      row.innerHTML =
        `<span class="acp-harness__memory-id">${esc(entry.id)}</span>` +
        `<span class="acp-harness__memory-source" style="--acp-memory-accent:${esc(laneAccentForLabel(entry.updatedBy))}">${esc(entry.updatedBy)}</span>` +
        `<span class="acp-harness__memory-text">${esc(entry.summary)}</span>` +
        `<span class="acp-harness__memory-kind">${esc(formatShortTime(entry.updatedAt))}</span>` +
        (selected ? `<div class="acp-harness__memory-detail">${esc(entry.detail)}</div>` : '');
      this.memoryPanelEl.appendChild(row);
    }
  }

  private renderComposer(): void {
    const lane = this.activeLane();
    if (!lane) {
      this.composerEl.textContent = 'no lanes';
      return;
    }
    if (lane.pendingPermissions.length > 0) {
      this.composerEl.className = 'acp-harness__composer acp-harness__composer--permission';
      this.composerEl.innerHTML =
        `<div class="acp-harness__composer-meta">! permission required - see lane</div>` +
        `<div class="acp-harness__permission-options">a accept &nbsp;&nbsp; A accept-all-turn &nbsp;&nbsp; r reject &nbsp;&nbsp; R reject-all-turn &nbsp;&nbsp; Esc cancel</div>`;
      return;
    }
    this.composerEl.className = `acp-harness__composer${this.focus === 'transcript' ? ' acp-harness__composer--command' : ''}`;
    const chip = this.chip ?? (this.focus === 'transcript'
      ? 'command mode: 1-9 lanes · v memory · ? help · i/Esc input'
      : `memory: ${Math.min(this.memoryEntries.length, 10)}/${this.memoryEntries.length}`);
    const before = lane.draft.slice(0, lane.cursor);
    const after = lane.draft.slice(lane.cursor);
    this.composerEl.style.setProperty('--acp-lane-accent', lane.accent);
    this.composerEl.innerHTML =
      `<div class="acp-harness__composer-meta"><span class="acp-harness__memory-chip">${esc(chip)}</span></div>` +
      `<div class="acp-harness__input-line">` +
      `<span class="acp-harness__lane-tag">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__prompt">›</span>` +
      `<span class="acp-harness__input">${esc(before)}<span class="acp-harness__caret">█</span>${esc(after)}</span>` +
      `<span class="acp-harness__help-hint">? help</span></div>`;
  }

  private renderHelp(): void {
    this.helpOverlayEl.hidden = !this.helpOpen;
    if (!this.helpOpen) return;
    this.helpOverlayEl.innerHTML = `
      <header class="acp-harness__help-head">
        <span>ACP Harness Help</span>
        <span>Esc / ? / q closes</span>
      </header>
      <div class="acp-harness__help-grid">
        <section class="acp-harness__help-section">
          <h3>Lane Control</h3>
          <dl>
            <dt>Tab / Shift+Tab</dt><dd>Next / previous lane</dd>
            <dt>Esc, then 1-9</dt><dd>Switch lane in transcript mode</dd>
            <dt>Esc, then ?</dt><dd>Open help</dd>
            <dt>Tab buttons</dt><dd>Click a lane directly</dd>
            <dt>Enter</dt><dd>Send prompt to active lane only</dd>
            <dt>Shift+Enter</dt><dd>Insert newline</dd>
            <dt>Ctrl+C</dt><dd>Cancel active busy lane</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section">
          <h3>Permissions</h3>
          <dl>
            <dt>a</dt><dd>Accept current request once</dd>
            <dt>A</dt><dd>Accept all for current turn</dd>
            <dt>r</dt><dd>Reject current request once</dd>
            <dt>R</dt><dd>Reject all for current turn</dd>
            <dt>Esc</dt><dd>Reject / cancel request</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section">
          <h3>Memory</h3>
          <dl>
            <dt>Esc, then v</dt><dd>Toggle memory drawer</dd>
            <dt>j / k</dt><dd>Move memory cursor</dd>
            <dt>g / G</dt><dd>Top / bottom of memory list</dd>
            <dt>Agents</dt><dd>Create, update, delete, search, and fetch detail through MCP tools</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section">
          <h3>Transcript</h3>
          <dl>
            <dt>Esc</dt><dd>Focus active transcript scrolling</dd>
            <dt>i / Esc</dt><dd>Return to input composer</dd>
            <dt>1-9</dt><dd>Switch lane</dd>
            <dt>j / k</dt><dd>Scroll line by line</dd>
            <dt>Ctrl+d / Ctrl+u</dt><dd>Page down / up</dd>
            <dt>g / G</dt><dd>Top / bottom</dd>
            <dt>q</dt><dd>Close harness tab</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section acp-harness__help-section--wide">
          <h3>Commands</h3>
          <dl>
            <dt>#cancel</dt><dd>Cancel active lane, same as Ctrl+C</dd>
            <dt>#restart</dt><dd>Respawn active lane when error or stopped</dd>
            <dt>#mem</dt><dd>Show that memory is agent-managed</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section acp-harness__help-section--wide">
          <h3>Model</h3>
          <p>Each lane is a separate ACP subprocess in the same project directory. Prompts go only to the active lane. Memory is tab-local, read-only for humans, and managed by agents through MCP tools.</p>
        </section>
      </div>
    `;
  }

  private appendTranscript(lane: HarnessLane, kind: HarnessTranscriptItem['kind'], text: string): HarnessTranscriptItem {
    const item = { id: makeId(), kind, text };
    lane.transcript.push(item);
    if (lane.transcript.length > 300) {
      const dropped = lane.transcript.shift();
      if (dropped) lane.seenTranscriptIds.delete(dropped.id);
    }
    return item;
  }

  private appendStreaming(lane: HarnessLane, kind: 'assistant' | 'thought', text: string): void {
    const currentId = kind === 'assistant' ? lane.currentAssistantId : lane.currentThoughtId;
    let item = currentId ? lane.transcript.find((entry) => entry.id === currentId) : null;
    if (!item) {
      item = this.appendTranscript(lane, kind, '');
      if (kind === 'assistant') lane.currentAssistantId = item.id;
      else lane.currentThoughtId = item.id;
    }
    item.text += text;
  }

  private sealStreaming(lane: HarnessLane): void {
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
  }

  private renderTool(lane: HarnessLane, call: ToolCall | ToolCallUpdate): void {
    if (!call.toolCallId) return;
    const merged = mergeToolCall(lane.toolCalls.get(call.toolCallId), call);
    lane.toolCalls.set(call.toolCallId, merged);
    const status = merged.status ?? 'pending';
    const output = renderToolOutputBlock(merged);
    const text = output
      ? `${statusGlyph(status)} ${renderToolSummary(merged)}\n${output}`
      : `${statusGlyph(status)} ${renderToolSummary(merged)}`;
    const existingId = lane.toolTranscriptIds.get(merged.toolCallId);
    const existing = existingId ? lane.transcript.find((item) => item.id === existingId) : null;
    if (existing) {
      existing.text = text;
      existing.status = status;
      return;
    }
    const item = this.appendTranscript(lane, 'tool', text);
    item.status = status;
    lane.toolTranscriptIds.set(merged.toolCallId, item.id);
  }

  private renderPlan(lane: HarnessLane, entries: PlanEntry[]): void {
    const text = entries.map((entry) => `${entry.status === 'completed' ? '[x]' : entry.status === 'in_progress' ? '[~]' : '[ ]'} ${entry.content}`).join('\n');
    this.appendTranscript(lane, 'plan', text);
  }

  private handlePermissionKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    if (e.key === 'a' || e.key === 'A' || e.key === 'r' || e.key === 'R' || e.key === 'Escape') {
      e.preventDefault();
      const reject = e.key === 'r' || e.key === 'R' || e.key === 'Escape';
      if (e.key === 'A') lane.acceptAllForTurn = true;
      if (e.key === 'R') lane.rejectAllForTurn = true;
      void this.resolvePermission(lane, reject ? 'reject' : 'accept', e.key === 'A' || e.key === 'R');
      return true;
    }
    return true;
  }

  private handleMemoryKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' || e.key === 'v') {
      e.preventDefault();
      this.toggleMemoryDrawer(false);
      return true;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggleHelp(true);
      return true;
    }
    if (['j', 'k', 'g', 'G'].includes(e.key)) {
      e.preventDefault();
      this.moveMemoryCursor(e.key);
      return true;
    }
    return false;
  }

  private handleTranscriptKey(e: KeyboardEvent): boolean {
    const body = this.dashboardEl.querySelector<HTMLElement>('.acp-harness__lane--active .acp-harness__lane-body');
    if (!body) return false;
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const lane = this.lanes[Number(e.key) - 1];
      if (lane) {
        e.preventDefault();
        this.activateLane(lane.id);
        this.focus = 'transcript';
        this.element.classList.add('acp-harness--transcript-focus');
        return true;
      }
    }
    if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggleMemoryDrawer(true);
      return true;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggleHelp(true);
      return true;
    }
    if (e.key === 'j') { e.preventDefault(); body.scrollBy({ top: 24, behavior: 'instant' }); return true; }
    if (e.key === 'k') { e.preventDefault(); body.scrollBy({ top: -24, behavior: 'instant' }); return true; }
    if (e.key === 'g') { e.preventDefault(); body.scrollTop = 0; return true; }
    if (e.key === 'G') { e.preventDefault(); body.scrollTop = body.scrollHeight; return true; }
    if (e.key === 'q') { e.preventDefault(); this.closeCb?.(); return true; }
    if (e.key === 'Escape' || e.key === 'i') { e.preventDefault(); this.focus = 'text'; this.render(); return true; }
    if ((e.key === 'd' && e.ctrlKey) || e.key === 'PageDown') { e.preventDefault(); body.scrollBy({ top: body.clientHeight * 0.5, behavior: 'instant' }); return true; }
    if ((e.key === 'u' && e.ctrlKey) || e.key === 'PageUp') { e.preventDefault(); body.scrollBy({ top: -body.clientHeight * 0.5, behavior: 'instant' }); return true; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return true;
    }
    return false;
  }

  private handleEditingKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    const len = lane.draft.length;
    const pos = lane.cursor;
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
    const cmdOnly = e.metaKey && !e.ctrlKey && !e.altKey;
    const noMod = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); this.insertDraft(lane, '\n'); return true; }
    if (e.key === 'ArrowLeft' && noMod) { e.preventDefault(); this.setDraftCursor(lane, pos - 1); return true; }
    if (e.key === 'ArrowRight' && noMod) { e.preventDefault(); this.setDraftCursor(lane, pos + 1); return true; }
    if (e.key === 'Home' || (ctrlOnly && e.key === 'a') || (cmdOnly && e.key === 'ArrowLeft')) { e.preventDefault(); this.setDraftCursor(lane, 0); return true; }
    if (e.key === 'End' || (ctrlOnly && e.key === 'e') || (cmdOnly && e.key === 'ArrowRight')) { e.preventDefault(); this.setDraftCursor(lane, len); return true; }
    if (e.key === 'Backspace' && noMod) {
      e.preventDefault();
      if (pos > 0) this.setDraft(lane, lane.draft.slice(0, pos - 1) + lane.draft.slice(pos), pos - 1);
      return true;
    }
    if (e.key === 'Delete' && noMod) {
      e.preventDefault();
      if (pos < len) this.setDraft(lane, lane.draft.slice(0, pos) + lane.draft.slice(pos + 1), pos);
      return true;
    }
    if (ctrlOnly && e.key === 'u') { e.preventDefault(); this.setDraft(lane, lane.draft.slice(pos), 0); return true; }
    if (ctrlOnly && e.key === 'k') { e.preventDefault(); this.setDraft(lane, lane.draft.slice(0, pos), pos); return true; }
    return false;
  }

  private insertDraft(lane: HarnessLane, text: string): void {
    this.setDraft(lane, lane.draft.slice(0, lane.cursor) + text + lane.draft.slice(lane.cursor), lane.cursor + text.length);
  }

  private setDraft(lane: HarnessLane, text: string, cursor: number): void {
    lane.draft = text;
    lane.cursor = Math.max(0, Math.min(cursor, text.length));
    this.focus = 'text';
    this.renderComposer();
  }

  private setDraftCursor(lane: HarnessLane, cursor: number): void {
    lane.cursor = Math.max(0, Math.min(cursor, lane.draft.length));
    this.renderComposer();
  }

  private activeLane(): HarnessLane | null {
    return this.lanes.find((lane) => lane.id === this.activeLaneId) ?? null;
  }

  private activateLane(id: string): void {
    this.activeLaneId = id;
    this.focus = 'text';
    this.render();
    this.scrollActiveTranscriptToBottom();
  }

  private activateLaneByDelta(delta: number): void {
    if (this.lanes.length === 0) return;
    const index = Math.max(0, this.lanes.findIndex((lane) => lane.id === this.activeLaneId));
    const next = (index + delta + this.lanes.length) % this.lanes.length;
    this.activateLane(this.lanes[next].id);
  }

  private enterTranscriptFocus(): void {
    this.focus = 'transcript';
    this.render();
  }

  private toggleMemoryDrawer(open: boolean): void {
    this.memoryDrawerOpen = open;
    if (open) this.helpOpen = false;
    this.render();
  }

  private toggleHelp(open: boolean): void {
    this.helpOpen = open;
    if (open) this.memoryDrawerOpen = false;
    this.render();
  }

  private sortedMemoryRows(): HarnessMemoryEntry[] {
    return this.memoryEntries.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private moveMemoryCursor(key: string): void {
    const rows = this.sortedMemoryRows();
    if (rows.length === 0) return;
    const current = rows.findIndex((entry) => entry.id === this.memoryCursorRowId);
    let next = current < 0 ? 0 : current;
    if (key === 'j') next = Math.min(rows.length - 1, next + 1);
    else if (key === 'k') next = Math.max(0, next - 1);
    else if (key === 'g') next = 0;
    else if (key === 'G') next = rows.length - 1;
    this.memoryCursorRowId = rows[next].id;
    this.renderMemory();
  }

  private flashChip(text: string): void {
    this.chip = text;
    if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
    this.chipTimer = window.setTimeout(() => {
      this.chip = null;
      this.renderComposer();
    }, 2000);
    this.renderComposer();
  }

  private scrollActiveTranscriptToBottom(): void {
    const lane = this.activeLane();
    if (lane) lane.stickToBottom = true;
    this.scheduleStickyScroll();
  }

  private scheduleStickyScroll(): void {
    if (this.scrollRaf) return;
    this.scrollRaf = true;
    requestAnimationFrame(() => {
      this.scrollRaf = false;
      this.applyStickyScroll();
      requestAnimationFrame(() => this.applyStickyScroll());
    });
  }

  private applyStickyScroll(): void {
    const lane = this.activeLane();
    if (!lane || !lane.stickToBottom) return;
    const body = this.activeTranscriptBody();
    if (!body) return;
    this.suppressScrollListener = true;
    body.scrollTop = body.scrollHeight;
    this.suppressScrollListener = false;
  }

  private activeTranscriptBody(): HTMLElement | null {
    return this.dashboardEl.querySelector<HTMLElement>('.acp-harness__lane--active .acp-harness__lane-body');
  }

  private onTranscriptScroll(): void {
    if (this.suppressScrollListener) return;
    const lane = this.activeLane();
    const body = this.activeTranscriptBody();
    if (!lane || !body) return;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    lane.stickToBottom = distance <= STICK_THRESHOLD_PX;
  }

  private schedulePretextLayout(): void {
    if (this.pretextRaf) return;
    this.pretextRaf = true;
    requestAnimationFrame(() => {
      this.pretextRaf = false;
      this.layoutPretextRows();
      this.applyStickyScroll();
    });
  }

  private layoutPretextRows(): void {
    const rows = this.dashboardEl.querySelectorAll<HTMLElement>('.acp-harness__msg-body[data-pretext="true"]');
    for (const row of rows) {
      const raw = row.dataset.rawText ?? '';
      const width = row.clientWidth;
      if (!raw || width <= 0) continue;
      const cs = getComputedStyle(row);
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      let lineHeight = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeight)) lineHeight = (parseFloat(cs.fontSize) || 13) * 1.35;
      try {
        const prepared = prepareWithSegments(raw, font, { whiteSpace: 'pre-wrap' });
        const { lines } = layoutWithLines(prepared, width, lineHeight);
        row.textContent = '';
        for (const line of lines) {
          const lineEl = document.createElement('div');
          lineEl.className = 'acp-harness__pretext-line';
          lineEl.textContent = line.text || '\u00a0';
          row.appendChild(lineEl);
        }
      } catch {
        row.textContent = raw;
      }
    }
  }
}

function pickPermissionOption(options: PermissionOption[], action: 'accept' | 'reject'): PermissionOption | null {
  if (action === 'accept') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? null;
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? null;
}

function renderTranscriptItem(item: HarnessTranscriptItem, isNew: boolean, streaming: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className =
    `acp-harness__msg acp-harness__msg--${item.kind}` +
    `${item.status ? ` acp-harness__msg--${item.status}` : ''}` +
    `${isNew ? ' acp-harness__msg--enter' : ''}` +
    `${streaming ? ' acp-harness__msg--streaming' : ''}`;
  const label = document.createElement('div');
  label.className = 'acp-harness__msg-label';
  label.textContent = transcriptLabel(item.kind);
  const body = document.createElement('div');
  body.className = 'acp-harness__msg-body';
  if (item.kind === 'assistant') {
    body.classList.add('acp-harness__msg-body--markdown');
    try {
      body.innerHTML = md.parse(item.text, { async: false }) as string;
    } catch {
      body.textContent = item.text;
    }
  } else if (usesPretext(item.kind)) {
    body.dataset.pretext = 'true';
    body.dataset.rawText = item.text;
    body.textContent = item.text;
  } else {
    body.textContent = item.text;
  }
  el.appendChild(label);
  el.appendChild(body);
  return el;
}

function usesPretext(kind: HarnessTranscriptItem['kind']): boolean {
  return kind !== 'assistant';
}

function renderLaneHead(lane: HarnessLane, active: boolean): string {
  if (!active) {
    return (
      `<span class="acp-harness__lane-index">${lane.index}</span>` +
      `<span class="acp-harness__lane-symbol">${statusSymbol(lane.status)}</span>` +
      `<span class="acp-harness__lane-name">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__lane-activity">${esc(laneActivity(lane))}</span>`
    );
  }
  return (
    `<span class="acp-harness__lane-index">${lane.index}</span>` +
    `<span class="acp-harness__lane-symbol">${statusSymbol(lane.status)}</span>` +
    `<span class="acp-harness__lane-name">${esc(lane.displayName)}</span>` +
    `<span class="acp-harness__lane-status">${esc(statusLabel(lane.status))}</span>` +
    `<span class="acp-harness__lane-activity">${esc(laneActivity(lane))}</span>`
  );
}

function laneAccent(index: number): string {
  const accents = [
    'var(--krypton-window-accent, #0cf)',
    '#8effb0',
    '#ffd166',
    '#c77dff',
    '#ff6b8b',
    '#5fb3b3',
  ];
  return accents[(index - 1) % accents.length];
}

function laneAccentForLabel(label: string): string {
  if (/codex/i.test(label)) return laneAccent(1);
  if (/claude/i.test(label)) return laneAccent(2);
  if (/gemini/i.test(label)) return laneAccent(3);
  const match = label.match(/-(\d+)$/);
  return match ? laneAccent(Number(match[1])) : 'var(--krypton-window-accent, #0cf)';
}

function renderLaneStats(lane: HarnessLane): string {
  const parts = [
    `backend ${lane.backendId}`,
    lane.sessionId ? `session ${shortId(lane.sessionId)}` : 'session pending',
    `${lane.transcript.length} rows`,
  ];
  if (lane.pendingPermissions.length > 0) parts.push(`${lane.pendingPermissions.length} permission`);
  if (lane.usage) {
    if (typeof lane.usage.used === 'number') parts.push(`${formatCount(lane.usage.used)} ctx`);
    else if (typeof lane.usage.inputTokens === 'number' || typeof lane.usage.outputTokens === 'number') {
      parts.push(`in ${formatCount(lane.usage.inputTokens ?? 0)} / out ${formatCount(lane.usage.outputTokens ?? 0)}`);
    }
    if (lane.usage.cost) parts.push(`${lane.usage.cost.amount.toFixed(4)} ${lane.usage.cost.currency}`);
  }
  return parts.map((part) => `<span>${esc(part)}</span>`).join('');
}

function transcriptLabel(kind: HarnessTranscriptItem['kind']): string {
  switch (kind) {
    case 'system': return 'sys';
    case 'assistant': return 'agent';
    case 'permission': return 'perm';
    case 'memory': return 'mem';
    default: return kind;
  }
}

function mergeUsage(prev: UsageInfo | null, next: UsageInfo): UsageInfo {
  return { ...(prev ?? {}), ...next };
}

function countStatuses(lanes: HarnessLane[]): { idle: number; busy: number; permission: number; error: number } {
  return {
    idle: lanes.filter((lane) => lane.status === 'idle').length,
    busy: lanes.filter((lane) => lane.status === 'busy' || lane.status === 'starting').length,
    permission: lanes.filter((lane) => lane.status === 'needs_permission').length,
    error: lanes.filter((lane) => lane.status === 'error').length,
  };
}

function laneActivity(lane: HarnessLane): string {
  if (lane.status === 'error') return `error: ${lane.error ?? 'failed'}`;
  if (lane.status === 'needs_permission') return `perm: ${lane.pendingPermissions[0]?.toolCall.title ?? 'required'}`;
  const latest = lane.transcript[lane.transcript.length - 1];
  if (!latest) return lane.status;
  return latest.text.replace(/\s+/g, ' ').slice(0, 60);
}

function statusSymbol(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return '·';
    case 'idle': return '○';
    case 'busy': return '●';
    case 'needs_permission': return '!';
    case 'error': return '×';
    case 'stopped': return '×';
  }
}

function statusLabel(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'starting';
    case 'idle': return 'idle';
    case 'busy': return 'busy';
    case 'needs_permission': return 'permission';
    case 'error': return 'error';
    case 'stopped': return 'stopped';
  }
}

function statusGlyph(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'in_progress') return '⟳';
  return '·';
}

function mergeToolCall(
  previous: ToolCall | ToolCallUpdate | undefined,
  next: ToolCall | ToolCallUpdate,
): ToolCall | ToolCallUpdate {
  return {
    ...previous,
    ...next,
    title: next.title ?? previous?.title,
    kind: next.kind ?? previous?.kind,
    content: next.content ?? previous?.content,
    locations: next.locations ?? previous?.locations,
    rawInput: next.rawInput ?? previous?.rawInput,
    rawOutput: next.rawOutput ?? previous?.rawOutput,
  };
}

function renderToolSummary(call: ToolCall | ToolCallUpdate): string {
  const kind = inferToolLabel(call);
  const path = extractModifiedPath(call);
  const command = kind === 'execute' ? extractCommandLine(call.rawInput) : '';
  const subject = command || path || cleanToolTitle(call.title, kind) || kind;
  const result = renderToolResult(call);
  const label = subject === kind ? kind : `${kind} ${subject}`;
  return result ? `${label} -> ${result}` : label;
}

function inferToolLabel(call: ToolCall | ToolCallUpdate): string {
  const kind = call.kind;
  if (kind && kind !== 'other') return kind;
  if (extractCommandLine(call.rawInput)) return 'execute';
  const rawName = extractRawToolName(call.rawInput);
  if (rawName) return rawName;
  const title = cleanToolTitle(call.title, 'tool').toLowerCase();
  if (/^(bash|shell|terminal|run|exec|execute|command)\b/.test(title)) return 'execute';
  if (/^(edit|write|create|modify|patch)\b/.test(title)) return 'edit';
  if (/^(read|open|cat)\b/.test(title)) return 'read';
  if (/^(search|grep|rg|find)\b/.test(title)) return 'search';
  if (/^(fetch|web|http)\b/.test(title)) return 'fetch';
  return title || 'tool';
}

function extractRawToolName(rawInput: unknown): string {
  if (typeof rawInput !== 'object' || !rawInput) return '';
  const record = rawInput as Record<string, unknown>;
  for (const key of ['toolName', 'tool_name', 'name', 'tool', 'type']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return truncateInline(value, 40);
  }
  return '';
}

function isMemoryTool(call: ToolCall | ToolCallUpdate): boolean {
  const rawName = extractRawToolName(call.rawInput).toLowerCase();
  const title = (call.title ?? '').toLowerCase();
  return rawName.startsWith('memory_') || title.includes('memory_');
}

function cleanToolTitle(title: string | undefined, fallback: string): string {
  const value = title?.trim() ?? '';
  if (!value || value.toLowerCase() === 'tool' || value.toLowerCase() === fallback) return '';
  if (/^tool\s+exit\s+\d+$/i.test(value)) return '';
  return value;
}

function extractCommandLine(rawInput: unknown): string {
  if (typeof rawInput === 'object' && rawInput) {
    const record = rawInput as Record<string, unknown>;
    for (const key of ['command', 'cmd']) {
      if (typeof record[key] === 'string') return truncateInline(record[key], 96);
    }
    if (Array.isArray(record.argv)) {
      const argv = record.argv.filter((part): part is string => typeof part === 'string');
      if (argv.length > 0) return truncateInline(argv.join(' '), 96);
    }
  }
  return '';
}

function renderToolResult(call: ToolCall | ToolCallUpdate): string {
  const exit = extractToolExit(call.rawOutput);
  if (exit) return exit;
  return call.status === 'failed' ? 'failed' : '';
}

function extractToolExit(rawOutput: unknown): string {
  if (typeof rawOutput !== 'object' || !rawOutput) return '';
  const record = rawOutput as Record<string, unknown>;
  for (const key of ['exitCode', 'exit_code', 'code']) {
    if (typeof record[key] === 'number') return `exit ${record[key]}`;
  }
  return '';
}

function renderToolOutputBlock(call: ToolCall | ToolCallUpdate): string {
  const raw = rawOutputSections(call.rawOutput);
  const content = raw.length > 0 ? [] : contentOutputSections(call.content);
  const sections = raw.length > 0 ? raw : content;
  const lines: string[] = [];
  for (const section of sections) {
    const preview = boundedOutputLines(section.text, 6);
    if (!preview) continue;
    lines.push(`${section.label}: ${preview}`);
    if (lines.length >= 8) break;
  }
  return lines.join('\n');
}

function rawOutputSections(rawOutput: unknown): Array<{ label: string; text: string }> {
  if (typeof rawOutput === 'object' && rawOutput) {
    const record = rawOutput as Record<string, unknown>;
    const sections: Array<{ label: string; text: string }> = [];
    for (const key of ['summary', 'stdout', 'stderr', 'output', 'content', 'text', 'message']) {
      const text = stringifyToolValue(record[key]);
      if (text) sections.push({ label: key, text });
    }
    return sections;
  }
  const text = stringifyToolValue(rawOutput);
  return text ? [{ label: 'output', text }] : [];
}

function contentOutputSections(content: ToolCall['content']): Array<{ label: string; text: string }> {
  const sections: Array<{ label: string; text: string }> = [];
  for (const item of content ?? []) {
    if (item.type === 'diff' && item.path) sections.push({ label: 'diff', text: item.path });
    if (item.type === 'terminal' && item.terminalId) sections.push({ label: 'terminal', text: item.terminalId });
    if (item.type === 'content' && item.content) {
      const text = contentBlockText(item.content);
      if (text) sections.push({ label: 'content', text });
    }
  }
  return sections;
}

function contentBlockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource' && block.resource.text) return block.resource.text;
  if (block.type === 'resource_link') return block.uri;
  return '';
}

function stringifyToolValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => stringifyToolValue(item)).filter(Boolean).join(' ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['summary', 'stdout', 'stderr', 'output', 'content', 'text', 'message']) {
      const nested = stringifyToolValue(record[key]);
      if (nested) return nested;
    }
  }
  return '';
}

function boundedOutputLines(value: string, maxLines: number): string {
  const lines = value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)
    .map((line) => truncateInline(line, 140));
  return lines.join('\n');
}

function truncateInline(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function abbreviatePath(path: string): string {
  const home = getHomeLikePrefix();
  const p = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `${p.startsWith('~') ? '~/' : '/'}.../${parts.slice(-2).join('/')}`;
}

function getHomeLikePrefix(): string | null {
  const match = location.pathname.match(/^\/Users\/[^/]+/);
  return match ? match[0] : null;
}

function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function formatShortTime(epochMs: number): string {
  const age = Date.now() - epochMs;
  if (age >= 0 && age < 24 * 60 * 60 * 1000) return `${formatAge(age)} ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 8);
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
