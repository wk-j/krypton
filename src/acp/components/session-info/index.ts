// Specs 401–403 — compact, read-only context and identity for the active Harness lane.
// HarnessDock owns the root's hidden state and HarnessLayout places it.

import './session-info.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { keyHintNodes } from '../../../ui/kbd';
import { basename, formatCount } from '../../harness-format';
import { harnessIconEl } from '../../harness-icons';
import { isPollyImplementerBypass } from '../../harness-lane-chrome';
import type { HarnessLane } from '../../harness-view-types';
import type { HarnessLaneStatus, HarnessMcpLaneStats } from '../../types';
import { cacheHitRate, formatCacheHitPercent } from '../../usage-log';
import type { ComponentDef } from '../types';

export interface SessionInfoProps {
  readonly laneName: string;
  readonly sessionId: string | null;
  readonly backendName: string;
  readonly modelName: string | null;
  readonly effortName: string | null;
  readonly status: HarnessLaneStatus;
  readonly contextUsed: number | null;
  readonly contextSize: number | null;
  readonly mcpEndpointAvailable: boolean;
  readonly mcpInitializeCount: number;
  readonly mcpToolsListCount: number;
  readonly mcpToolsCallCount: number;
  readonly mcpLastMethod: string | null;
  readonly mcpLastSeenAt: number | null;
  readonly projectName: string | null;
  readonly cacheHit: string | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly turnInput: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costAmount: number | null;
  readonly costCurrency: string | null;
  readonly toolCalls: number;
  readonly transcriptRows: number;
  readonly pendingPermissions: number;
  readonly pendingQuestions: number;
  readonly turnFlags: string;
  readonly error: string | null;
}

const B = 'acp-session-info';

const STATUS_LABEL: Readonly<Record<HarnessLaneStatus, string>> = {
  starting: 'STARTING',
  idle: 'IDLE',
  busy: 'BUSY',
  needs_permission: 'NEEDS PERMISSION',
  awaiting_peer: 'AWAITING PEER',
  error: 'ERROR',
  stopped: 'STOPPED',
};

/** Snapshot lane and MCP values before their mutable sources change again. */
export function sessionInfoProps(
  lane: HarnessLane,
  projectDir: string | null,
  backendName: string,
  mcpStats: HarnessMcpLaneStats | null,
  mcpEndpointAvailable: boolean,
): SessionInfoProps {
  const usage = lane.usage;
  const tokens = usage ? lane.lastTurnTokens : null;
  const hitRate = tokens ? cacheHitRate(tokens) : null;
  const cache = usage ? (tokens ?? { cachedRead: usage.cachedReadTokens, cachedWrite: usage.cachedWriteTokens }) : null;
  const flags = [
    lane.acceptAllForTurn ? 'accept-all' : null,
    lane.rejectAllForTurn ? 'reject-all' : null,
    lane.peerAutoAcceptForTurn ? 'peer-auto' : null,
    isPollyImplementerBypass(lane) ? 'polly-bypass' : null,
  ].filter((flag): flag is string => flag !== null);
  const effort = lane.effort;
  return {
    laneName: lane.displayName,
    sessionId: lane.sessionId,
    backendName,
    modelName: lane.modelName,
    effortName: effort?.options.find((option) => option.value === effort.current)?.name ?? effort?.current ?? null,
    status: lane.status,
    contextUsed: usage?.used ?? null,
    contextSize: usage?.size ?? null,
    mcpEndpointAvailable,
    mcpInitializeCount: mcpStats?.initializeCount ?? 0,
    mcpToolsListCount: mcpStats?.toolsListCount ?? 0,
    mcpToolsCallCount: mcpStats?.toolsCallCount ?? 0,
    mcpLastMethod: mcpStats?.lastMethod ?? null,
    mcpLastSeenAt: mcpStats && Number.isFinite(mcpStats.lastSeenAt)
      && mcpStats.lastSeenAt > 0 && mcpStats.lastSeenAt <= 8.64e15 ? mcpStats.lastSeenAt : null,
    projectName: projectDir ? basename(projectDir) : null,
    cacheHit: hitRate !== null ? formatCacheHitPercent(hitRate) : null,
    cacheRead: typeof cache?.cachedRead === 'number' ? cache.cachedRead : hitRate !== null ? 0 : null,
    cacheWrite: typeof cache?.cachedWrite === 'number' ? cache.cachedWrite : hitRate !== null ? 0 : null,
    turnInput: hitRate !== null ? tokens?.input ?? 0 : null,
    inputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null,
    outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : null,
    costAmount: usage?.cost?.amount ?? null,
    costCurrency: usage?.cost?.currency ?? null,
    toolCalls: lane.toolViews.size,
    transcriptRows: lane.transcript.length,
    pendingPermissions: lane.pendingPermissions.length,
    pendingQuestions: lane.pendingQuestions.length,
    turnFlags: flags.join(' · '),
    error: lane.error,
  };
}

