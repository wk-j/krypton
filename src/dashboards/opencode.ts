// Krypton — OpenCode Dashboard
// Read-only overlay showing OpenCode session history, token usage,
// model distribution, and tool usage from the local SQLite database,
// scoped to the project matching the focused terminal's CWD.
// Toggled via Cmd+Shift+O.

import { invoke } from '@tauri-apps/api/core';
import type { DashboardDefinition } from '../types';
import type { Compositor } from '../compositor';

/** Cached resolved path to the OpenCode SQLite database */
let resolvedDbPath: string | null = null;

/** Resolve the OpenCode DB path by asking the backend for $HOME */
async function getDbPath(): Promise<string> {
  if (resolvedDbPath) return resolvedDbPath;
  const homeOutput: string = await invoke('run_command', {
    program: 'sh',
    args: ['-c', 'echo $HOME'],
    cwd: null,
  });
  const home = homeOutput.trim();
  resolvedDbPath = `${home}/.local/share/opencode/opencode.db`;
  return resolvedDbPath;
}

// ─── Types ─────────────────────────────────────────────────────

type SqlRow = Record<string, unknown>;

interface OcSession {
  id: string;
  title: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
  msgCount: number;
  userMsgs: number;
  asstMsgs: number;
  outputTokens: number;
  additions: number;
  deletions: number;
  files: number;
  /** Comma-separated agent/model pairs, e.g. "build:opus, explore:opus" */
  agents: string;
}

interface OcModelUsage {
  model: string;
  provider: string;
  count: number;
  totalOutput: number;
}

interface OcToolUsage {
  tool: string;
  count: number;
}

interface OcOverview {
  totalSessions: number;
  totalMessages: number;
  totalTokensOutput: number;
  totalCacheRead: number;
  totalCost: number;
}

// ─── Queries (parameterized by project_id) ─────────────────────

/** Find the project_id for a given worktree directory */
const QUERY_PROJECT_ID = `
SELECT id FROM project WHERE worktree = ?1 LIMIT 1
`;

/** Session IDs subquery scoped to a project (reused in other queries) */
function sessionScope(projectId: string): string {
  return `SELECT id FROM session WHERE project_id = '${projectId}'`;
}

function buildOverviewQuery(projectId: string): string {
  const scope = sessionScope(projectId);
  return `
SELECT
  (SELECT COUNT(*) FROM session WHERE parent_id IS NULL AND project_id = '${projectId}') as total_sessions,
  (SELECT COUNT(*) FROM message WHERE session_id IN (${scope})) as total_messages,
  (SELECT COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) FROM message WHERE session_id IN (${scope}) AND json_extract(data, '$.role') = 'assistant') as total_output,
  (SELECT COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) FROM message WHERE session_id IN (${scope}) AND json_extract(data, '$.role') = 'assistant') as total_cache_read,
  (SELECT COALESCE(SUM(json_extract(data, '$.cost')), 0) FROM message WHERE session_id IN (${scope}) AND json_extract(data, '$.role') = 'assistant') as total_cost
`;
}

function buildSessionsQuery(projectId: string): string {
  return `
SELECT
  s.id, s.title, s.directory,
  s.summary_additions, s.summary_deletions, s.summary_files,
  s.time_created, s.time_updated,
  (SELECT COUNT(*) FROM message WHERE session_id = s.id) as msg_count,
  (SELECT COUNT(*) FROM message WHERE session_id = s.id AND json_extract(data, '$.role') = 'user') as user_msgs,
  (SELECT COUNT(*) FROM message WHERE session_id = s.id AND json_extract(data, '$.role') = 'assistant') as asst_msgs,
  (SELECT COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) FROM message WHERE session_id = s.id AND json_extract(data, '$.role') = 'assistant') as output_tokens,
  (SELECT GROUP_CONCAT(agent_model, ', ') FROM (
    SELECT json_extract(m2.data, '$.agent') || ':' || REPLACE(REPLACE(json_extract(m2.data, '$.modelID'), 'claude-', ''), '-preview', '') as agent_model
    FROM message m2
    WHERE m2.session_id IN (s.id, (SELECT id FROM session WHERE parent_id = s.id))
      AND json_extract(m2.data, '$.role') = 'assistant'
      AND json_extract(m2.data, '$.agent') IS NOT NULL
    GROUP BY json_extract(m2.data, '$.agent'), json_extract(m2.data, '$.modelID')
    ORDER BY COUNT(*) DESC
  )) as agents
FROM session s
WHERE s.parent_id IS NULL AND s.project_id = '${projectId}'
ORDER BY s.time_updated DESC
LIMIT 20
`;
}

