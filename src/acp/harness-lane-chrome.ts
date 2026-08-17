// Krypton — ACP Harness View: lane chrome rendering.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Every string-returning
// helper that paints a lane's own chrome: the rail/head line, its chip row
// (model / mode / sandbox / mcp / metrics), the process-tree metrics block, the
// stats line, the slash palette, and the lane status vocabulary.

import type {
  AcpAvailableCommand,
  AgentInfo,
  AgentInitInfo,
  HarnessLaneStatus,
  HarnessMcpLaneStats,
  ToolCall,
  ToolCallUpdate,
} from './types';
import type { AcpLaneMetrics, AcpLaneProcMetric } from '../types';
import type { LaneModelConfig } from '../config';
import type { PendingPeerSummary } from './inter-lane';
import type {
  HarnessLane,
  HarnessPermission,
  HarnessTranscriptItem,
} from './harness-view-types';
import { harnessIcon } from './harness-icons';
import { backendLogoId } from './harness-lane-identity';
import { harnessAutoAllowToolName } from './harness-permission-scan';
import {
  cleanToolTitle,
  extractCommandLine,
  inferToolLabel,
} from './harness-tool-render';
import { extractModifiedPath } from './acp-harness-memory';
import {
  basename,
  esc,
  formatCount,
  formatCpu,
  formatRss,
  shortId,
  truncate,
  truncateInline,
} from './harness-format';

/** Backend default when the agent advertises no model of its own. */
const OPENCODE_DEFAULT_MODEL = 'zai-coding-plan/glm-5.1';

// Braille spinner frames driven by a single JS interval. A shared frame counter,
// re-applied to every spinner element on each tick, keeps the glyph continuous
// across DOM rebuilds — unlike a CSS animation, which restarts whenever its host
// element is recreated (the 2 s metrics-poll head rebuild, the 1 s composer tick),
// reading as a stutter / snap.
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function inferLaneModelName(
  backendId: string,
  info: AgentInfo | AgentInitInfo,
  laneModels: Record<string, LaneModelConfig>,
): string | null {
  const configured = laneModels[backendId]?.active;
  if (configured && configured.length > 0) return configured;
  const reported = findModelName(info.agent_capabilities);
  if (reported) return reported;
  if (backendId === 'opencode') return OPENCODE_DEFAULT_MODEL;
  return null;
}

