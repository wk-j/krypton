// Krypton — ACP Harness View.
// Coordinates several independent ACP subprocesses for one project directory.

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { AcpClient } from './client';
import type {
  AcpBackendDescriptor,
  AcpEvent,
  AcpMcpServerDescriptor,
  AgentInfo,
  ContentBlock,
  HarnessMcpLaneStats,
  HarnessMemoryEntry,
  HarnessMemorySession,
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  UsageInfo,
} from './types';
import type { CapturedImage, ContentView, PaneContentType } from '../types';
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
  kind: 'system' | 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'permission' | 'restart' | 'memory' | 'shell';
  text: string;
  status?: string;
  diff?: { title: string; unified: string };
  tool?: ToolPayload;
}

interface ToolPayload {
  glyph: string;
  status: string;
  kind: string;
  subject: string;
  result: string;
  sections: Array<{ label: string; text: string }>;
}

interface StagedImage {
  data: string;
  mimeType: string;
  path: string | null;
}

const MAX_STAGED_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MEMORY_PERMISSION_SCAN_DEPTH = 8;
const HARNESS_MEMORY_TOOL_NAMES = new Set(['memory_set', 'memory_get', 'memory_list']);

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
  spawnEpoch: number;
  usage: UsageInfo | null;
  sessionId: string | null;
  modelName: string | null;
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
  pendingShellId: string | null;
  stagedImages: StagedImage[];
  supportsImages: boolean;
  activeTurnStartedAt: number | null;
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
  { backendId: 'opencode', displayName: 'OpenCode', count: 1 },
];

const OPENCODE_DEFAULT_MODEL = 'zai-coding-plan/glm-5.1';
const FILE_TOUCH_WINDOW_MS = 10 * 60 * 1000;