function buildModelQuery(projectId: string): string {
  const scope = sessionScope(projectId);
  return `
SELECT
  json_extract(data, '$.modelID') as model,
  json_extract(data, '$.providerID') as provider,
  COUNT(*) as cnt,
  COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as total_output
FROM message
WHERE session_id IN (${scope})
  AND json_extract(data, '$.role') = 'assistant'
  AND json_extract(data, '$.modelID') IS NOT NULL
GROUP BY model, provider
ORDER BY cnt DESC
`;
}

function buildToolQuery(projectId: string): string {
  const scope = sessionScope(projectId);
  return `
SELECT
  json_extract(data, '$.tool') as tool_name,
  COUNT(*) as cnt
FROM part
WHERE session_id IN (${scope})
  AND json_extract(data, '$.type') = 'tool'
  AND json_extract(data, '$.tool') IS NOT NULL
GROUP BY tool_name
ORDER BY cnt DESC
LIMIT 15
`;
}

// ─── Helpers ───────────────────────────────────────────────────

async function querySqlite(query: string, params: unknown[] = []): Promise<SqlRow[]> {
  const dbPath = await getDbPath();
  return invoke('query_sqlite', { dbPath, query, params });
}

/** Format a number with K/M/B suffix */
function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** Format a dollar amount */
function formatCost(n: number): string {
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  if (n > 0) return '$' + n.toFixed(4);
  return '$0.00';
}

/** Relative time string from epoch ms */
function relativeTime(epochMs: number): string {
  const now = Date.now();
  const diff = now - epochMs;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return Math.floor(days / 30) + 'mo ago';
  if (days > 0) return days + 'd ago';
  if (hours > 0) return hours + 'h ago';
  if (minutes > 0) return minutes + 'm ago';
  return 'just now';
}