export function findModelName(value: unknown, depth = 0): string | null {
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

export function renderLaneHead(
  lane: HarnessLane,
  active: boolean,
  mcp: HarnessMcpLaneStats | null,
  metrics: AcpLaneMetrics | null,
  inboxDepth: number,
  pendingPeers: PendingPeerSummary[],
  isOrchestrator = false,
): string {
  const mcpChip = renderMcpChip(mcp);
  const modelChip = renderModelChip(lane.modelName, lane.modelApplyFailed);
  const modeChip = renderModeChip(lane);
  const sandboxChip = renderSandboxChip(lane);
  const pollyBypassChip = renderPollyBypassChip(lane);
  const saltyBypassChip = renderSaltyBypassChip(lane);
  const metricsChip = renderMetricsChip(metrics);
  // spec 180: behavior-neutral orchestrator-seat badge (≤1 per harness).
  const orchestratorChip = isOrchestrator
    ? `<span class="acp-harness__lane-orchestrator" title="orchestrator seat (#orchestrator)">◆ orch</span>`
    : '';
  const chipGroup = orchestratorChip + modelChip + modeChip + mcpChip + sandboxChip + pollyBypassChip + saltyBypassChip + metricsChip;
  const chips = chipGroup
    ? `<span class="acp-harness__lane-chips">${chipGroup}</span>`
    : '';
  const inboxChip = inboxDepth > 0
    ? `<span class="acp-harness__lane-inbox" title="${inboxDepth} pending peer message${inboxDepth === 1 ? '' : 's'}">${harnessIcon('inbox', 'acp-harness__icon--dot')}${inboxDepth}</span>`
    : '';
  // spec 215: the backend logo rides inside the name span (no head-grid column
  // change) and inherits the name's color, so it dims with the collapsed name.
  const logo =
    `<svg class="acp-harness__icon" aria-hidden="true">` +
    `<use href="#${backendLogoId(lane.backendId)}"/></svg>`;
  if (!active) {
    const statusText = lane.status === 'needs_permission' ? 'perm' : statusLabel(lane.status);
    return (
      renderLaneSymbol(lane.status) +
      `<span class="acp-harness__lane-name">${logo}${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__lane-status">${esc(statusText)}</span>` +
      inboxChip +
      chips +
      `<span class="acp-harness__lane-activity">${esc(laneActivity(lane, pendingPeers))}</span>`
    );
  }
  // spec 199 (issue #13): once a cancel goes unacknowledged the same key becomes
  // the force-restart gesture — surface it here, since the transcript row that
  // announced it scrolls away. A pending shell cancel still wins in the key
  // handler, so it keeps the plain hint.
  const cancelHint = lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer' || lane.pendingShellId
    ? lane.cancelUnacked && !lane.pendingShellId
      ? `<span class="acp-harness__lane-cancel-hint acp-harness__lane-cancel-hint--force" title="cancel unacknowledged - ⌃C force-restarts this lane and resumes the session">⌃C force restart</span>`
      : `<span class="acp-harness__lane-cancel-hint">⌃C cancel</span>`
    : '';
  return (
    renderLaneSymbol(lane.status) +
    `<span class="acp-harness__lane-name">${logo}${esc(lane.displayName)}</span>` +
    `<span class="acp-harness__lane-status">${esc(statusLabel(lane.status))}</span>` +
    inboxChip +
    chips +
    `<span class="acp-harness__lane-activity">${esc(laneActivity(lane, pendingPeers))}</span>` +
    cancelHint
  );
}

export function renderMetricsChip(metrics: AcpLaneMetrics | null): string {
  if (!metrics || !metrics.root_alive || metrics.proc_count === 0) return '';
  const cpu = formatCpu(metrics.total_cpu_percent);
  const rss = formatRss(metrics.total_rss_mb);
  const bucket = metricsBucket(metrics.total_cpu_percent);
  const title = `pid ${metrics.root_pid} · adapter + ${metrics.proc_count - 1} children · ⌘P m for breakdown`;
  return (
    `<span class="acp-harness__lane-metrics acp-harness__lane-metrics--${bucket}" title="${esc(title)}">` +
    `<span class="acp-harness__lane-metrics-cpu">${esc(cpu)}</span>` +
    `<span class="acp-harness__lane-metrics-rss">${esc(rss)}</span>` +
    `</span>`
  );
}

export function renderProcessTree(m: AcpLaneMetrics): string {
  // Build parent → children map and render BFS-tree from root.
  const childrenByParent = new Map<number, number[]>();
  for (const p of m.processes) {
    if (p.parent_pid !== null && p.parent_pid !== undefined) {
      const arr = childrenByParent.get(p.parent_pid) ?? [];
      arr.push(p.pid);
      childrenByParent.set(p.parent_pid, arr);
    }
  }
  const byPid = new Map<number, AcpLaneMetrics['processes'][number]>();
  for (const p of m.processes) byPid.set(p.pid, p);

  const lines: string[] = [];
  const walk = (pid: number, depth: number, isLast: boolean, prefix: string): void => {
    const p = byPid.get(pid);
    if (!p) return;
    const branch = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
    const role = depth === 0
      ? `<span class="acp-harness__metrics-role">adapter</span>`
      : '';
    const { label, command } = describeProc(p);
    const detail = label
      ? `<span class="acp-harness__metrics-detail">${esc(label)}</span>`
      : '';
    const processName =
      `<span class="acp-harness__metrics-tree">${esc(prefix + branch)}</span>` +
      `<span class="acp-harness__metrics-name">${esc(p.name)}</span>` +
      detail +
      role;
    lines.push(
      `<div class="acp-harness__metrics-row${depth === 0 ? ' acp-harness__metrics-row--root' : ''}" title="${esc(command)}">` +
        `<span class="acp-harness__metrics-process">${processName}</span>` +
        `<span class="acp-harness__metrics-pid">${p.pid}</span>` +
        renderMetricCell('cpu', formatCpu(p.cpu_percent), metricPercent(p.cpu_percent, 100)) +
        renderMetricCell('rss', formatRss(p.rss_mb), metricPercent(p.rss_mb, m.total_rss_mb)) +
      `</div>`,
    );
    const kids = [...(childrenByParent.get(pid) ?? [])].sort((a, b) => {
      const procA = byPid.get(a);
      const procB = byPid.get(b);
      return (procB?.cpu_percent ?? 0) - (procA?.cpu_percent ?? 0);
    });
    const visibleKids = kids.filter((k) => byPid.has(k));
    visibleKids.forEach((kid, i) => {
      const last = i === visibleKids.length - 1;
      const nextPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
      walk(kid, depth + 1, last, nextPrefix);
    });
  };
  walk(m.root_pid, 0, true, '');
  return (
    `<div class="acp-harness__metrics-tree-block">` +
      `<div class="acp-harness__metrics-row acp-harness__metrics-row--header">` +
        `<span>Process</span><span>PID</span><span>CPU</span><span>Mem</span>` +
      `</div>` +
      lines.join('') +
    `</div>`
  );
}

// Interpreters whose bare process name ("node", "python3") says nothing about
// what they're actually running — the useful identity lives in the script /
// module argument. Everything else is assumed to be its own meaningful name.
const PROC_INTERPRETERS = new Set([
  'node', 'node.exe', 'deno', 'bun', 'electron',
  'python', 'python.exe', 'ruby', 'perl', 'php', 'java', 'dotnet',
]);

export function isInterpreter(name: string): boolean {
  const n = name.toLowerCase();
  return PROC_INTERPRETERS.has(n) || n.startsWith('python');
}

// "@scope/pkg@1.2.3" → "@scope/pkg"; "pkg@1.2.3" → "pkg"; leaves a bare
// "@scope/pkg" (no version) and a plain "pkg" untouched.
export function stripPkgVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

export function procBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

// Turn a script path into the most recognizable name: the npm package when it
// lives under node_modules (handles @scope/name and .bin shims), otherwise the
// file's basename. e.g.
//   .../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js
//     → "@modelcontextprotocol/server-filesystem"
//   .../node_modules/.bin/claude-code-acp → "claude-code-acp"
//   /Users/me/proj/server.js              → "server.js"
export function prettifyScriptPath(path: string): string {
  const marker = path.lastIndexOf('node_modules/');
  if (marker !== -1) {
    const parts = path.slice(marker + 'node_modules/'.length).split('/').filter(Boolean);
    if (parts.length) {
      if (parts[0] === '.bin' && parts[1]) return parts[1];
      if (parts[0].startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
      return parts[0];
    }
  }
  return procBasename(path);
}

// Derive a short human label for a process row plus the full command for the
// hover tooltip. The label answers "which node is this?" — the question the
// bare process tree can't, since a busy lane is mostly indistinguishable
// "node" rows (the adapter wrapper, each MCP server, tool subprocesses).
export function describeProc(p: AcpLaneProcMetric): { label: string; command: string } {
  const argv = Array.isArray(p.cmd) ? p.cmd.filter((a) => a.length > 0) : [];
  const command = argv.length ? argv.join(' ') : (p.exe ?? p.name);
  // First argument that isn't a flag — for interpreters this is the script or,
  // after `-m`/`-e` style flags, the module/code token.
  const firstArg = argv.slice(1).find((a) => !a.startsWith('-'));

  let label = '';
  if (isInterpreter(p.name)) {
    if (firstArg) {
      label = prettifyScriptPath(firstArg);
      // npx / npm-exec launchers: the script *is* the launcher ("npm"), so the
      // useful identity is the package it's running, further along argv. The
      // Claude lane (`npx -y @agentclientprotocol/claude-agent-acp`) lands here.
      const launcher = procBasename(firstArg).toLowerCase();
      if (launcher === 'npx-cli.js' || launcher === 'npx' || launcher === 'npm-cli.js' || launcher === 'npm') {
        const after = argv.slice(argv.indexOf(firstArg) + 1).find((a) => !a.startsWith('-'));
        if (after) label = stripPkgVersion(after);
      }
    }
  } else if (firstArg) {
    // Non-interpreter binary (claude, rg, git…): a path arg → its basename,
    // a short bareword → the subcommand itself.
    label = /[/\\]/.test(firstArg)
      ? prettifyScriptPath(firstArg)
      : (firstArg.length <= 24 ? firstArg : '');
  } else if (argv.length === 0 && p.exe) {
    // No argv at all (restricted process): fall back to the exe basename when
    // it adds something the name doesn't already say.
    const base = procBasename(p.exe);
    if (base && base.toLowerCase() !== p.name.toLowerCase()) label = base;
  }

  // Never echo the process name back as its own label.
  if (label.toLowerCase() === p.name.toLowerCase()) label = '';
  return { label, command };
}

export function renderMetricCell(kind: 'cpu' | 'rss', value: string, width: number): string {
  return (
    `<span class="acp-harness__metrics-meter acp-harness__metrics-meter--${kind}">` +
      `<span class="acp-harness__metrics-meter-value">${esc(value)}</span>` +
      `<span class="acp-harness__metrics-meter-track">` +
        `<span class="acp-harness__metrics-meter-fill" style="width:${width.toFixed(0)}%"></span>` +
      `</span>` +
    `</span>`
  );
}

export function metricPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

export function metricsBucket(cpu: number): 'idle' | 'warm' | 'hot' | 'crit' {
  if (cpu > 95) return 'crit';
  if (cpu > 80) return 'hot';
  if (cpu > 60) return 'warm';
  return 'idle';
}

export function renderModeChip(lane: HarnessLane): string {
  if (!lane.currentMode) return '';
  const title = lane.currentMode.description
    ? `${lane.currentMode.name} — ${lane.currentMode.description}`
    : `mode ${lane.currentMode.id}`;
  return `<span class="acp-harness__lane-mode" title="${esc(title)}">${esc(lane.currentMode.name)}</span>`;
}

export function isPollyImplementerBypass(lane: HarnessLane): boolean {
  return lane.pollyBuiltinRole === 'implementer' && lane.permissionMode === 'bypass';
}

/** spec 164 — Polly implementers run with permissionMode bypass; surface in chrome. */
export function renderPollyBypassChip(lane: HarnessLane): string {
  if (!isPollyImplementerBypass(lane)) return '';
  const title =
    'Polly worker — all tool permissions auto-accepted for this lane until the Polly role clears';
  return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">polly-bypass</span>`;
}

export function isSaltyExecutorBypass(lane: HarnessLane): boolean {
  return (
    (lane.saltyBuiltinRole === 'mechanical' || lane.saltyBuiltinRole === 'codexPeer') &&
    lane.permissionMode === 'bypass'
  );
}

/** spec 195 — Salty mechanical/codex-peer executors run bypassed; surface in chrome. */
export function renderSaltyBypassChip(lane: HarnessLane): string {
  if (!isSaltyExecutorBypass(lane)) return '';
  const title =
    'Salty executor — all tool permissions auto-accepted for this lane until the Salty role clears (#salty clear)';
  return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">salty-bypass</span>`;
}

export function renderSandboxChip(lane: HarnessLane): string {
  // Surface backend-specific safety caveats directly in the lane chrome:
  // Pi is known to bypass the permission rail; Junie still needs manual
  // verification of ACP write-permission semantics.
  const warn = harnessIcon('warn', 'acp-harness__icon--dot');
  if (lane.backendId === 'pi-acp') {
    const title = 'No permission gate — Pi runs edits and shell commands immediately. Use a sandboxed cwd or container if untrusted.';
    return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">${warn} unsandboxed</span>`;
  }
  if (lane.backendId === 'junie') {
    const title = 'Junie ACP write-permission behavior has not been verified yet. Krypton does not pass force/yolo/brave flags, but use a trusted cwd until verified.';
    return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">${warn} permissions unverified</span>`;
  }
  return '';
}

export function renderModelChip(modelName: string | null, applyFailed = false): string {
  if (!modelName) return '';
  if (applyFailed) {
    const title = `requested model ${modelName} not applied — agent is using its default or prior model (session/set_model failed)`;
    return `<span class="acp-harness__lane-model acp-harness__lane-model--warn" title="${esc(title)}">${harnessIcon('warn', 'acp-harness__icon--dot')} ${esc(modelName)}</span>`;
  }
  return `<span class="acp-harness__lane-model" title="model ${esc(modelName)}">${esc(modelName)}</span>`;
}

export function renderMcpChip(mcp: HarnessMcpLaneStats | null): string {
  if (!mcp || mcp.toolsListCount === 0) {
    const title = mcp
      ? `MCP descriptor sent; adapter has not called tools/list. init=${mcp.initializeCount}`
      : 'MCP descriptor sent; adapter has not contacted the server.';
    return `<span class="acp-harness__lane-mcp acp-harness__lane-mcp--off" title="${esc(title)}">mcp —</span>`;
  }
  const title = `tools/list ${mcp.toolsListCount} · tools/call ${mcp.toolsCallCount}` +
    (mcp.lastMethod ? ` · last ${mcp.lastMethod}` : '');
  return `<span class="acp-harness__lane-mcp acp-harness__lane-mcp--on" title="${esc(title)}">mcp ${harnessIcon('check', 'acp-harness__icon--dot')}${mcp.toolsCallCount > 0 ? ` ${mcp.toolsCallCount}` : ''}</span>`;
}

const SLASH_PALETTE_REGEX = /^\/[a-zA-Z0-9_-]*$/;

export function slashPaletteVisible(lane: HarnessLane): boolean {
  if (lane.slashPaletteDismissed) return false;
  if (lane.availableCommands.length === 0) return false;
  return SLASH_PALETTE_REGEX.test(lane.draft);
}

export function filteredSlashCommands(lane: HarnessLane): AcpAvailableCommand[] {
  const match = lane.draft.match(SLASH_PALETTE_REGEX);
  if (!match) return [];
  const prefix = lane.draft.slice(1).toLowerCase();
  return lane.availableCommands.filter((c) => c.name.toLowerCase().startsWith(prefix));
}

export function renderSlashPalette(lane: HarnessLane): string {
  if (!slashPaletteVisible(lane)) return '';
  const matches = filteredSlashCommands(lane);
  if (matches.length === 0) return '';
  const safeIndex = Math.max(0, Math.min(lane.slashPaletteIndex, matches.length - 1));
  const rows = matches
    .map((cmd, i) => {
      const sel = i === safeIndex ? ' acp-harness__slash-palette-row--selected' : '';
      const desc = cmd.description ? `<span class="acp-harness__slash-palette-desc">${esc(cmd.description)}</span>` : '';
      const hint = cmd.inputHint ? `<span class="acp-harness__slash-palette-hint">${esc(cmd.inputHint)}</span>` : '';
      return (
        `<div class="acp-harness__slash-palette-row${sel}">` +
        `<span class="acp-harness__slash-palette-name">/${esc(cmd.name)}</span>` +
        hint +
        desc +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="acp-harness__slash-palette" data-count="${matches.length}">` +
    `<div class="acp-harness__slash-palette-meta">↑↓ / ⌃n⌃p select · Enter/Tab insert · Esc dismiss</div>` +
    rows +
    `</div>`
  );
}

export function renderLaneStats(lane: HarnessLane, projectDir: string | null): string {
  // Each cell is a <span>; iconified cells carry a title so the dropped noun
  // (ctx/tools/rows) and the ↓↑ arrows stay legible to tooltips + screen readers.
  const spans: string[] = [];
  const cell = (inner: string, title?: string): string =>
    `<span${title ? ` title="${esc(title)}"` : ''}>${inner}</span>`;
  const text = (s: string): string => cell(esc(s));

  // spec 215 follow-up: no backend logo/id cell here — the head's name span
  // one line up already carries the logo, and repeating it made the stats row
  // read as a second head instead of head metadata.
  spans.push(text(lane.sessionId ? `sess ${shortId(lane.sessionId)}` : 'sess pending'));
  if (projectDir) spans.push(text(basename(projectDir)));

  const usage = lane.usage;
  if (usage) {
    if (typeof usage.used === 'number') {
      const val = typeof usage.size === 'number' && usage.size > 0
        ? `${formatCount(usage.used)}/${formatCount(usage.size)} (${Math.round((usage.used / usage.size) * 100)}%)`
        : formatCount(usage.used);
      spans.push(cell(`${harnessIcon('gauge')}${esc(val)}`, `context ${val}`));
    }
    if (typeof usage.cachedReadTokens === 'number' || typeof usage.cachedWriteTokens === 'number') {
      const r = formatCount(usage.cachedReadTokens ?? 0);
      const w = formatCount(usage.cachedWriteTokens ?? 0);
      spans.push(cell(
        `cache ${esc(r)}${harnessIcon('dl', 'acp-harness__icon--dot')}${esc(w)}${harnessIcon('ul', 'acp-harness__icon--dot')}`,
        `cache read ${r}, write ${w}`,
      ));
    }
    if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
      spans.push(text(`in ${formatCount(usage.inputTokens ?? 0)} out ${formatCount(usage.outputTokens ?? 0)}`));
    }
    if (usage.cost) spans.push(text(`$${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`));
  }

  if (lane.toolCalls.size > 0) {
    spans.push(cell(`${harnessIcon('tool')}${esc(String(lane.toolCalls.size))}`, `${lane.toolCalls.size} tool calls`));
  }
  spans.push(cell(`${harnessIcon('list')}${esc(String(lane.transcript.length))}`, `${lane.transcript.length} transcript rows`));
  if (lane.pendingPermissions.length > 0) spans.push(text(`${lane.pendingPermissions.length} perm`));
  if (lane.pendingQuestions.length > 0) spans.push(text(`${lane.pendingQuestions.length} ask`));
  if (lane.acceptAllForTurn) spans.push(text('accept-all'));
  if (lane.rejectAllForTurn) spans.push(text('reject-all'));
  if (lane.peerAutoAcceptForTurn) spans.push(text('peer-auto'));
  if (isPollyImplementerBypass(lane)) spans.push(text('polly-bypass'));
  if (lane.error) spans.push(text(`err: ${truncate(lane.error, 48)}`));

  return spans.join('');
}

export function transcriptLabel(kind: HarnessTranscriptItem['kind']): string {
  switch (kind) {
    case 'system': return 'sys';
    case 'assistant': return 'agent';
    case 'provider_error': return 'agent';
    case 'permission': return 'perm';
    case 'question': return 'ask';
    case 'memory': return 'mem';
    case 'shell': return 'sh';
    case 'fs_activity': return 'fs';
    case 'inter_lane': return 'mail';
    case 'artifact': return 'html';
    default: return kind;
  }
}

export function laneActivity(lane: HarnessLane, pendingPeers: PendingPeerSummary[] = []): string {
  if (lane.status === 'error') return `error: ${lane.error ?? 'failed'}`;
  if (lane.status === 'needs_permission') {
    const permission = lane.pendingPermissions[0];
    if (permission) {
      return `perm ${compactPermissionSubject(permission.toolCall) || compactPermissionTool(permission)}`;
    }
    const ask = lane.pendingQuestions[0];
    if (ask) {
      const q = ask.questions[ask.card.questionIndex] ?? ask.questions[0];
      return q ? `ask ${q.question}` : 'ask required';
    }
    return 'perm required';
  }
  if (lane.status === 'awaiting_peer') return awaitingPeerText(pendingPeers);
  const latest = lane.transcript[lane.transcript.length - 1];
  if (!latest) return lane.status;
  return latest.text.replace(/\s+/g, ' ').slice(0, 60);
}

export function compactPermissionLabel(permission: HarnessPermission): string {
  const tool = compactPermissionTool(permission);
  const subject = compactPermissionSubject(permission.toolCall);
  return truncateInline(subject ? `${tool} ${subject}` : tool, 48);
}

export function compactPermissionMeta(permission: HarnessPermission): string {
  return `${compactPermissionLabel(permission)} · a/r/Esc`;
}

export function compactPermissionTool(permission: HarnessPermission): string {
  const call = permission.toolCall;
  const kind = inferToolLabel(call);
  return harnessAutoAllowToolName(permission) ?? (cleanToolTitle(call.title, kind) || kind);
}

export function compactPermissionSubject(call: ToolCall | ToolCallUpdate): string {
  const path = extractModifiedPath(call) ?? call.locations?.[0]?.path ?? '';
  if (path) return basename(path);
  const command = extractCommandLine(call.rawInput);
  if (command) return truncateInline(command, 28);
  return '';
}

export function awaitingPeerText(pendingPeers: PendingPeerSummary[]): string {
  if (pendingPeers.length === 0) return 'awaiting lane mail reply · #cancel';
  const oldest = pendingPeers.reduce((min, peer) => peer.sentAt < min.sentAt ? peer : min, pendingPeers[0]);
  const age = formatAwaitingPeerAge(Date.now() - oldest.sentAt);
  if (pendingPeers.length === 1) return `awaiting ${oldest.toDisplayName} · ${age} · #cancel`;
  return `awaiting ${pendingPeers.length} peers · ${age} · #cancel`;
}

export function formatAwaitingPeerAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  if (ms < 5 * 60_000) return '1m+';
  if (ms < 15 * 60_000) return '5m+';
  return '15m+';
}

export function statusIconId(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'status-starting';
    case 'idle': return 'status-idle';
    case 'busy': return 'status-busy';
    case 'needs_permission': return 'status-perm';
    case 'awaiting_peer': return 'status-peer';
    case 'error': return 'status-error';
    case 'stopped': return 'status-error';
  }
}

// Row-1 leading status glyph as an SVG, in a state-tinted wrapper so CSS can
// colour idle/busy/permission/peer/error distinctly (was Unicode · ○ ● ! ⇆ ×).
export function renderLaneSymbol(status: HarnessLaneStatus): string {
  // busy → braille spinner glyph advanced by the JS ticker (tickSpinner); every
  // other status → static SVG status icon.
  const inner = status === 'busy'
    ? `<span class="acp-harness__spinner">${SPINNER_FRAMES[0]}</span>`
    : harnessIcon(statusIconId(status));
  return (
    `<span class="acp-harness__lane-symbol acp-harness__lane-symbol--${status}">` +
    inner +
    `</span>`
  );
}

export function statusLabel(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'starting';
    case 'idle': return 'idle';
    case 'busy': return 'busy';
    case 'needs_permission': return 'action required';
    case 'awaiting_peer': return 'awaiting peer';
    case 'error': return 'error';
    case 'stopped': return 'stopped';
  }
}