// Immutable defaults shared across all lanes. Mutable containers (arrays,
// Maps, Sets) MUST NOT live here — createLane() instantiates fresh ones
// per lane to prevent reference aliasing.
const LANE_DEFAULTS = {
  client: null,
  status: 'starting' as const,
  draft: '',
  cursor: 0,
  spawnEpoch: 0,
  usage: null,
  sessionId: null,
  modelName: null,
  supportsEmbeddedContext: false,
  error: null,
  acceptAllForTurn: false,
  rejectAllForTurn: false,
  currentAssistantId: null,
  currentThoughtId: null,
  stickToBottom: true,
  pendingShellId: null,
  supportsImages: false,
  activeTurnStartedAt: null,
};

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
  private gitBranch: string | null = null;
  private gitBranchLoading = false;
  private gitBranchProjectDir: string | null = null;
  private memoryUnlisten: UnlistenFn | null = null;
  private mcpStatsByLane = new Map<string, HarnessMcpLaneStats>();
  private mcpUnlisten: UnlistenFn | null = null;
  private fileTouchMap = new Map<string, FileTouchRecord>();
  private memoryDrawerOpen = false;
  private helpOpen = false;
  private zenMode = false;
  private memoryCursorRowId: string | null = null;
  private focus: ComposerFocus = 'text';
  private chip: string | null = null;
  private chipTimer: number | null = null;
  private composerTickTimer: number | null = null;
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
    this.zenMode = readZenModePreference(projectDir);
    this.element = document.createElement('div');
    this.element.className = 'acp-harness';
    this.element.tabIndex = 0;
    this.buildDOM();
    this.render();
    void this.refreshGitBranch();
    void this.start();
  }

  getWorkingDirectory(): string | null {
    return this.projectDir;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === '.' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.toggleZenMode();
      return true;
    }
    if ((e.key === 'n' || e.key === 'N' || e.key === 'p' || e.key === 'P') && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.activateLaneByDelta(e.key === 'n' || e.key === 'N' ? 1 : -1);
      return true;
    }
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
      else if (lane.stagedImages.length > 0) this.clearStagedImages(lane);
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
      if (lane.pendingShellId) void this.cancelShell(lane);
      else if (lane.status === 'busy' || lane.status === 'needs_permission') void this.cancelLane(lane);
      else this.setDraft(lane, '', 0);
      return true;
    }

    if ((e.key === 'm' || e.key === 'M') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.toggleMemoryDrawer(!this.memoryDrawerOpen);
      return true;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      this.activateLaneByDelta(e.shiftKey ? -1 : 1);
      return true;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.submitActiveLane().catch((error: unknown) => this.handleSubmitError(error));
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
    this.stopComposerTick();
    for (const lane of this.lanes) {
      if (lane.client) void lane.client.dispose();
      lane.client = null;
    }
    if (this.memoryUnlisten) {
      this.memoryUnlisten();
      this.memoryUnlisten = null;
    }
    if (this.mcpUnlisten) {
      this.mcpUnlisten();
      this.mcpUnlisten = null;
    }
    if (this.harnessMemoryId) {
      void invoke('dispose_harness_memory', { harnessId: this.harnessMemoryId });
    }
  }

  stageCapturedImage(image: CapturedImage): boolean {
    const lane = this.activeLane();
    if (!lane) return false;
    if (this.helpOpen || this.memoryDrawerOpen) {
      this.flashChip('close overlay to stage capture');
      return true;
    }
    if (lane.pendingPermissions.length > 0) {
      this.flashChip('resolve permission before staging capture');
      return true;
    }
    const staged = this.stageImageData(lane, image.data, image.mimeType, image.path);
    if (staged) this.flashChip('screen capture staged');
    return true;
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
    this.memoryPanelEl.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLElement>('[data-memory-lane]');
      if (!row) return;
      const lane = row.dataset.memoryLane;
      if (!lane) return;
      this.memoryCursorRowId = lane;
      this.renderMemory();
    });
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
    this.composerEl.addEventListener('click', (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLButtonElement>('[data-remove-staged-image]');
      if (!button) return;
      const lane = this.activeLane();
      if (!lane) return;
      const index = Number(button.dataset.removeStagedImage);
      if (!Number.isInteger(index)) return;
      e.preventDefault();
      this.removeStagedImage(lane, index);
    });
    commandCenter.appendChild(this.composerEl);
    this.element.appendChild(commandCenter);

    this.element.addEventListener('paste', (e: ClipboardEvent) => {
      if (this.helpOpen || this.memoryDrawerOpen) return;
      const lane = this.activeLane();
      if (!lane || lane.pendingPermissions.length > 0) return;
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) this.stageImageFile(lane, file);
            return;
          }
        }
      }
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      e.preventDefault();
      this.insertDraft(lane, text);
    });

    this.element.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const hasFile = Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file');
      if (!hasFile) return;
      e.preventDefault();
      this.element.classList.add('acp-harness--drag-over');
    });
    this.element.addEventListener('dragleave', (e: DragEvent) => {
      if (e.target === this.element) this.element.classList.remove('acp-harness--drag-over');
    });
    this.element.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.element.classList.remove('acp-harness--drag-over');
      const lane = this.activeLane();
      if (!lane || lane.pendingPermissions.length > 0) return;
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          this.stageImageFile(lane, file);
          break;
        }
      }
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
    const projectDir = this.projectDir || await invoke<string>('get_app_cwd').catch(() => null);
    const session = await invoke<HarnessMemorySession>('create_harness_memory', { projectDir });
    this.harnessMemoryId = session.harnessId;
    this.harnessMemoryPort = session.hookPort;
    this.memoryUnlisten = await listen<{ harnessId: string }>('acp-harness-memory-changed', (event) => {
      if (event.payload.harnessId === this.harnessMemoryId) void this.refreshMemory();
    });
    this.mcpUnlisten = await listen<{ harnessId: string; laneLabel: string }>('acp-harness-mcp-touched', (event) => {
      if (event.payload.harnessId === this.harnessMemoryId) void this.refreshMcpStats();
    });
    await this.refreshMemory();
    await this.refreshMcpStats();
  }

  private async refreshGitBranch(): Promise<void> {
    const cwd = this.projectDir;
    this.gitBranch = null;
    this.gitBranchProjectDir = cwd;
    this.gitBranchLoading = Boolean(cwd);
    this.render();
    if (!cwd) {
      this.gitBranchLoading = false;
      return;
    }

    let branch: string | null = null;
    try {
      const rawBranch = await invoke<string>('run_command', {
        program: 'git',
        args: ['branch', '--show-current'],
        cwd,
      });
      branch = rawBranch.trim() || null;
      if (!branch) {
        const rawHead = await invoke<string>('run_command', {
          program: 'git',
          args: ['rev-parse', '--short', 'HEAD'],
          cwd,
        });
        const head = rawHead.trim();
        if (head) branch = `HEAD ${head}`;
      }
    } catch {
      branch = null;
    }

    if (this.gitBranchProjectDir !== cwd) return;
    this.gitBranch = branch;
    this.gitBranchLoading = false;
    this.render();
  }

  private async refreshMcpStats(): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      const stats = await invoke<HarnessMcpLaneStats[]>('list_harness_mcp_stats', {
        harnessId: this.harnessMemoryId,
      });
      this.mcpStatsByLane.clear();
      for (const entry of stats) this.mcpStatsByLane.set(entry.laneLabel, entry);
      this.render();
    } catch {
      // ignore — stats are diagnostic only
    }
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
      ...LANE_DEFAULTS,
      id: `${backendId}-${index}`,
      index,
      backendId,
      displayName,
      accent: laneAccent(index),
      // Per-lane mutable containers — each lane needs fresh instances:
      pendingPermissions: [],
      pendingTurnExtractions: [],
      stagedImages: [],
      transcript: [{ id: makeId(), kind: 'system', text: `starting ${displayName}...` }],
      toolTranscriptIds: new Map(),
      toolCalls: new Map(),
      seenTranscriptIds: new Set(),
    };
  }

  private async spawnLane(lane: HarnessLane): Promise<void> {
    const spawnEpoch = lane.spawnEpoch;
    lane.status = 'starting';
    lane.error = null;
    this.render();
    let client: AcpClient | null = null;
    try {
      client = await AcpClient.spawn(lane.backendId, this.projectDir, this.memoryServerForLane(lane));
      if (lane.spawnEpoch !== spawnEpoch) {
        await client.dispose();
        return;
      }
      lane.client = client;
      client.onEvent((event) => {
        if (lane.spawnEpoch !== spawnEpoch || lane.client !== client) return;
        this.onLaneEvent(lane, event);
      });
      const info: AgentInfo = await client.initialize();
      if (lane.spawnEpoch !== spawnEpoch || lane.client !== client) {
        await client.dispose();
        return;
      }
      lane.sessionId = info.session_id ?? null;
      lane.modelName = inferLaneModelName(lane.backendId, info);
      lane.supportsEmbeddedContext = !!info.agent_capabilities?.promptCapabilities?.embeddedContext;
      lane.supportsImages = !!info.agent_capabilities?.promptCapabilities?.image;
      lane.status = 'idle';
      this.appendTranscript(lane, 'system', `connected to ${lane.displayName}.`);
    } catch (e) {
      if (lane.spawnEpoch !== spawnEpoch) {
        if (client) await client.dispose();
        return;
      }
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
        lane.activeTurnStartedAt = null;
        lane.pendingTurnExtractions = [];
        this.updateComposerTick();
        this.appendTranscript(lane, 'system', `error: ${event.message}`);
        break;
    }
    this.render();
  }

  private async submitActiveLane(): Promise<void> {
    const lane = this.activeLane();
    if (!lane) return;
    const text = lane.draft.trim();
    const hasImages = lane.stagedImages.length > 0;
    if (!text && !hasImages) return;
    if (text.startsWith('#')) {
      await this.runHashCommand(lane, text);
      return;
    }
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      this.setDraft(lane, '', 0);
      this.render();
      if (!command) {
        this.flashChip('empty shell command');
        return;
      }
      await this.runShellCommand(lane, command);
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
    const images = lane.stagedImages.slice();
    this.setDraft(lane, '', 0);
    lane.stagedImages = [];
    const transcriptText = text || (images.length > 0 ? `[${images.length} image${images.length === 1 ? '' : 's'}]` : '');
    this.appendTranscript(lane, 'user', transcriptText);
    lane.status = 'busy';
    lane.activeTurnStartedAt = Date.now();
    lane.pendingTurnExtractions = [];
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    const blocks = this.buildPromptBlocks(lane, text, images);
    this.updateComposerTick();
    this.render();
    try {
      await lane.client.prompt(blocks);
    } catch (e) {
      lane.status = 'error';
      lane.error = String(e);
      lane.activeTurnStartedAt = null;
      lane.pendingTurnExtractions = [];
      this.updateComposerTick();
      this.appendTranscript(lane, 'system', `prompt failed: ${String(e)}`);
      this.render();
    }
  }

  private handleSubmitError(error: unknown): void {
    const message = errorText(error);
    const lane = this.activeLane();
    console.warn('[AcpHarnessView] submit failed:', error);
    if (lane?.status === 'starting') {
      lane.status = 'error';
      lane.error = message;
      this.appendTranscript(lane, 'system', `command failed: ${message}`);
    }
    this.flashChip(message);
    this.render();
  }

  private buildPromptBlocks(lane: HarnessLane, userText: string, images: StagedImage[] = []): ContentBlock[] {
    const imageBlocks: ContentBlock[] = images.map((img) => ({
      type: 'image',
      data: img.data,
      mimeType: img.mimeType,
      ...(img.path ? { uri: pathToFileUri(img.path) } : {}),
    }));
    const userBlocks: ContentBlock[] = [];
    if (userText) userBlocks.push({ type: 'text', text: userText });
    const tail = [...imageBlocks, ...userBlocks];
    const packet = this.renderPromptMemoryPacket(lane);
    if (!packet) return tail;
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
        ...tail,
      ];
    }
    return [
      { type: 'text', text: packet },
      ...tail,
    ];
  }

  private renderPromptMemoryPacket(lane: HarnessLane): string {
    const self = lane.displayName;
    const roster = this.lanes.map((l) => l.displayName).join(', ');
    const lines: string[] = [
      `You are lane ${self}. Lanes: ${roster}.`,
      'You can write only your own memory (memory_set); you can read any lane (memory_get / memory_list).',
      '',
    ];
    for (const laneInfo of this.lanes) {
      const name = laneInfo.displayName;
      const entry = this.memoryEntries.find((m) => m.lane === name);
      const tag = name === self ? '(you, read/write)' : '(read-only)';
      lines.push(`## ${name} ${tag}`);
      if (!entry || (!entry.summary && !entry.detail)) {
        lines.push('empty');
      } else {
        if (entry.summary) lines.push(entry.summary);
        if (entry.detail) {
          lines.push('');
          lines.push(entry.detail);
        }
      }
      lines.push('');
    }
    return lines.join('\n').trimEnd();
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
    lane.activeTurnStartedAt = null;
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    this.updateComposerTick();
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
    const memoryToolName = harnessMemoryPermissionToolName(permission);
    if (memoryToolName && pickPermissionOption(permission.options, 'accept')) {
      void this.resolveMemoryPermission(lane, permission, memoryToolName);
      return;
    }
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
    permission.resolvedLabel = `${action === 'accept' ? '✓' : '✗'} ${label}${auto ? ' (auto-turn)' : ''}`;
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

  private async resolveMemoryPermission(lane: HarnessLane, permission: HarnessPermission, toolName: string): Promise<void> {
    if (!lane.client) return;
    const option = pickPermissionOption(permission.options, 'accept');
    if (!option) return;
    try {
      await lane.client.respondPermission(permission.requestId, option.optionId);
      this.appendTranscript(lane, 'permission', `✓ ${toolName} (memory auto-allow)`);
    } catch (e) {
      this.appendTranscript(lane, 'system', `permission reply failed: ${String(e)}`);
    }
    this.render();
  }

  private describePermission(lane: HarnessLane, permission: HarnessPermission): string {
    const call = permission.toolCall;
    const path = extractModifiedPath(call) ?? call.locations?.[0]?.path ?? call.title ?? 'unknown target';
    const op = call.kind ?? 'tool';
    let line = `${op} ${path}`;
    const touch = this.fileTouchMap.get(path);
    if (touch && touch.laneId !== lane.id && Date.now() - touch.at <= FILE_TOUCH_WINDOW_MS) {
      line += ` · also ${touch.laneDisplayName} ${formatAge(Date.now() - touch.at)} ago`;
    }
    return line;
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

  private async newLaneSession(lane: HarnessLane, options: { clearMemory: boolean }): Promise<void> {
    if (lane.status === 'busy' || lane.status === 'needs_permission') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    if (lane.status === 'starting') {
      this.flashChip('lane starting');
      return;
    }
    if (options.clearMemory && !this.harnessMemoryId) {
      this.flashChip('memory unavailable - use #new');
      return;
    }
    if (options.clearMemory) {
      try {
        await this.clearActiveLaneMemory(lane, false);
      } catch (e) {
        this.flashChip(`memory clear failed: ${errorText(e)}`);
        return;
      }
    }
    if (lane.pendingShellId) await this.cancelShell(lane);
    lane.spawnEpoch += 1;
    if (lane.client) {
      await lane.client.dispose();
      lane.client = null;
    }
    lane.status = 'starting';
    lane.draft = '';
    lane.cursor = 0;
    lane.pendingPermissions = [];
    lane.pendingTurnExtractions = [];
    lane.stagedImages = [];
    lane.transcript = [{ id: makeId(), kind: 'system', text: `starting fresh ${lane.displayName}...` }];
    lane.usage = null;
    lane.sessionId = null;
    lane.modelName = null;
    lane.supportsEmbeddedContext = false;
    lane.supportsImages = false;
    lane.error = null;
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    lane.toolTranscriptIds = new Map();
    lane.toolCalls = new Map();
    lane.seenTranscriptIds = new Set();
    lane.stickToBottom = true;
    lane.pendingShellId = null;
    lane.activeTurnStartedAt = null;
    this.updateComposerTick();
    this.render();
    await this.spawnLane(lane);
  }

  private async clearActiveLaneMemory(lane: HarnessLane, showSuccess = true): Promise<void> {
    if (!this.harnessMemoryId) {
      throw new Error('memory unavailable');
    }
    await invoke('clear_harness_memory_lane', {
      harnessId: this.harnessMemoryId,
      lane: lane.displayName,
    });
    await this.refreshMemory();
    await this.refreshMcpStats();
    if (showSuccess) this.flashChip(`memory cleared for ${lane.displayName}`);
  }

  private async runHashCommand(lane: HarnessLane, text: string): Promise<void> {
    const parts = text.trim().split(/\s+/);
    if (parts[0] === '#new') {
      this.setDraft(lane, '', 0);
      await this.newLaneSession(lane, { clearMemory: false });
      return;
    }
    if (parts[0] === '#new!') {
      this.setDraft(lane, '', 0);
      await this.newLaneSession(lane, { clearMemory: true });
      return;
    }
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
      this.setDraft(lane, '', 0);
      if (parts[1] === 'clear') {
        try {
          await this.clearActiveLaneMemory(lane);
        } catch (e) {
          this.flashChip(errorText(e));
        }
        this.render();
        return;
      }
      this.flashChip('memory commands: #mem clear, #mcp, Ctrl+M drawer');
      return;
    }
    if (parts[0] === '#mcp') {
      this.setDraft(lane, '', 0);
      await this.printMcpStatus(lane);
      this.render();
      return;
    }
    this.flashChip('unknown command');
  }

  private async printMcpStatus(lane: HarnessLane): Promise<void> {
    await this.refreshMcpStats();
    const lines: string[] = [];
    if (!this.harnessMemoryId || !this.harnessMemoryPort) {
      lines.push('mcp: harness memory not initialized');
    } else {
      lines.push(`mcp endpoint: http://127.0.0.1:${this.harnessMemoryPort}/mcp/harness/${this.harnessMemoryId}/lane/<laneLabel>`);
      lines.push('');
      lines.push('lane                  init  list  call  last');
      for (const l of this.lanes) {
        const s = this.mcpStatsByLane.get(l.displayName);
        const init = s?.initializeCount ?? 0;
        const list = s?.toolsListCount ?? 0;
        const call = s?.toolsCallCount ?? 0;
        const last = s?.lastSeenAt ? formatShortTime(s.lastSeenAt) : '—';
        const flag = list > 0 ? '✓' : '—';
        lines.push(
          `${flag} ${l.displayName.padEnd(20).slice(0, 20)} ${String(init).padStart(4)}  ${String(list).padStart(4)}  ${String(call).padStart(4)}  ${last}`,
        );
      }
      lines.push('');
      lines.push('✓ = adapter listed tools at least once. — = adapter never queried this lane.');
    }
    this.appendTranscript(lane, 'system', lines.join('\n'));
  }

  private async runShellCommand(lane: HarnessLane, command: string): Promise<void> {
    if (lane.pendingShellId) {
      this.flashChip('shell already running');
      return;
    }
    const id = makeId();
    const item = this.appendTranscript(lane, 'shell', `$ ${command}\n…`);
    item.status = 'pending';
    lane.pendingShellId = id;
    this.render();
    let output: string;
    let status: 'completed' | 'failed';
    try {
      const result = await invoke<string>('run_shell', {
        id,
        command,
        cwd: this.projectDir,
      });
      output = result;
      status = 'completed';
    } catch (e) {
      output = String(e);
      status = 'failed';
    }
    if (lane.pendingShellId === id) lane.pendingShellId = null;
    const trimmed = output.replace(/\s+$/, '');
    item.text = trimmed ? `$ ${command}\n${trimmed}` : `$ ${command}`;
    item.status = status;
    this.render();
  }

  private async cancelShell(lane: HarnessLane): Promise<void> {
    const id = lane.pendingShellId;
    if (!id) return;
    try {
      await invoke('kill_shell', { id });
    } catch (e) {
      this.appendTranscript(lane, 'system', `kill_shell failed: ${String(e)}`);
      this.render();
    }
  }

  private render(): void {
    this.element.classList.toggle('acp-harness--transcript-focus', this.focus === 'transcript');
    this.element.classList.toggle('acp-harness--zen', this.zenMode);
    this.element.classList.toggle('acp-harness--memory-open', this.memoryDrawerOpen);
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

    let railEl: HTMLElement | null = null;
    let bodyCell: HTMLElement | null = null;
    if (this.zenMode) {
      railEl = document.createElement('aside');
      railEl.className = 'acp-harness__rail';
      bodyCell = document.createElement('div');
      bodyCell.className = 'acp-harness__body-cell';
      this.dashboardEl.appendChild(railEl);
      this.dashboardEl.appendChild(bodyCell);
      for (const lane of this.lanes) {
        const active = lane.id === this.activeLaneId;
        railEl.appendChild(this.renderRailEntry(lane, active));
      }
    }

    for (const lane of this.lanes) {
      const active = lane.id === this.activeLaneId;
      if (this.zenMode && !active) continue;
      const laneEl = document.createElement(active ? 'section' : 'div');
      laneEl.className = `acp-harness__lane ${active ? 'acp-harness__lane--active' : 'acp-harness__lane--collapsed'} acp-harness__lane--${lane.status}`;
      laneEl.style.setProperty('--acp-lane-accent', active ? lane.accent : 'rgba(216, 232, 216, 0.42)');
      const head = document.createElement('header');
      head.className = 'acp-harness__lane-head';
      head.innerHTML = renderLaneHead(lane, active, this.mcpStatsByLane.get(lane.displayName) ?? null);
      laneEl.appendChild(head);
      if (active) {
        const stats = document.createElement('div');
        stats.className = 'acp-harness__lane-stats';
        stats.innerHTML = renderLaneStats(lane, this.projectDir);
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
      (bodyCell ?? this.dashboardEl).appendChild(laneEl);
    }
    this.schedulePretextLayout();
  }

  private renderRailEntry(lane: HarnessLane, active: boolean): HTMLElement {
    const entry = document.createElement('div');
    entry.className =
      `acp-harness__rail-entry acp-harness__rail-entry--${lane.status}` +
      (active ? ' acp-harness__rail-entry--active' : '');
    entry.style.setProperty('--acp-lane-accent', lane.accent);
    const toolCount = lane.toolCalls.size;
    const ctxUsed = typeof lane.usage?.used === 'number' ? lane.usage!.used : null;
    const toolHtml = toolCount > 0
      ? `<span class="acp-harness__rail-metric acp-harness__rail-metric--tools" title="${esc(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`)}">${esc(formatCount(toolCount))}</span>`
      : '';
    const ctxHtml = ctxUsed !== null
      ? `<span class="acp-harness__rail-metric acp-harness__rail-metric--ctx" title="${esc(typeof lane.usage?.size === 'number' && lane.usage!.size! > 0 ? `context ${ctxUsed}/${lane.usage!.size} tokens` : `context ${ctxUsed} tokens`)}">${esc(formatCount(ctxUsed))}</span>`
      : '';
    entry.innerHTML =
      `<span class="acp-harness__rail-dot"></span>` +
      `<span class="acp-harness__rail-name">${esc(lane.displayName)}</span>` +
      toolHtml +
      ctxHtml;
    return entry;
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
    if (!this.memoryCursorRowId || !rows.some((entry) => entry.lane === this.memoryCursorRowId)) {
      this.memoryCursorRowId = rows[0]?.lane ?? null;
    }
    for (const entry of rows) {
      const row = document.createElement('div');
      const selected = entry.lane === this.memoryCursorRowId;
      row.className = `acp-harness__memory-row${selected ? ' acp-harness__memory-row--cursor' : ''}`;
      row.dataset.memoryLane = entry.lane;
      row.innerHTML =
        `<span class="acp-harness__memory-source" style="--acp-memory-accent:${esc(laneAccentForLabel(entry.lane))}">${esc(entry.lane)}</span>` +
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
    this.composerEl.className =
      `acp-harness__composer${this.focus === 'transcript' ? ' acp-harness__composer--command' : ''}` +
      `${this.memoryDrawerOpen ? ' acp-harness__composer--memory' : ''}`;
    const chip = this.chip ?? this.composerStatusChip(lane);
    const chipClass = `acp-harness__memory-chip${!this.chip && lane.status === 'busy' ? ' acp-harness__memory-chip--running' : ''}`;
    const projectStatus = this.renderComposerProjectStatus();
    const before = lane.draft.slice(0, lane.cursor);
    const after = lane.draft.slice(lane.cursor);
    this.composerEl.style.setProperty('--acp-lane-accent', lane.accent);
    let staging = '';
    if (lane.stagedImages.length > 0) {
      const chips = lane.stagedImages
        .map((img, index) => {
          const label = img.path ? basename(img.path) : img.mimeType;
          return (
            `<div class="acp-harness__staged-image">` +
            `<img class="acp-harness__staged-thumb" src="data:${img.mimeType};base64,${img.data}" alt="" />` +
            `<span class="acp-harness__staged-label">${esc(label)}</span>` +
            `<button class="acp-harness__staged-remove" type="button" data-remove-staged-image="${index}" title="Remove image">x</button>` +
            `</div>`
          );
        })
        .join('');
      const hint = `${lane.stagedImages.length} image${lane.stagedImages.length === 1 ? '' : 's'} · Esc to clear`;
      staging = `<div class="acp-harness__staging">${chips}<span class="acp-harness__staging-hint">${esc(hint)}</span></div>`;
    }
    this.composerEl.innerHTML =
      `<div class="acp-harness__composer-meta">` +
      `<span class="${chipClass}">${esc(chip)}</span>` +
      projectStatus +
      `</div>` +
      staging +
      `<div class="acp-harness__input-line">` +
      `<span class="acp-harness__lane-tag">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__prompt">›</span>` +
      `<span class="acp-harness__input">${esc(before)}<span class="acp-harness__caret">█</span>${esc(after)}</span>` +
      `<span class="acp-harness__help-hint">? help</span></div>`;
  }

  private composerStatusChip(lane: HarnessLane): string {
    if (this.focus === 'transcript') return 'command mode: 1-9 lanes · ^M memory · ? help · i/Esc input';
    if (lane.status === 'busy') {
      const elapsed = lane.activeTurnStartedAt ? ` · ${formatElapsed(Date.now() - lane.activeTurnStartedAt)}` : '';
      return `${lane.displayName} running${elapsed} · Ctrl+C cancel`;
    }
    return `memory: ${Math.min(this.memoryEntries.length, 10)}/${this.memoryEntries.length}`;
  }

  private updateComposerTick(): void {
    const shouldTick = this.lanes.some((lane) => lane.status === 'busy' && lane.activeTurnStartedAt !== null);
    if (shouldTick && this.composerTickTimer === null) {
      this.composerTickTimer = window.setInterval(() => this.renderComposer(), 1000);
    } else if (!shouldTick) {
      this.stopComposerTick();
    }
  }

  private stopComposerTick(): void {
    if (this.composerTickTimer === null) return;
    window.clearInterval(this.composerTickTimer);
    this.composerTickTimer = null;
  }

  private renderComposerProjectStatus(): string {
    const cwd = this.projectDir ? abbreviatePath(this.projectDir) : 'no cwd';
    const branch = this.gitBranchLoading ? '...' : this.gitBranch;
    const branchText = branch ? ` on ${branch}` : '';
    const title = this.projectDir ? `${this.projectDir}${this.gitBranch ? ` on ${this.gitBranch}` : ''}` : '';
    return `<span class="acp-harness__project-status" title="${esc(title)}">${esc(cwd)}${esc(branchText)}</span>`;
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
            <dt>Ctrl+N / Ctrl+P</dt><dd>Next / previous lane (zen + dashboard)</dd>
            <dt>Esc, then 1-9</dt><dd>Switch lane in transcript mode</dd>
            <dt>Esc, then ?</dt><dd>Open help</dd>
            <dt>Tab buttons</dt><dd>Click a lane directly</dd>
            <dt>Enter</dt><dd>Send prompt to active lane only</dd>
            <dt>Shift+Enter</dt><dd>Insert newline</dd>
            <dt>Ctrl+C</dt><dd>Cancel active busy lane</dd>
            <dt>Cmd+.</dt><dd>Toggle Zen Mode</dd>
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
            <dt>Ctrl+M</dt><dd>Toggle memory drawer</dd>
            <dt>q / Esc</dt><dd>Close memory drawer</dd>
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
            <dt>#new</dt><dd>Start fresh active lane, keep memory</dd>
            <dt>#new!</dt><dd>Start fresh active lane and clear its memory</dd>
            <dt>#restart</dt><dd>Respawn active lane when error or stopped</dd>
            <dt>#mem</dt><dd>Show memory command hint</dd>
            <dt>#mem clear</dt><dd>Clear active lane memory only</dd>
            <dt>#mcp</dt><dd>Show MCP endpoint and lane status</dd>
            <dt>!cmd</dt><dd>Run shell command in project cwd, output goes to transcript</dd>
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
    const tool = buildToolPayload(merged, status);
    const text = tool.subject ? `${tool.glyph} ${tool.kind} ${tool.subject}` : `${tool.glyph} ${tool.kind}`;
    const existingId = lane.toolTranscriptIds.get(merged.toolCallId);
    const existing = existingId ? lane.transcript.find((item) => item.id === existingId) : null;
    if (existing) {
      existing.text = text;
      existing.status = status;
      existing.tool = tool;
      return;
    }
    const item = this.appendTranscript(lane, 'tool', text);
    item.status = status;
    item.tool = tool;
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
    if (e.key === 'Escape') {
      e.preventDefault();
      this.toggleMemoryDrawer(false);
      return true;
    }
    if ((e.key === 'm' || e.key === 'M') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.toggleMemoryDrawer(false);
      return true;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggleHelp(true);
      return true;
    }
    if (this.isMemoryCursorKey(e)) {
      e.preventDefault();
      this.moveMemoryCursor(e.key);
      return true;
    }
    e.preventDefault();
    return true;
  }

  private isMemoryCursorKey(e: KeyboardEvent): boolean {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
      return true;
    }
    return e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'n' || e.key === 'p');
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

  private stageImageFile(lane: HarnessLane, file: File): void {
    const reader = new FileReader();
    reader.onload = (): void => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      void this.stageImageDataFromFile(lane, base64, file.type);
    };
    reader.readAsDataURL(file);
  }

  private async stageImageDataFromFile(lane: HarnessLane, data: string, mimeType: string): Promise<void> {
    if (lane.stagedImages.length >= MAX_STAGED_IMAGES) {
      this.flashChip(`max ${MAX_STAGED_IMAGES} images per message`);
      return;
    }
    if (data.length > MAX_IMAGE_BYTES * 1.34) {
      this.flashChip('image too large (max 5MB)');
      return;
    }
    try {
      const path = await invoke<string>('save_temp_image', { data, mimeType });
      this.stageImageData(lane, data, mimeType, path);
    } catch (e) {
      this.flashChip(`image save failed: ${String(e)}`);
    }
  }

  private canStageImage(lane: HarnessLane, data: string): boolean {
    if (lane.stagedImages.length >= MAX_STAGED_IMAGES) {
      this.flashChip(`max ${MAX_STAGED_IMAGES} images per message`);
      return false;
    }
    if (!lane.supportsImages) {
      this.flashChip(`${lane.displayName} did not advertise image support; sending anyway`);
    }
    if (data.length > MAX_IMAGE_BYTES * 1.34) {
      this.flashChip('image too large (max 5MB)');
      return false;
    }
    return true;
  }

  private stageImageData(lane: HarnessLane, data: string, mimeType: string, path: string | null): boolean {
    if (!this.canStageImage(lane, data)) return false;
    lane.stagedImages.push({ data, mimeType, path });
    this.renderComposer();
    return true;
  }

  private clearStagedImages(lane: HarnessLane): void {
    if (lane.stagedImages.length === 0) return;
    lane.stagedImages = [];
    this.renderComposer();
  }

  private removeStagedImage(lane: HarnessLane, index: number): void {
    if (index < 0 || index >= lane.stagedImages.length) return;
    lane.stagedImages.splice(index, 1);
    this.renderComposer();
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

  private toggleZenMode(): void {
    this.zenMode = !this.zenMode;
    writeZenModePreference(this.projectDir, this.zenMode);
    this.render();
  }

  private sortedMemoryRows(): HarnessMemoryEntry[] {
    return this.memoryEntries.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private moveMemoryCursor(key: string): void {
    const rows = this.sortedMemoryRows();
    if (rows.length === 0) return;
    const current = rows.findIndex((entry) => entry.lane === this.memoryCursorRowId);
    let next = current < 0 ? 0 : current;
    if (key === 'n' || key === 'ArrowDown' || key === 'PageDown') next = Math.min(rows.length - 1, next + 1);
    else if (key === 'p' || key === 'ArrowUp' || key === 'PageUp') next = Math.max(0, next - 1);
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = rows.length - 1;
    this.memoryCursorRowId = rows[next].lane;
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

function zenModeStorageKey(projectDir: string | null): string {
  return `krypton:acp-harness:zen:${projectDir ?? ''}`;
}

function readZenModePreference(projectDir: string | null): boolean {
  try {
    return localStorage.getItem(zenModeStorageKey(projectDir)) === '1';
  } catch {
    return false;
  }
}

function writeZenModePreference(projectDir: string | null, value: boolean): void {
  try {
    if (value) localStorage.setItem(zenModeStorageKey(projectDir), '1');
    else localStorage.removeItem(zenModeStorageKey(projectDir));
  } catch {
    // localStorage unavailable — preference simply won't persist
  }
}

function pickPermissionOption(options: PermissionOption[], action: 'accept' | 'reject'): PermissionOption | null {
  if (action === 'accept') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? null;
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? null;
}

function harnessMemoryPermissionToolName(permission: HarnessPermission): string | null {
  const call = permission.toolCall;
  const structuredToolName = structuredMemoryToolNameFromUnknown(call.rawInput);
  if (structuredToolName) return structuredToolName;
  const rawToolName = memoryToolNameFromUnknown(call.rawInput);
  const titleToolName = memoryToolNameFromString(call.title);
  if (rawToolName && containsHarnessMemoryServerMarker(call.rawInput)) return rawToolName;
  if (titleToolName && containsHarnessMemoryServerMarker(call.title)) return titleToolName;
  return null;
}

function structuredMemoryToolNameFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return null;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = structuredMemoryToolNameFromUnknown(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'toolName', 'tool_name', 'tool']) {
    const value = record[key];
    if (typeof value === 'string' && HARNESS_MEMORY_TOOL_NAMES.has(value)) return value;
  }
  for (const item of Object.values(record)) {
    const match = structuredMemoryToolNameFromUnknown(item, depth + 1);
    if (match) return match;
  }
  return null;
}

function memoryToolNameFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return null;
  if (typeof value === 'string') return memoryToolNameFromString(value);
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = memoryToolNameFromUnknown(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'toolName', 'tool_name', 'tool', 'title']) {
    const match = memoryToolNameFromUnknown(record[key], depth + 1);
    if (match) return match;
  }
  return null;
}