/** Duration string from two epoch ms timestamps */
function durationStr(startMs: number, endMs: number): string {
  const diff = endMs - startMs;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

/** Abbreviate a directory path */
function abbreviateDir(dir: string): string {
  let p = dir;
  const homeMatch = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (homeMatch) {
    p = '~' + p.slice(homeMatch[1].length);
  }
  if (p.length > 30) {
    const parts = p.split('/').filter(Boolean);
    if (parts.length > 2) {
      const prefix = p.startsWith('~') ? '' : '/';
      p = `${prefix}${parts[0]}/.../` + parts.slice(-1).join('/');
    }
  }
  return p;
}

// ─── Rendering ─────────────────────────────────────────────────

function renderProjectHeader(container: HTMLElement, dir: string): void {
  const el = document.createElement('div');
  el.className = 'krypton-oc__project-header';
  el.textContent = abbreviateDir(dir);
  container.appendChild(el);
}

function renderOverview(container: HTMLElement, overview: OcOverview): void {
  const section = document.createElement('div');
  section.className = 'krypton-oc__overview';

  const stats = [
    { label: 'Sessions', value: formatNumber(overview.totalSessions), cls: 'sessions' },
    { label: 'Messages', value: formatNumber(overview.totalMessages), cls: 'messages' },
    { label: 'Output Tokens', value: formatNumber(overview.totalTokensOutput), cls: 'tokens' },
    { label: 'Cache Read', value: formatNumber(overview.totalCacheRead), cls: 'cache' },
    { label: 'Cost', value: formatCost(overview.totalCost), cls: 'cost' },
  ];

  for (const s of stats) {
    const card = document.createElement('div');
    card.className = `krypton-oc__stat krypton-oc__stat--${s.cls}`;

    const value = document.createElement('div');
    value.className = 'krypton-oc__stat-value';
    value.textContent = s.value;

    const label = document.createElement('div');
    label.className = 'krypton-oc__stat-label';
    label.textContent = s.label;

    card.appendChild(value);
    card.appendChild(label);
    section.appendChild(card);
  }

  container.appendChild(section);
}

function renderSessions(container: HTMLElement, sessions: OcSession[]): void {
  const section = document.createElement('div');
  section.className = 'krypton-dashboard__section';

  const title = document.createElement('div');
  title.className = 'krypton-dashboard__section-title';
  title.textContent = `Recent Sessions (${sessions.length})`;
  section.appendChild(title);

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'krypton-dashboard__empty';
    empty.textContent = 'No sessions for this project';
    section.appendChild(empty);
    container.appendChild(section);
    return;
  }

  const table = document.createElement('div');
  table.className = 'krypton-oc__sessions';

  // Header
  const header = document.createElement('div');
  header.className = 'krypton-oc__session-row krypton-oc__session-row--header';
  for (const col of ['Title', 'Agent / Model', 'Msgs', 'Tokens', '+/-', 'Duration', 'Updated']) {
    const cell = document.createElement('div');
    cell.className = 'krypton-oc__session-cell';
    cell.textContent = col;
    header.appendChild(cell);
  }
  table.appendChild(header);

  // Rows
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'krypton-oc__session-row';

    const titleCell = document.createElement('div');
    titleCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--title';
    titleCell.textContent = s.title || '(untitled)';
    titleCell.title = s.title;

    const msgsCell = document.createElement('div');
    msgsCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--num';
    msgsCell.textContent = String(s.msgCount);

    const tokensCell = document.createElement('div');
    tokensCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--num';
    tokensCell.textContent = formatNumber(s.outputTokens);

    const diffCell = document.createElement('div');
    diffCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--diff';
    const adds = s.additions || 0;
    const dels = s.deletions || 0;
    if (adds > 0 || dels > 0) {
      const addSpan = document.createElement('span');
      addSpan.className = 'krypton-oc__diff-add';
      addSpan.textContent = `+${adds}`;
      const delSpan = document.createElement('span');
      delSpan.className = 'krypton-oc__diff-del';
      delSpan.textContent = `-${dels}`;
      diffCell.appendChild(addSpan);
      diffCell.appendChild(document.createTextNode(' '));
      diffCell.appendChild(delSpan);
    } else {
      diffCell.textContent = '-';
    }

    const durationCell = document.createElement('div');
    durationCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--num';
    durationCell.textContent = durationStr(s.timeCreated, s.timeUpdated);

    const updatedCell = document.createElement('div');
    updatedCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--time';
    updatedCell.textContent = relativeTime(s.timeUpdated);

    const agentsCell = document.createElement('div');
    agentsCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--agents';
    agentsCell.textContent = s.agents || '-';
    agentsCell.title = s.agents;

    row.appendChild(titleCell);
    row.appendChild(agentsCell);
    row.appendChild(msgsCell);
    row.appendChild(tokensCell);
    row.appendChild(diffCell);
    row.appendChild(durationCell);
    row.appendChild(updatedCell);
    table.appendChild(row);
  }

  section.appendChild(table);
  container.appendChild(section);
}

function renderModelUsage(container: HTMLElement, models: OcModelUsage[]): void {
  const section = document.createElement('div');
  section.className = 'krypton-dashboard__section';

  const title = document.createElement('div');
  title.className = 'krypton-dashboard__section-title';
  title.textContent = 'Models';
  section.appendChild(title);

  const list = document.createElement('div');
  list.className = 'krypton-oc__usage-list';

  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'krypton-oc__usage-row';

    const name = document.createElement('div');
    name.className = 'krypton-oc__usage-name';
    name.textContent = m.model;

    const provider = document.createElement('div');
    provider.className = 'krypton-oc__usage-provider';
    provider.textContent = m.provider;

    const count = document.createElement('div');
    count.className = 'krypton-oc__usage-count';
    count.textContent = formatNumber(m.count) + ' msgs';

    const tokens = document.createElement('div');
    tokens.className = 'krypton-oc__usage-tokens';
    tokens.textContent = formatNumber(m.totalOutput) + ' out';

    row.appendChild(name);
    row.appendChild(provider);
    row.appendChild(count);
    row.appendChild(tokens);
    list.appendChild(row);
  }

  section.appendChild(list);
  container.appendChild(section);
}

