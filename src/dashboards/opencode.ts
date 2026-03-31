// Krypton — OpenCode Dashboard
// Overlay showing OpenCode session history, token usage, model distribution,
// and tool usage from the local SQLite database, scoped to the focused
// terminal's project. Organized into keyboard-navigable tabs.
// Toggled via Cmd+Shift+O.

import { invoke } from '../profiler/ipc';
import type { DashboardDefinition, DashboardTab } from '../types';
import type { Compositor } from '../compositor';

/** Cached resolved path to the OpenCode SQLite database */
let resolvedDbPath: string | null = null;

async function getDbPath(): Promise<string> {
  if (resolvedDbPath) return resolvedDbPath;
  const homeOutput: string = await invoke('run_command', {
    program: 'sh', args: ['-c', 'echo $HOME'], cwd: null,
  });
  resolvedDbPath = `${homeOutput.trim()}/.local/share/opencode/opencode.db`;
  return resolvedDbPath;
}

// ─── Types ─────────────────────────────────────────────────────

type SqlRow = Record<string, unknown>;

interface OcSession {
  id: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  msgCount: number;
  outputTokens: number;
  additions: number;
  deletions: number;
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

/** All loaded data for the dashboard */
interface OcData {
  cwd: string;
  overview: OcOverview;
  sessions: OcSession[];
  models: OcModelUsage[];
  tools: OcToolUsage[] | null; // null = still loading
}

// ─── Queries ───────────────────────────────────────────────────

const QUERY_PROJECT_ID = `SELECT id FROM project WHERE worktree = ?1 LIMIT 1`;

function scope(pid: string): string { return `SELECT id FROM session WHERE project_id = '${pid}'`; }

function qOverview(pid: string): string {
  const s = scope(pid);
  return `SELECT
    (SELECT COUNT(*) FROM session WHERE parent_id IS NULL AND project_id = '${pid}') as total_sessions,
    (SELECT COUNT(*) FROM message WHERE session_id IN (${s})) as total_messages,
    (SELECT COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) FROM message WHERE session_id IN (${s}) AND json_extract(data, '$.role') = 'assistant') as total_output,
    (SELECT COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) FROM message WHERE session_id IN (${s}) AND json_extract(data, '$.role') = 'assistant') as total_cache_read,
    (SELECT COALESCE(SUM(json_extract(data, '$.cost')), 0) FROM message WHERE session_id IN (${s}) AND json_extract(data, '$.role') = 'assistant') as total_cost`;
}

function qSessions(pid: string): string {
  return `SELECT s.id, s.title, s.summary_additions, s.summary_deletions, s.time_created, s.time_updated,
    (SELECT COUNT(*) FROM message WHERE session_id = s.id) as msg_count,
    (SELECT COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) FROM message WHERE session_id = s.id AND json_extract(data, '$.role') = 'assistant') as output_tokens,
    (SELECT GROUP_CONCAT(am, ', ') FROM (
      SELECT json_extract(m2.data, '$.agent') || ':' || REPLACE(REPLACE(json_extract(m2.data, '$.modelID'), 'claude-', ''), '-preview', '') as am
      FROM message m2 WHERE m2.session_id IN (s.id, (SELECT id FROM session WHERE parent_id = s.id))
        AND json_extract(m2.data, '$.role') = 'assistant' AND json_extract(m2.data, '$.agent') IS NOT NULL
      GROUP BY json_extract(m2.data, '$.agent'), json_extract(m2.data, '$.modelID') ORDER BY COUNT(*) DESC
    )) as agents
  FROM session s WHERE s.parent_id IS NULL AND s.project_id = '${pid}' ORDER BY s.time_updated DESC LIMIT 30`;
}

function qModels(pid: string): string {
  const s = scope(pid);
  return `SELECT json_extract(data, '$.modelID') as model, json_extract(data, '$.providerID') as provider,
    COUNT(*) as cnt, COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as total_output
  FROM message WHERE session_id IN (${s}) AND json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.modelID') IS NOT NULL GROUP BY model, provider ORDER BY cnt DESC`;
}

function qTools(pid: string): string {
  const s = scope(pid);
  return `SELECT json_extract(data, '$.tool') as tool_name, COUNT(*) as cnt
  FROM part WHERE session_id IN (${s}) AND json_extract(data, '$.type') = 'tool'
    AND json_extract(data, '$.tool') IS NOT NULL GROUP BY tool_name ORDER BY cnt DESC LIMIT 15`;
}

// ─── Helpers ───────────────────────────────────────────────────

async function querySqlite(query: string, params: unknown[] = []): Promise<SqlRow[]> {
  const dbPath = await getDbPath();
  return invoke('query_sqlite', { dbPath, query, params });
}

function fmtNum(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n: number): string {
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  if (n > 0) return '$' + n.toFixed(4);
  return '$0.00';
}

function relTime(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  const h = Math.floor(m / 60);
  const dy = Math.floor(h / 24);
  if (dy > 30) return Math.floor(dy / 30) + 'mo ago';
  if (dy > 0) return dy + 'd ago';
  if (h > 0) return h + 'h ago';
  if (m > 0) return m + 'm ago';
  return 'just now';
}

function duration(s: number, e: number): string {
  const m = Math.floor((e - s) / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

function abbrDir(dir: string): string {
  let p = dir;
  const hm = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (hm) p = '~' + p.slice(hm[1].length);
  return p;
}

// ─── Tab Renderers ─────────────────────────────────────────────

function renderOverviewTab(container: HTMLElement, data: OcData): void {
  container.innerHTML = '';

  // Project path
  const projEl = document.createElement('div');
  projEl.className = 'krypton-oc__project-header';
  projEl.textContent = abbrDir(data.cwd);
  container.appendChild(projEl);

  // Stat cards
  const statsEl = document.createElement('div');
  statsEl.className = 'krypton-oc__overview';
  const cards = [
    { label: 'Sessions', value: fmtNum(data.overview.totalSessions), cls: 'sessions' },
    { label: 'Messages', value: fmtNum(data.overview.totalMessages), cls: 'messages' },
    { label: 'Output Tokens', value: fmtNum(data.overview.totalTokensOutput), cls: 'tokens' },
    { label: 'Cache Read', value: fmtNum(data.overview.totalCacheRead), cls: 'cache' },
    { label: 'Cost', value: fmtCost(data.overview.totalCost), cls: 'cost' },
  ];
  for (const c of cards) {
    const card = document.createElement('div');
    card.className = `krypton-oc__stat krypton-oc__stat--${c.cls}`;
    const v = document.createElement('div');
    v.className = 'krypton-oc__stat-value';
    v.textContent = c.value;
    const l = document.createElement('div');
    l.className = 'krypton-oc__stat-label';
    l.textContent = c.label;
    card.appendChild(v);
    card.appendChild(l);
    statsEl.appendChild(card);
  }
  container.appendChild(statsEl);

  // Models list — fills remaining space
  const modelsSection = document.createElement('div');
  modelsSection.className = 'krypton-dashboard__section';
  modelsSection.style.flex = '1';
  modelsSection.style.display = 'flex';
  modelsSection.style.flexDirection = 'column';
  modelsSection.style.overflow = 'hidden';

  const modelsTitle = document.createElement('div');
  modelsTitle.className = 'krypton-dashboard__section-title';
  modelsTitle.textContent = 'Models';
  modelsSection.appendChild(modelsTitle);

  const modelsList = document.createElement('div');
  modelsList.className = 'krypton-oc__usage-list';
  modelsList.style.flex = '1';

  for (const m of data.models) {
    const row = document.createElement('div');
    row.className = 'krypton-oc__usage-row';
    const name = document.createElement('div');
    name.className = 'krypton-oc__usage-name';
    name.textContent = m.model;
    const prov = document.createElement('div');
    prov.className = 'krypton-oc__usage-provider';
    prov.textContent = m.provider;
    const cnt = document.createElement('div');
    cnt.className = 'krypton-oc__usage-count';
    cnt.textContent = fmtNum(m.count) + ' msgs';
    const tok = document.createElement('div');
    tok.className = 'krypton-oc__usage-tokens';
    tok.textContent = fmtNum(m.totalOutput) + ' out';
    row.appendChild(name);
    row.appendChild(prov);
    row.appendChild(cnt);
    row.appendChild(tok);
    modelsList.appendChild(row);
  }
  modelsSection.appendChild(modelsList);
  container.appendChild(modelsSection);

  // Bottom hint
  const hint = document.createElement('div');
  hint.className = 'krypton-oc__hint';
  hint.textContent = 'r refresh \u00b7 [/] or 1-3 switch tabs \u00b7 Esc close';
  container.appendChild(hint);
}

function renderSessionsTab(container: HTMLElement, data: OcData): void {
  container.innerHTML = '';

  if (data.sessions.length === 0) {
    const el = document.createElement('div');
    el.className = 'krypton-dashboard__empty';
    el.textContent = 'No sessions for this project';
    container.appendChild(el);
    return;
  }

  // Table fills entire content area
  const table = document.createElement('div');
  table.className = 'krypton-oc__sessions';
  table.style.flex = '1';
  table.style.display = 'flex';
  table.style.flexDirection = 'column';
  table.style.overflow = 'hidden';

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

  // Rows container with overflow
  const rows = document.createElement('div');
  rows.className = 'krypton-oc__session-rows';
  rows.style.flex = '1';
  rows.style.overflowY = 'auto';

  for (const s of data.sessions) {
    const row = document.createElement('div');
    row.className = 'krypton-oc__session-row';

    const titleCell = document.createElement('div');
    titleCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--title';
    titleCell.textContent = s.title || '(untitled)';
    titleCell.title = s.title;

    const agentsCell = document.createElement('div');
    agentsCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--agents';
    agentsCell.textContent = s.agents || '-';
    agentsCell.title = s.agents;

    const msgsCell = document.createElement('div');
    msgsCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--num';
    msgsCell.textContent = String(s.msgCount);

    const tokensCell = document.createElement('div');
    tokensCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--num';
    tokensCell.textContent = fmtNum(s.outputTokens);

    const diffCell = document.createElement('div');
    diffCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--diff';
    const adds = s.additions || 0;
    const dels = s.deletions || 0;
    if (adds > 0 || dels > 0) {
      const a = document.createElement('span');
      a.className = 'krypton-oc__diff-add';
      a.textContent = `+${adds}`;
      const d = document.createElement('span');
      d.className = 'krypton-oc__diff-del';
      d.textContent = `-${dels}`;
      diffCell.appendChild(a);
      diffCell.appendChild(document.createTextNode(' '));
      diffCell.appendChild(d);
    } else {
      diffCell.textContent = '-';
    }

    const durCell = document.createElement('div');
    durCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--num';
    durCell.textContent = duration(s.timeCreated, s.timeUpdated);

    const updCell = document.createElement('div');
    updCell.className = 'krypton-oc__session-cell krypton-oc__session-cell--time';
    updCell.textContent = relTime(s.timeUpdated);

    row.appendChild(titleCell);
    row.appendChild(agentsCell);
    row.appendChild(msgsCell);
    row.appendChild(tokensCell);
    row.appendChild(diffCell);
    row.appendChild(durCell);
    row.appendChild(updCell);
    rows.appendChild(row);
  }
  table.appendChild(rows);
  container.appendChild(table);

  const hint = document.createElement('div');
  hint.className = 'krypton-oc__hint';
  hint.textContent = 'r refresh \u00b7 [/] or 1-3 switch tabs \u00b7 Esc close';
  container.appendChild(hint);
}

function renderToolsTab(container: HTMLElement, data: OcData): void {
  container.innerHTML = '';

  if (data.tools === null) {
    const el = document.createElement('div');
    el.className = 'krypton-dashboard__loading';
    el.textContent = 'Loading tool stats\u2026';
    container.appendChild(el);
    return;
  }

  if (data.tools.length === 0) {
    const el = document.createElement('div');
    el.className = 'krypton-dashboard__empty';
    el.textContent = 'No tool usage data';
    container.appendChild(el);
    return;
  }

  const list = document.createElement('div');
  list.className = 'krypton-oc__usage-list';
  list.style.flex = '1';

  const maxCount = data.tools[0].count;
  for (const t of data.tools) {
    const row = document.createElement('div');
    row.className = 'krypton-oc__tool-row';

    const name = document.createElement('div');
    name.className = 'krypton-oc__tool-name';
    name.textContent = t.tool;

    const barC = document.createElement('div');
    barC.className = 'krypton-oc__tool-bar-container';
    const bar = document.createElement('div');
    bar.className = 'krypton-oc__tool-bar';
    bar.style.width = `${Math.max(2, (t.count / maxCount) * 100)}%`;
    barC.appendChild(bar);

    const cnt = document.createElement('div');
    cnt.className = 'krypton-oc__tool-count';
    cnt.textContent = fmtNum(t.count);

    row.appendChild(name);
    row.appendChild(barC);
    row.appendChild(cnt);
    list.appendChild(row);
  }
  container.appendChild(list);

  const hint = document.createElement('div');
  hint.className = 'krypton-oc__hint';
  hint.textContent = 'r refresh \u00b7 [/] or 1-3 switch tabs \u00b7 Esc close';
  container.appendChild(hint);
}

// ─── Dashboard Definition ──────────────────────────────────────

export function createOpenCodeDashboard(compositor: Compositor): DashboardDefinition {
  let data: OcData | null = null;
  let error: string | null = null;
  let renderGen = 0;
  let readyCb: (() => void) | null = null;

  const tabs: DashboardTab[] = [
    {
      label: 'Overview',
      render(container: HTMLElement) {
        if (error) { renderError(container, error); return; }
        if (!data) { renderLoading(container); return; }
        renderOverviewTab(container, data);
      },
    },
    {
      label: 'Sessions',
      render(container: HTMLElement) {
        if (error) { renderError(container, error); return; }
        if (!data) { renderLoading(container); return; }
        renderSessionsTab(container, data);
      },
    },
    {
      label: 'Tools',
      render(container: HTMLElement) {
        if (error) { renderError(container, error); return; }
        if (!data) { renderLoading(container); return; }
        renderToolsTab(container, data);
      },
    },
  ];

  function renderLoading(c: HTMLElement): void {
    c.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'krypton-dashboard__loading';
    el.textContent = 'Loading OpenCode data\u2026';
    c.appendChild(el);
  }

  function renderError(c: HTMLElement, msg: string): void {
    c.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'krypton-dashboard__error';
    el.textContent = msg;
    c.appendChild(el);
  }

  async function loadData(ready: () => void): Promise<void> {
    const gen = ++renderGen;
    data = null;
    error = null;

    // Resolve CWD
    const sessionId = compositor.getFocusedSessionId();
    if (sessionId === null) { error = 'No active terminal session'; ready(); return; }

    try {
      const cwd: string | null = await invoke('get_pty_cwd', { sessionId });
      if (!cwd) { error = 'Could not determine working directory'; ready(); return; }
      if (gen !== renderGen) return;

      const projectRows = await querySqlite(QUERY_PROJECT_ID, [cwd]);
      if (gen !== renderGen) return;
      if (projectRows.length === 0) { error = `No OpenCode project for ${abbrDir(cwd)}`; ready(); return; }

      const pid = String(projectRows[0].id);

      // Phase 1: fast queries
      const [ovRows, sessRows, modRows] = await Promise.all([
        querySqlite(qOverview(pid)),
        querySqlite(qSessions(pid)),
        querySqlite(qModels(pid)),
      ]);
      if (gen !== renderGen) return;

      const ov = ovRows[0] ?? {};
      data = {
        cwd,
        overview: {
          totalSessions: Number(ov.total_sessions ?? 0),
          totalMessages: Number(ov.total_messages ?? 0),
          totalTokensOutput: Number(ov.total_output ?? 0),
          totalCacheRead: Number(ov.total_cache_read ?? 0),
          totalCost: Number(ov.total_cost ?? 0),
        },
        sessions: sessRows.map((r) => ({
          id: String(r.id ?? ''),
          title: String(r.title ?? ''),
          timeCreated: Number(r.time_created ?? 0),
          timeUpdated: Number(r.time_updated ?? 0),
          msgCount: Number(r.msg_count ?? 0),
          outputTokens: Number(r.output_tokens ?? 0),
          additions: Number(r.summary_additions ?? 0),
          deletions: Number(r.summary_deletions ?? 0),
          agents: String(r.agents ?? ''),
        })),
        models: modRows.map((r) => ({
          model: String(r.model ?? ''),
          provider: String(r.provider ?? ''),
          count: Number(r.cnt ?? 0),
          totalOutput: Number(r.total_output ?? 0),
        })),
        tools: null, // loading async
      };

      // Signal ready — tabs can render overview/sessions now
      ready();

      // Phase 2: slow tool query in background
      try {
        const toolRows = await querySqlite(qTools(pid));
        if (gen !== renderGen || !data) return;
        data.tools = toolRows.map((r) => ({
          tool: String(r.tool_name ?? ''),
          count: Number(r.cnt ?? 0),
        }));
        // Re-render the tools tab if it's currently active
        const content = document.querySelector('.krypton-dashboard__content') as HTMLElement | null;
        if (content) {
          // Find which tab is active — check if Tools tab is showing the loading spinner
          const loadingEl = content.querySelector('.krypton-dashboard__loading');
          if (loadingEl) {
            renderToolsTab(content, data);
          }
        }
      } catch (toolErr) {
        if (gen !== renderGen || !data) return;
        data.tools = [];
      }
    } catch (err) {
      if (gen !== renderGen) return;
      error = `OpenCode error: ${err}`;
      ready();
    }
  }

  return {
    id: 'opencode',
    title: 'OpenCode',
    shortcut: { key: 'KeyO', meta: true, shift: true },
    tabs,

    onOpen(ready: () => void): void {
      readyCb = ready;
      loadData(ready);
    },

    onClose(): void {
      data = null;
      error = null;
      readyCb = null;
    },

    onKeyDown(e: KeyboardEvent): boolean {
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (readyCb) {
          loadData(readyCb);
        }
        return true;
      }
      return false;
    },
  };
}