function memoryToolNameFromString(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/\b(memory_set|memory_get|memory_list)\b/);
  return match && HARNESS_MEMORY_TOOL_NAMES.has(match[1]) ? match[1] : null;
}

function containsHarnessMemoryServerMarker(value: unknown, depth = 0): boolean {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return false;
  if (typeof value === 'string') return value.includes('krypton-harness-memory') || value.includes('/mcp/harness/');
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsHarnessMemoryServerMarker(item, depth + 1));
  return Object.values(value as Record<string, unknown>).some((item) => containsHarnessMemoryServerMarker(item, depth + 1));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  } else if (item.kind === 'tool' && item.tool) {
    body.classList.add('acp-harness__tool');
    renderToolBody(body, item.tool);
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
  return kind !== 'assistant' && kind !== 'tool';
}

function buildToolPayload(call: ToolCall | ToolCallUpdate, status: string): ToolPayload {
  const kind = inferToolLabel(call);
  const path = extractModifiedPath(call);
  const command = kind === 'execute' ? extractCommandLine(call.rawInput) : '';
  const subject = command || path || cleanToolTitle(call.title, kind) || '';
  const exit = extractToolExit(call.rawOutput);
  const result = exit || (status === 'failed' ? 'failed' : '');
  const raw = rawOutputSections(call.rawOutput);
  const sections = raw.length > 0 ? raw : contentOutputSections(call.content);
  const trimmed = sections
    .map((s) => ({ label: s.label, text: boundedOutputLines(s.text, 6) }))
    .filter((s) => s.text)
    .slice(0, 4);
  return { glyph: statusGlyph(status), status, kind, subject, result, sections: trimmed };
}

