// Krypton — ACP Harness View: lane chrome vocabulary.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Spec 301 phases 3–4
// moved every string builder that painted lane chrome — the head line, its
// chips, the process-tree block, the stats line and the slash palette — into
// the `lane-head`, `lane-stats`, `lane-symbol`, `metrics-overlay` and
// `inline-palette` components. What stays is the vocabulary those components
// read: status labels, the activity line, permission compaction, metric
// bucketing and the slash-command matcher the view's key table consults.

import type {
  AcpAvailableCommand,
  AgentInfo,
  AgentInitInfo,
  HarnessLaneStatus,
  ToolCall,
  ToolCallUpdate,
} from './types';
import type { AcpLaneProcMetric } from '../types';
import type { LaneModelConfig } from '../config';
import type { PendingPeerSummary } from './inter-lane';
import type {
  HarnessLane,
  HarnessPermission,
  HarnessTranscriptItem,
} from './harness-view-types';
import { harnessAutoAllowToolName } from './harness-permission-scan';
import {
  cleanToolTitle,
  extractCommandLine,
  inferToolLabel,
} from './harness-tool-render';
import { extractModifiedPath } from './acp-harness-memory';
import { basename, truncateInline } from './harness-format';

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
  return (info as AgentInfo).current_model_id ?? null;
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

// Interpreters whose bare process name ("node", "python3") says nothing about
// what they're actually running — the useful identity lives in the script /
// module argument. Everything else is assumed to be its own meaningful name.
const PROC_INTERPRETERS = new Set([
  'node', 'node.exe', 'deno', 'bun', 'electron',
  'python', 'python.exe', 'ruby', 'perl', 'php', 'java', 'dotnet',
]);

function isInterpreter(name: string): boolean {
  const n = name.toLowerCase();
  return PROC_INTERPRETERS.has(n) || n.startsWith('python');
}

// "@scope/pkg@1.2.3" → "@scope/pkg"; "pkg@1.2.3" → "pkg"; leaves a bare
// "@scope/pkg" (no version) and a plain "pkg" untouched.
function stripPkgVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

function procBasename(path: string): string {
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
function prettifyScriptPath(path: string): string {
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

export function isPollyImplementerBypass(lane: HarnessLane): boolean {
  return lane.pollyBuiltinRole === 'implementer' && lane.permissionMode === 'bypass';
}

export function isSaltyExecutorBypass(lane: HarnessLane): boolean {
  return (
    (lane.saltyBuiltinRole === 'mechanical' || lane.saltyBuiltinRole === 'codexPeer') &&
    lane.permissionMode === 'bypass'
  );
}

// `:` is part of namespaced command names (OMP advertises `skill:<name>`).
// One `/` is allowed only after `skill:` (OMP namespaced skills,
// `skill:<namespace>/<name>`), so typed paths like `/Users/…` stay prose.
const SLASH_PALETTE_REGEX = /^\/(?:\$?[a-zA-Z0-9_:-]*|skill:[a-zA-Z0-9_-]*\/[a-zA-Z0-9_-]*)$/;

export function slashPaletteVisible(lane: HarnessLane): boolean {
  if (lane.slashPaletteDismissed) return false;
  if (lane.availableCommands.length === 0) return false;
  return SLASH_PALETTE_REGEX.test(lane.draft);
}

export function filteredSlashCommands(lane: HarnessLane): AcpAvailableCommand[] {
  const match = lane.draft.match(SLASH_PALETTE_REGEX);
  if (!match) return [];
  const prefix = lane.draft.slice(1).toLowerCase();
  return lane.availableCommands.filter((command) => {
    const name = command.name.toLowerCase();
    return name.startsWith(prefix) || (name.startsWith('$') && name.slice(1).startsWith(prefix));
  });
}

/**
 * A prompt that invokes one of the agent's advertised slash commands
 * (`/review`, `/$skill args`). Adapters such as OMP join every prompt block
 * into one string and only parse a command when that string starts with `/`,
 * so these turns must reach the agent without the lane-context packet.
 * Unadvertised tokens (`/Users/wk/…` paths) stay ordinary prompts.
 */
export function isAgentSlashCommand(text: string, commands: AcpAvailableCommand[]): boolean {
  const match = /^\/(\S+)/.exec(text);
  if (!match) return false;
  const token = match[1].toLowerCase();
  return commands.some((command) => command.name.toLowerCase() === token);
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
    case 'fs_write_review': return 'write';
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

function compactPermissionTool(permission: HarnessPermission): string {
  const call = permission.toolCall;
  const kind = inferToolLabel(call);
  return harnessAutoAllowToolName(permission) ?? (cleanToolTitle(call.title, kind) || kind);
}

function compactPermissionSubject(call: ToolCall | ToolCallUpdate): string {
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