function validCount(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Occupancy is a level, not the sum of this session's turn counters. */
export function sessionContext(used: number | null, size: number | null): {
  readonly used: number | null;
  readonly size: number | null;
  readonly percent: number | null;
} {
  const safeUsed = validCount(used);
  const safeSize = validCount(size);
  return {
    used: safeUsed,
    size: safeSize !== null && safeSize > 0 ? safeSize : null,
    percent: safeUsed !== null && safeSize !== null && safeSize > 0
      ? Math.min(100, Math.round((safeUsed / safeSize) * 100))
      : null,
  };
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function fact(label: string, fullWidth: boolean = false): { row: HTMLElement; value: HTMLElement } {
  const value = el('dd', { class: B + '__fact-value' });
  const row = el('div', { class: B + '__fact' + (fullWidth ? ' ' + B + '__fact--full' : '') },
    el('dt', { class: B + '__fact-label', text: label }), value);
  return { row, value };
}

function mcpContactLabel(next: SessionInfoProps): string {
  if (!next.mcpEndpointAvailable) return 'Not supplied';
  if (next.mcpToolsListCount > 0) return 'Tools listed on this lane';
  if (next.mcpInitializeCount > 0) return 'Initialized; tools not listed';
  if (next.mcpToolsCallCount > 0 || next.mcpLastMethod !== null || next.mcpLastSeenAt !== null) {
    return 'Contact observed; tools not listed';
  }
  return 'No contact observed';
}

export class SessionInfo extends Component<SessionInfoProps> {
  private readonly laneEl = el('span', { class: B + '__lane' });
  private readonly statusEl = el('span', { class: B + '__status' });
  private readonly percentEl = el('strong', { class: B + '__percent' });
  private readonly countEl = el('span', { class: B + '__count' });
  private readonly meterEl = el('div', { class: B + '__meter', attrs: { role: 'progressbar', 'aria-label': 'Context used' } });
  private readonly fillEl = el('div', { class: B + '__meter-fill' });
  private readonly session = fact('Session ID', true);
  private readonly project = fact('Project');
  private readonly backend = fact('Backend');
  private readonly model = fact('Model');
  private readonly effort = fact('Effort');
  private readonly mcpServer = fact('Server', true);
  private readonly mcpContact = fact('Contact', true);
  private readonly mcpInitialize = fact('Initialize');
  private readonly mcpToolsList = fact('Tools/list');
  private readonly mcpToolsCall = fact('Tools/call');
  private readonly mcpLastMethod = fact('Last method');
  private readonly mcpLastSeen = fact('Last contact', true);
  private readonly cacheHit = fact('Cache hit');
  private readonly cacheRead = fact('Cache read');
  private readonly cacheWrite = fact('Cache write');
  private readonly turnInput = fact('Turn input');
  private readonly input = fact('Input');
  private readonly output = fact('Output');
  private readonly cost = fact('Cost', true);
  private readonly tools = fact('Tool calls');
  private readonly rows = fact('Transcript rows');
  private readonly permissions = fact('Permissions');
  private readonly questions = fact('Questions');
  private readonly flags = fact('Turn flags', true);
  private readonly error = fact('Error', true);

  constructor() {
    super(el('aside', { class: B + ' acp-harness__session-dock', attrs: { tabindex: '-1' } }));
    this.meterEl.appendChild(this.fillEl);
    this.el.append(
      el('header', { class: B + '__head' },
        el('span', { class: B + '__identity' },
          harnessIconEl('panel-session', B + '__icon'), this.laneEl),
        this.statusEl),
      el('section', { class: B + '__section', attrs: { 'aria-label': 'Context' } },
        el('h3', { class: B + '__heading' },
          harnessIconEl('gauge', B + '__icon'), 'Context'),
        el('div', { class: B + '__context' },
          el('div', { class: B + '__readout' }, this.percentEl, this.countEl),
          this.meterEl)),
      el('section', { class: B + '__section', attrs: { 'aria-label': 'Session details' } },
        el('h3', { class: B + '__heading' },
          harnessIconEl('list', B + '__icon'), 'Details'),
        el('dl', { class: B + '__facts' },
          this.project.row, this.backend.row, this.model.row, this.effort.row, this.session.row)),
      el('section', { class: B + '__section', attrs: { 'aria-label': 'MCP connection' } },
        el('h3', { class: B + '__heading' },
          harnessIconEl('remote', B + '__icon'), 'MCP connection'),
        el('dl', { class: B + '__facts' },
          this.mcpServer.row, this.mcpContact.row, this.mcpInitialize.row,
          this.mcpToolsList.row, this.mcpToolsCall.row,
          this.mcpLastMethod.row, this.mcpLastSeen.row),
        el('p', { class: B + '__mcp-note', text: 'Request history for this lane; not a live connection check.' })),
      el('section', { class: B + '__section', attrs: { 'aria-label': 'Usage details' } },
        el('h3', { class: B + '__heading' },
          harnessIconEl('embedded', B + '__icon'), 'Usage'),
        el('dl', { class: B + '__facts' },
          this.cacheHit.row, this.turnInput.row, this.cacheRead.row, this.cacheWrite.row,
          this.input.row, this.output.row, this.cost.row)),
      el('section', { class: B + '__section', attrs: { 'aria-label': 'Activity' } },
        el('h3', { class: B + '__heading' },
          harnessIconEl('exec-activity', B + '__icon'), 'Activity'),
        el('dl', { class: B + '__facts' },
          this.tools.row, this.rows.row, this.permissions.row, this.questions.row,
          this.flags.row, this.error.row)),
      el('footer', { class: B + '__keys' },
        ...keyHintNodes([
          { keys: ['[', ']'], label: 'tab' },
          { keys: ['Esc'], label: 'return' },
        ])),
    );
  }

  protected readDeps(next: SessionInfoProps): readonly unknown[] {
    return [
      next.laneName, next.sessionId, next.backendName, next.modelName,
      next.effortName, next.status, next.contextUsed, next.contextSize,
      next.mcpEndpointAvailable, next.mcpInitializeCount, next.mcpToolsListCount,
      next.mcpToolsCallCount, next.mcpLastMethod, next.mcpLastSeenAt,
      next.projectName, next.cacheHit, next.cacheRead, next.cacheWrite,
      next.turnInput, next.inputTokens, next.outputTokens, next.costAmount,
      next.costCurrency, next.toolCalls, next.transcriptRows,
      next.pendingPermissions, next.pendingQuestions, next.turnFlags, next.error,
    ];
  }

  protected syncClasses(): void {
    this.el.className = B + ' acp-harness__session-dock';
  }

  protected paint(next: SessionInfoProps): void {
    this.syncClasses();
    setText(this.laneEl, next.laneName);
    setText(this.statusEl, STATUS_LABEL[next.status]);
    this.statusEl.dataset.status = next.status;
    setText(this.session.value, next.sessionId ?? 'Pending');
    this.paintValue(this.project, next.projectName);
    setText(this.backend.value, next.backendName);
    setText(this.model.value, next.modelName ?? 'Unknown');
    setText(this.effort.value, next.effortName ?? 'Unknown');
    setText(this.mcpServer.value, 'krypton-harness-memory');
    setText(this.mcpContact.value, mcpContactLabel(next));
    setText(this.mcpInitialize.value, formatCount(next.mcpInitializeCount));
    setText(this.mcpToolsList.value, formatCount(next.mcpToolsListCount));
    setText(this.mcpToolsCall.value, formatCount(next.mcpToolsCallCount));
    this.paintValue(this.mcpLastMethod, next.mcpLastMethod);
    this.paintValue(this.mcpLastSeen, next.mcpLastSeenAt === null
      ? null : new Date(next.mcpLastSeenAt).toLocaleString());
    this.paintValue(this.cacheHit, next.cacheHit);
    this.paintValue(this.cacheRead, next.cacheRead === null ? null : formatCount(next.cacheRead));
    this.paintValue(this.cacheWrite, next.cacheWrite === null ? null : formatCount(next.cacheWrite));
    this.paintValue(this.turnInput, next.turnInput === null ? null : formatCount(next.turnInput));
    this.paintValue(this.input, next.inputTokens === null && next.outputTokens === null ? null : formatCount(next.inputTokens ?? 0));
    this.paintValue(this.output, next.inputTokens === null && next.outputTokens === null ? null : formatCount(next.outputTokens ?? 0));
    this.paintValue(this.cost, next.costAmount === null ? null : `$${next.costAmount.toFixed(4)} ${next.costCurrency ?? ''}`.trim());
    setText(this.tools.value, String(next.toolCalls));
    setText(this.rows.value, String(next.transcriptRows));
    setText(this.permissions.value, String(next.pendingPermissions));
    setText(this.questions.value, String(next.pendingQuestions));
    this.paintValue(this.flags, next.turnFlags || null);
    this.paintValue(this.error, next.error);

    const context = sessionContext(next.contextUsed, next.contextSize);
    if (context.used === null) {
      setText(this.percentEl, 'Context unavailable');
      setText(this.countEl, '');
    } else if (context.percent === null) {
      setText(this.percentEl, '—');
      setText(this.countEl, formatCount(context.used) + ' tokens');
    } else {
      setText(this.percentEl, context.percent + '% used');
      setText(this.countEl, formatCount(context.used) + ' / ' + formatCount(context.size!));
    }
    this.meterEl.hidden = context.percent === null;
    if (context.percent !== null && context.used !== null && context.size !== null) {
      this.fillEl.style.width = context.percent + '%';
      setAttr(this.meterEl, 'aria-valuemin', 0);
      setAttr(this.meterEl, 'aria-valuemax', context.size);
      setAttr(this.meterEl, 'aria-valuenow', Math.min(context.used, context.size));
      setAttr(this.meterEl, 'aria-valuetext', context.used.toLocaleString() + ' of ' + context.size.toLocaleString() + ' tokens');
    } else {
      this.fillEl.style.width = '0%';
      setAttr(this.meterEl, 'aria-valuemin', undefined);
      setAttr(this.meterEl, 'aria-valuemax', undefined);
      setAttr(this.meterEl, 'aria-valuenow', undefined);
      setAttr(this.meterEl, 'aria-valuetext', undefined);
    }
  }

  private paintValue(field: { value: HTMLElement }, value: string | null): void {
    setText(field.value, value ?? '—');
  }
}

export const def: ComponentDef = { id: 'session-info', blocks: [B] };