function renderToolBody(body: HTMLElement, tool: ToolPayload): void {
  const head = document.createElement('div');
  head.className = 'acp-harness__tool-head';
  const glyph = document.createElement('span');
  glyph.className = `acp-harness__tool-glyph acp-harness__tool-glyph--${tool.status}`;
  glyph.textContent = tool.glyph;
  head.appendChild(glyph);
  const kind = document.createElement('span');
  kind.className = 'acp-harness__tool-kind';
  kind.textContent = tool.kind;
  head.appendChild(kind);
  if (tool.subject) {
    const subject = document.createElement('span');
    subject.className = 'acp-harness__tool-subject';
    subject.textContent = tool.subject;
    head.appendChild(subject);
  }
  if (tool.result) {
    const result = document.createElement('span');
    result.className = `acp-harness__tool-result acp-harness__tool-result--${tool.status}`;
    result.textContent = tool.result;
    head.appendChild(result);
  }
  body.appendChild(head);
  if (tool.sections.length > 0) {
    const output = document.createElement('div');
    output.className = 'acp-harness__tool-output';
    for (const section of tool.sections) {
      const block = document.createElement('div');
      const tone = toolSectionTone(section.label);
      block.className = `acp-harness__tool-section acp-harness__tool-section--${tone}`;
      const label = document.createElement('div');
      label.className = 'acp-harness__tool-section-label';
      label.textContent = section.label;
      const pre = document.createElement('pre');
      pre.className = 'acp-harness__tool-section-text';
      pre.textContent = section.text;
      block.appendChild(label);
      block.appendChild(pre);
      output.appendChild(block);
    }
    body.appendChild(output);
  }
}