function renderToolUsage(container: HTMLElement, tools: OcToolUsage[]): void {
  const section = document.createElement('div');
  section.className = 'krypton-dashboard__section';

  const title = document.createElement('div');
  title.className = 'krypton-dashboard__section-title';
  title.textContent = 'Tool Usage (Top 15)';
  section.appendChild(title);

  const list = document.createElement('div');
  list.className = 'krypton-oc__usage-list';

  // Find max for bar width calculation
  const maxCount = tools.length > 0 ? tools[0].count : 1;

  for (const t of tools) {
    const row = document.createElement('div');
    row.className = 'krypton-oc__tool-row';

    const name = document.createElement('div');
    name.className = 'krypton-oc__tool-name';
    name.textContent = t.tool;

    const barContainer = document.createElement('div');
    barContainer.className = 'krypton-oc__tool-bar-container';

    const bar = document.createElement('div');
    bar.className = 'krypton-oc__tool-bar';
    bar.style.width = `${Math.max(2, (t.count / maxCount) * 100)}%`;
    barContainer.appendChild(bar);

    const count = document.createElement('div');
    count.className = 'krypton-oc__tool-count';
    count.textContent = formatNumber(t.count);

    row.appendChild(name);
    row.appendChild(barContainer);
    row.appendChild(count);
    list.appendChild(row);
  }

  section.appendChild(list);
  container.appendChild(section);
}

// ─── Dashboard Definition ──────────────────────────────────────