function toolSectionTone(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized === 'stderr' || normalized === 'error' || normalized === 'message') return 'error';
  if (normalized === 'stdout' || normalized === 'output' || normalized === 'text') return 'output';
  if (normalized === 'summary') return 'summary';
  if (normalized === 'diff') return 'diff';
  if (normalized === 'terminal') return 'terminal';
  if (normalized === 'content') return 'content';
  return 'default';
}

function inferLaneModelName(backendId: string, info: AgentInfo): string | null {
  const reported = findModelName(info.agent_capabilities);
  if (reported) return reported;
  if (backendId === 'opencode') return OPENCODE_DEFAULT_MODEL;
  return null;
}

function findModelName(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findModelName(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['model', 'modelId', 'model_id', 'selectedModel', 'selected_model', 'activeModel', 'active_model', 'defaultModel', 'default_model']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const item of Object.values(record)) {
    const match = findModelName(item, depth + 1);
    if (match) return match;
  }
  return null;
}

function renderLaneHead(lane: HarnessLane, active: boolean, mcp: HarnessMcpLaneStats | null): string {
  const mcpChip = renderMcpChip(mcp);
  const modelChip = renderModelChip(lane.modelName);
  if (!active) {
    return (
      `<span class="acp-harness__lane-symbol">${statusSymbol(lane.status)}</span>` +
      `<span class="acp-harness__lane-name">${esc(lane.displayName)}</span>` +
      modelChip +
      mcpChip +
      `<span class="acp-harness__lane-activity">${esc(laneActivity(lane))}</span>`
    );
  }
  const cancelHint = lane.status === 'busy' || lane.status === 'needs_permission' || lane.pendingShellId
    ? `<span class="acp-harness__lane-cancel-hint">⌃C cancel</span>`
    : '';
  return (
    `<span class="acp-harness__lane-symbol">${statusSymbol(lane.status)}</span>` +
    `<span class="acp-harness__lane-name">${esc(lane.displayName)}</span>` +
    `<span class="acp-harness__lane-status">${esc(statusLabel(lane.status))}</span>` +
    modelChip +
    mcpChip +
    `<span class="acp-harness__lane-activity">${esc(laneActivity(lane))}</span>` +
    cancelHint
  );
}

function renderModelChip(modelName: string | null): string {
  if (!modelName) return '';
  return `<span class="acp-harness__lane-model" title="model ${esc(modelName)}">${esc(modelName)}</span>`;
}

function renderMcpChip(mcp: HarnessMcpLaneStats | null): string {
  if (!mcp || mcp.toolsListCount === 0) {
    const title = mcp
      ? `MCP descriptor sent; adapter has not called tools/list. init=${mcp.initializeCount}`
      : 'MCP descriptor sent; adapter has not contacted the server.';
    return `<span class="acp-harness__lane-mcp acp-harness__lane-mcp--off" title="${esc(title)}">mcp —</span>`;
  }
  const title = `tools/list ${mcp.toolsListCount} · tools/call ${mcp.toolsCallCount}` +
    (mcp.lastMethod ? ` · last ${mcp.lastMethod}` : '');
  return `<span class="acp-harness__lane-mcp acp-harness__lane-mcp--on" title="${esc(title)}">mcp ✓${mcp.toolsCallCount > 0 ? ` ${mcp.toolsCallCount}` : ''}</span>`;
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
  if (/opencode/i.test(label)) return laneAccent(4);
  const match = label.match(/-(\d+)$/);
  return match ? laneAccent(Number(match[1])) : 'var(--krypton-window-accent, #0cf)';
}