export function createOpenCodeDashboard(compositor: Compositor): DashboardDefinition {
  let currentContainer: HTMLElement | null = null;
  let renderGen = 0;

  async function loadAndRender(container: HTMLElement): Promise<void> {
    const gen = ++renderGen;
    container.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'krypton-dashboard__loading';
    loading.textContent = 'Loading OpenCode data...';
    container.appendChild(loading);

    try {
      // Resolve project from focused terminal's CWD
      const sessionId = compositor.getFocusedSessionId();
      if (sessionId === null) {
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'krypton-dashboard__empty';
        err.textContent = 'No active terminal session';
        container.appendChild(err);
        return;
      }

      const cwd: string | null = await invoke('get_pty_cwd', { sessionId });
      if (!cwd) {
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'krypton-dashboard__empty';
        err.textContent = 'Could not determine terminal working directory';
        container.appendChild(err);
        return;
      }

      if (gen !== renderGen) return;

      // Look up project_id for this CWD
      const projectRows = await querySqlite(QUERY_PROJECT_ID, [cwd]);
      if (gen !== renderGen) return;

      if (projectRows.length === 0) {
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'krypton-dashboard__empty';
        err.textContent = `No OpenCode project found for ${abbreviateDir(cwd)}`;
        container.appendChild(err);
        return;
      }

      const projectId = String(projectRows[0].id);

      // Phase 1: Fast queries in parallel (overview, sessions, models — all <0.5s)
      const [overviewRows, sessionRows, modelRows] = await Promise.all([
        querySqlite(buildOverviewQuery(projectId)),
        querySqlite(buildSessionsQuery(projectId)),
        querySqlite(buildModelQuery(projectId)),
      ]);

      if (gen !== renderGen) return;

      container.innerHTML = '';

      // Project header
      renderProjectHeader(container, cwd);

      // Overview stats
      if (overviewRows.length > 0) {
        const r = overviewRows[0];
        renderOverview(container, {
          totalSessions: Number(r.total_sessions ?? 0),
          totalMessages: Number(r.total_messages ?? 0),
          totalTokensOutput: Number(r.total_output ?? 0),
          totalCacheRead: Number(r.total_cache_read ?? 0),
          totalCost: Number(r.total_cost ?? 0),
        });
      }

      // Sessions table
      const sessions: OcSession[] = sessionRows.map((r) => ({
        id: String(r.id ?? ''),
        title: String(r.title ?? ''),
        directory: String(r.directory ?? ''),
        timeCreated: Number(r.time_created ?? 0),
        timeUpdated: Number(r.time_updated ?? 0),
        msgCount: Number(r.msg_count ?? 0),
        userMsgs: Number(r.user_msgs ?? 0),
        asstMsgs: Number(r.asst_msgs ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        additions: Number(r.summary_additions ?? 0),
        deletions: Number(r.summary_deletions ?? 0),
        files: Number(r.summary_files ?? 0),
        agents: String(r.agents ?? ''),
      }));
      renderSessions(container, sessions);

      // Usage breakdown: two-column layout
      const breakdown = document.createElement('div');
      breakdown.className = 'krypton-oc__breakdown';

      const modelsCol = document.createElement('div');
      modelsCol.className = 'krypton-oc__breakdown-col';
      const models: OcModelUsage[] = modelRows.map((r) => ({
        model: String(r.model ?? ''),
        provider: String(r.provider ?? ''),
        count: Number(r.cnt ?? 0),
        totalOutput: Number(r.total_output ?? 0),
      }));
      renderModelUsage(modelsCol, models);

      // Tools: show loading placeholder, load async (can be slow for large projects)
      const toolsCol = document.createElement('div');
      toolsCol.className = 'krypton-oc__breakdown-col';
      const toolsPlaceholder = document.createElement('div');
      toolsPlaceholder.className = 'krypton-dashboard__section';
      const toolsTitle = document.createElement('div');
      toolsTitle.className = 'krypton-dashboard__section-title';
      toolsTitle.textContent = 'Tool Usage (Top 15)';
      const toolsSpinner = document.createElement('div');
      toolsSpinner.className = 'krypton-dashboard__loading';
      toolsSpinner.textContent = 'Loading tool stats\u2026';
      toolsPlaceholder.appendChild(toolsTitle);
      toolsPlaceholder.appendChild(toolsSpinner);
      toolsCol.appendChild(toolsPlaceholder);

      breakdown.appendChild(modelsCol);
      breakdown.appendChild(toolsCol);
      container.appendChild(breakdown);

      // Phase 2: Slow tool query in background
      querySqlite(buildToolQuery(projectId)).then((toolRows) => {
        if (gen !== renderGen) return;
        const tools: OcToolUsage[] = toolRows.map((r) => ({
          tool: String(r.tool_name ?? ''),
          count: Number(r.cnt ?? 0),
        }));
        toolsCol.innerHTML = '';
        renderToolUsage(toolsCol, tools);
      }).catch((toolErr) => {
        if (gen !== renderGen) return;
        toolsCol.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.className = 'krypton-dashboard__error';
        errEl.textContent = `Tool stats error: ${toolErr}`;
        toolsCol.appendChild(errEl);
      });

      // Hint
      const hint = document.createElement('div');
      hint.className = 'krypton-oc__hint';
      hint.textContent = 'Press r to refresh \u00b7 Esc to close';
      container.appendChild(hint);
    } catch (err) {
      if (gen !== renderGen) return;
      container.innerHTML = '';
      const errEl = document.createElement('div');
      errEl.className = 'krypton-dashboard__error';
      errEl.textContent = `OpenCode error: ${err}`;
      container.appendChild(errEl);
    }
  }

  return {
    id: 'opencode',
    title: 'OpenCode',
    shortcut: { key: 'KeyO', meta: true, shift: true },

    onOpen(container: HTMLElement): void {
      currentContainer = container;
      loadAndRender(container);
    },

    onClose(): void {
      currentContainer = null;
    },

    onKeyDown(e: KeyboardEvent): boolean {
      // r — refresh
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (currentContainer) {
          loadAndRender(currentContainer);
        }
        return true;
      }
      return false;
    },
  };
}