function renderLaneStats(lane: HarnessLane, projectDir: string | null): string {
  const parts: string[] = [];
  parts.push(lane.backendId);
  parts.push(lane.sessionId ? `sess ${shortId(lane.sessionId)}` : 'sess pending');
  if (projectDir) parts.push(basename(projectDir));

  const usage = lane.usage;
  if (usage) {
    if (typeof usage.used === 'number') {
      if (typeof usage.size === 'number' && usage.size > 0) {
        const pct = Math.round((usage.used / usage.size) * 100);
        parts.push(`ctx ${formatCount(usage.used)}/${formatCount(usage.size)} (${pct}%)`);
      } else {
        parts.push(`ctx ${formatCount(usage.used)}`);
      }
    }
    if (typeof usage.cachedReadTokens === 'number' || typeof usage.cachedWriteTokens === 'number') {
      const r = usage.cachedReadTokens ?? 0;
      const w = usage.cachedWriteTokens ?? 0;
      parts.push(`cache ${formatCount(r)}↓ ${formatCount(w)}↑`);
    }
    if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
      parts.push(`in ${formatCount(usage.inputTokens ?? 0)} out ${formatCount(usage.outputTokens ?? 0)}`);
    }
    if (usage.cost) parts.push(`$${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`);
  }

  if (lane.toolCalls.size > 0) parts.push(`${lane.toolCalls.size} tools`);
  parts.push(`${lane.transcript.length} rows`);
  if (lane.pendingPermissions.length > 0) parts.push(`${lane.pendingPermissions.length} perm`);
  if (lane.acceptAllForTurn) parts.push('accept-all');
  if (lane.rejectAllForTurn) parts.push('reject-all');
  if (lane.error) parts.push(`err: ${truncate(lane.error, 48)}`);

  return parts.map((part) => `<span>${esc(part)}</span>`).join('');
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function transcriptLabel(kind: HarnessTranscriptItem['kind']): string {
  switch (kind) {
    case 'system': return 'sys';
    case 'assistant': return 'agent';
    case 'permission': return 'perm';
    case 'memory': return 'mem';
    case 'shell': return 'sh';
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

function extractToolExit(rawOutput: unknown): string {
  if (typeof rawOutput !== 'object' || !rawOutput) return '';
  const record = rawOutput as Record<string, unknown>;
  for (const key of ['exitCode', 'exit_code', 'code']) {
    const value = record[key];
    if (typeof value === 'number') return value === 0 ? '' : `exit ${value}`;
  }
  return '';
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
  const kept = value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
  let minIndent = Infinity;
  for (const line of kept) {
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
    if (minIndent === 0) break;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  return kept
    .map((line) => line.slice(minIndent))
    .map((line) => (line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line))
    .join('\n');
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

function pathToFileUri(path: string): string {
  if (path.startsWith('file://')) return path;
  return `file://${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function getHomeLikePrefix(): string | null {
  const match = location.pathname.match(/^\/Users\/[^/]+/);
  return match ? match[0] : null;
}

function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
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
