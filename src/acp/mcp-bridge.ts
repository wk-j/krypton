// Krypton — Cross-lane MCP bridge.
//
// Reads `<projectDir>/.mcp.json` (Anthropic's project-scope MCP config),
// expands `${VAR}` / `${VAR:-default}` placeholders against the cached
// login-shell env, and translates Claude's object-shaped `env`/`headers`
// fields into the array shape ACP's `session/new` expects.
//
// See docs/83-acp-shared-mcp-config.md.

import { invoke } from '@tauri-apps/api/core';

import type {
  AcpMcpCapabilities,
  AcpMcpServerDescriptor,
  AcpMcpServerHttp,
  AcpMcpServerSse,
  AcpMcpServerStdio,
} from './types';

interface ClaudeMcpStdio {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ClaudeMcpHttp {
  type?: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

type ClaudeMcpServer = ClaudeMcpStdio | ClaudeMcpHttp;

export interface ClaudeMcpFile {
  mcpServers?: Record<string, ClaudeMcpServer>;
}

// Cline's `cline_mcp_settings.json` discriminates transport on an explicit
// `type` field and maps a URL-only entry to `sse` by default — so an http
// server MUST be tagged `streamableHttp` or it connects as SSE and fails.
// Verified against cline 3.0.24 (`type` enum: stdio | sse | streamableHttp).
interface ClineMcpStdio {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ClineMcpRemote {
  type: 'streamableHttp' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

type ClineMcpServer = ClineMcpStdio | ClineMcpRemote;

export interface ClineMcpFile {
  mcpServers: Record<string, ClineMcpServer>;
}

/** Junie advertises http+sse in ACP; used when building overlays before initialize. */
export const JUNIE_MCP_CAPABILITIES: AcpMcpCapabilities = { http: true, sse: true };

let loginEnvPromise: Promise<Record<string, string>> | null = null;
const projectCache = new Map<string, AcpMcpServerDescriptor[]>();

interface RemoteRunResult {
  success: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function remoteRequest<T>(runtimeId: string, method: string, params: Record<string, unknown>): Promise<T> {
  return invoke<T>('remote_harness_request', { runtimeId, method, params });
}

function loadLoginEnv(): Promise<Record<string, string>> {
  if (!loginEnvPromise) {
    loginEnvPromise = invoke<Record<string, string>>('acp_login_env').catch((e) => {
      console.warn('[mcp-bridge] acp_login_env failed:', e);
      return {};
    });
  }
  return loginEnvPromise;
}

async function loadReferencedRemoteEnv(
  runtimeId: string,
  projectDir: string,
  source: string,
): Promise<Record<string, string>> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-.*?)?\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  const env: Record<string, string> = {};
  await Promise.all(Array.from(names).map(async (name) => {
    try {
      const result = await remoteRequest<RemoteRunResult>(runtimeId, 'run', {
        program: 'printenv',
        args: [name],
        cwd: projectDir,
      });
      if (result.success) env[name] = result.stdout.replace(/\r?\n$/, '');
    } catch {
      // Missing variables stay absent so `${VAR:-default}` and required-var
      // behavior remain identical to the local bridge.
    }
  }));
  return env;
}

/** Expand `${VAR}` and `${VAR:-default}`. Returns null if a required var is
 *  unset (no `:-default`), so the caller can skip the offending server
 *  entirely instead of injecting an unresolved placeholder. */
function expand(input: string, env: Record<string, string>): string | null {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const dollar = input.indexOf('${', i);
    if (dollar < 0) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, dollar);
    const close = input.indexOf('}', dollar + 2);
    if (close < 0) {
      // Malformed — leave the rest as-is.
      out += input.slice(dollar);
      break;
    }
    const expr = input.slice(dollar + 2, close);
    const colonDash = expr.indexOf(':-');
    let name: string;
    let fallback: string | null = null;
    if (colonDash >= 0) {
      name = expr.slice(0, colonDash);
      fallback = expr.slice(colonDash + 2);
    } else {
      name = expr;
    }
    const v = env[name];
    if (v !== undefined && v !== '') {
      out += v;
    } else if (fallback !== null) {
      out += fallback;
    } else {
      return null;
    }
    i = close + 1;
  }
  return out;
}

function expandAll(values: string[], env: Record<string, string>): string[] | null {
  const out: string[] = [];
  for (const v of values) {
    const e = expand(v, env);
    if (e === null) return null;
    out.push(e);
  }
  return out;
}

function objectToPairs(
  obj: Record<string, string> | undefined,
  env: Record<string, string>,
): Array<{ name: string; value: string }> | null {
  if (!obj) return [];
  const pairs: Array<{ name: string; value: string }> = [];
  for (const [name, raw] of Object.entries(obj)) {
    if (typeof raw !== 'string') continue;
    const value = expand(raw, env);
    if (value === null) return null;
    pairs.push({ name, value });
  }
  return pairs;
}

function translate(
  name: string,
  server: ClaudeMcpServer,
  env: Record<string, string>,
): AcpMcpServerDescriptor | null {
  const type = server.type ?? 'stdio';
  if (type === 'stdio') {
    const stdio = server as ClaudeMcpStdio;
    if (typeof stdio.command !== 'string' || !stdio.command) {
      console.warn(`[mcp-bridge] skip "${name}": missing command`);
      return null;
    }
    const command = expand(stdio.command, env);
    if (command === null) {
      console.warn(`[mcp-bridge] skip "${name}": unresolved \${VAR} in command`);
      return null;
    }
    const args = expandAll(stdio.args ?? [], env);
    if (args === null) {
      console.warn(`[mcp-bridge] skip "${name}": unresolved \${VAR} in args`);
      return null;
    }
    const envPairs = objectToPairs(stdio.env, env);
    if (envPairs === null) {
      console.warn(`[mcp-bridge] skip "${name}": unresolved \${VAR} in env`);
      return null;
    }
    const out: AcpMcpServerStdio = { name, type: 'stdio', command, args, env: envPairs };
    return out;
  }
  if (type === 'http' || type === 'sse') {
    const http = server as ClaudeMcpHttp;
    if (typeof http.url !== 'string' || !http.url) {
      console.warn(`[mcp-bridge] skip "${name}": missing url`);
      return null;
    }
    const url = expand(http.url, env);
    if (url === null) {
      console.warn(`[mcp-bridge] skip "${name}": unresolved \${VAR} in url`);
      return null;
    }
    const headers = objectToPairs(http.headers, env);
    if (headers === null) {
      console.warn(`[mcp-bridge] skip "${name}": unresolved \${VAR} in headers`);
      return null;
    }
    if (type === 'http') {
      const out: AcpMcpServerHttp = { name, type: 'http', url, headers };
      return out;
    }
    const out: AcpMcpServerSse = { name, type: 'sse', url, headers };
    return out;
  }
  console.warn(`[mcp-bridge] skip "${name}": unknown type "${type}"`);
  return null;
}

/** Read & translate `<projectDir>/.mcp.json` into ACP `McpServer[]` form.
 *  Returns `[]` if the file is missing, malformed, or unreadable — the bridge
 *  is best-effort and never throws. Memoized per `projectDir` for the harness
 *  lifetime; call `invalidateMcpBridgeCache(projectDir?)` on project change. */
export async function loadProjectMcpServers(
  projectDir: string | null | undefined,
  remoteRuntimeId?: string | null,
): Promise<AcpMcpServerDescriptor[]> {
  if (!projectDir) return [];
  const cacheKey = `${remoteRuntimeId ?? 'local'}:${projectDir}`;
  const cached = projectCache.get(cacheKey);
  if (cached) return cached;

  const path = `${projectDir.replace(/\/$/, '')}/.mcp.json`;
  let raw: string | null;
  try {
    if (remoteRuntimeId) {
      const response = await remoteRequest<{ exists: boolean; content: string }>(
        remoteRuntimeId,
        'read',
        { path },
      );
      raw = response.exists ? response.content : null;
    } else {
      raw = await invoke<string | null>('read_mcp_config_file', { path });
    }
  } catch (e) {
    console.warn(`[mcp-bridge] read failed: ${String(e)}`);
    projectCache.set(cacheKey, []);
    return [];
  }
  if (!raw) {
    projectCache.set(cacheKey, []);
    return [];
  }

  let parsed: ClaudeMcpFile;
  try {
    parsed = JSON.parse(raw) as ClaudeMcpFile;
  } catch (e) {
    console.warn(`[mcp-bridge] ${path}: invalid JSON: ${String(e)}`);
    projectCache.set(cacheKey, []);
    return [];
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object') {
    projectCache.set(cacheKey, []);
    return [];
  }

  const env = remoteRuntimeId
    ? await loadReferencedRemoteEnv(remoteRuntimeId, projectDir, raw)
    : await loadLoginEnv();
  const result: AcpMcpServerDescriptor[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    const descriptor = translate(name, server as ClaudeMcpServer, env);
    if (descriptor) result.push(descriptor);
  }
  projectCache.set(cacheKey, result);
  return result;
}

export function invalidateMcpBridgeCache(projectDir?: string): void {
  if (!projectDir) {
    projectCache.clear();
    return;
  }
  for (const key of projectCache.keys()) {
    if (key.endsWith(`:${projectDir}`)) projectCache.delete(key);
  }
}

/** Filter http/sse servers that the agent did not advertise support for.
 *  Stdio is always retained. */
export function filterByCapability(
  servers: AcpMcpServerDescriptor[],
  capabilities: AcpMcpCapabilities | null | undefined,
): AcpMcpServerDescriptor[] {
  const httpOk = !!capabilities?.http;
  const sseOk = !!capabilities?.sse;
  return servers.filter((s) => {
    const type = s.type ?? 'stdio';
    if (type === 'stdio') return true;
    if (type === 'http') return httpOk;
    if (type === 'sse') return sseOk;
    return false;
  });
}

/** Merge two server lists and de-dupe by `name` (first occurrence wins). */
export function dedupeByName(
  ...lists: AcpMcpServerDescriptor[][]
): AcpMcpServerDescriptor[] {
  const seen = new Set<string>();
  const out: AcpMcpServerDescriptor[] = [];
  for (const list of lists) {
    for (const s of list) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
    }
  }
  return out;
}

function pairsToObject(pairs: Array<{ name: string; value: string }>): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const p of pairs) out[p.name] = p.value;
  return out;
}

/** Inverse of `translate()` — Junie/Claude on-disk `mcp.json` shape (object env/headers). */
export function toClaudeMcpFile(servers: AcpMcpServerDescriptor[]): ClaudeMcpFile {
  const mcpServers: Record<string, ClaudeMcpServer> = {};
  for (const s of servers) {
    const type = s.type ?? 'stdio';
    if (type === 'stdio') {
      const stdio = s as AcpMcpServerStdio;
      const env = pairsToObject(stdio.env);
      mcpServers[s.name] = {
        command: stdio.command,
        ...(stdio.args.length > 0 ? { args: stdio.args } : {}),
        ...(env ? { env } : {}),
      };
      continue;
    }
    if (type === 'http' || type === 'sse') {
      const remote = s as AcpMcpServerHttp | AcpMcpServerSse;
      const headers = pairsToObject(remote.headers);
      if (type === 'sse') {
        mcpServers[s.name] = {
          type: 'sse',
          url: remote.url,
          ...(headers ? { headers } : {}),
        };
      } else {
        mcpServers[s.name] = {
          url: remote.url,
          ...(headers ? { headers } : {}),
        };
      }
    }
  }
  return { mcpServers };
}

/** Serialize servers for Cline's `cline_mcp_settings.json` — explicit `type`
 *  per entry (http → `streamableHttp`) so URL servers don't default to SSE. */
export function toClineMcpFile(servers: AcpMcpServerDescriptor[]): ClineMcpFile {
  const mcpServers: Record<string, ClineMcpServer> = {};
  for (const s of servers) {
    const type = s.type ?? 'stdio';
    if (type === 'stdio') {
      const stdio = s as AcpMcpServerStdio;
      const env = pairsToObject(stdio.env);
      mcpServers[s.name] = {
        type: 'stdio',
        command: stdio.command,
        ...(stdio.args.length > 0 ? { args: stdio.args } : {}),
        ...(env ? { env } : {}),
      };
      continue;
    }
    const remote = s as AcpMcpServerHttp | AcpMcpServerSse;
    const headers = pairsToObject(remote.headers);
    mcpServers[s.name] = {
      type: type === 'sse' ? 'sse' : 'streamableHttp',
      url: remote.url,
      ...(headers ? { headers } : {}),
    };
  }
  return { mcpServers };
}

/** Write a per-lane `cline_mcp_settings.json` under
 *  ~/.config/krypton/runtime/cline/<harness>/<lane>/; returns the file path to
 *  pass as `CLINE_MCP_SETTINGS_PATH` at spawn (Cline drops `session/new` MCP). */
export async function writeClineMcpOverlay(
  harnessId: string,
  laneLabel: string,
  servers: AcpMcpServerDescriptor[],
  remoteRuntimeId?: string | null,
  projectDir?: string | null,
): Promise<string> {
  const content = JSON.stringify(toClineMcpFile(servers), null, 2);
  if (remoteRuntimeId && projectDir) {
    const overlay = await remoteRequest<{ path: string }>(remoteRuntimeId, 'overlay_write', {
      backend: 'cline',
      harnessId,
      laneLabel,
      fileName: 'cline_mcp_settings.json',
      content,
    });
    return overlay.path;
  }
  return invoke<string>('write_cline_mcp_overlay', { harnessId, laneLabel, content });
}

export async function removeClineMcpOverlay(
  harnessId: string,
  laneLabel: string,
  remoteRuntimeId?: string | null,
  projectDir?: string | null,
): Promise<void> {
  if (remoteRuntimeId && projectDir) {
    await remoteRequest(remoteRuntimeId, 'overlay_remove', {
      backend: 'cline',
      harnessId,
      laneLabel,
    });
    return;
  }
  await invoke('remove_cline_mcp_overlay', { harnessId, laneLabel });
}

export async function gcClineMcpOverlays(
  harnessId: string,
  remoteRuntimeId?: string | null,
  projectDir?: string | null,
): Promise<void> {
  if (remoteRuntimeId && projectDir) {
    await remoteRequest(remoteRuntimeId, 'overlay_remove', {
      backend: 'cline',
      harnessId,
    });
    return;
  }
  await invoke('gc_cline_mcp_overlays', { harnessId });
}

/** Write `.junie/mcp/mcp.json` under ~/.config/krypton/runtime/junie/<harness>/<lane>/ for `--mcp-location`. */
export async function writeJunieMcpOverlay(
  harnessId: string,
  laneLabel: string,
  servers: AcpMcpServerDescriptor[],
  remoteRuntimeId?: string | null,
  projectDir?: string | null,
): Promise<string> {
  const content = JSON.stringify(toClaudeMcpFile(servers), null, 2);
  if (remoteRuntimeId && projectDir) {
    const overlay = await remoteRequest<{ dir: string }>(remoteRuntimeId, 'overlay_write', {
      backend: 'junie',
      harnessId,
      laneLabel,
      fileName: 'mcp.json',
      content,
    });
    return overlay.dir;
  }
  return invoke<string>('write_junie_mcp_overlay', { harnessId, laneLabel, content });
}

export async function removeJunieMcpOverlay(
  harnessId: string,
  laneLabel: string,
  remoteRuntimeId?: string | null,
  projectDir?: string | null,
): Promise<void> {
  if (remoteRuntimeId && projectDir) {
    await remoteRequest(remoteRuntimeId, 'overlay_remove', {
      backend: 'junie',
      harnessId,
      laneLabel,
    });
    return;
  }
  await invoke('remove_junie_mcp_overlay', { harnessId, laneLabel });
}

/** spec 113 rev — cursor-agent ignores ACP `session/new` mcpServers (upstream
 *  regression), so the Cursor lane gets its harness servers through native
 *  `<projectDir>/.cursor/mcp.json` + `cursor-agent mcp enable`. Merges into any
 *  existing file; returns the server names written (for cleanup on lane close). */
export async function prepareCursorMcp(
  projectDir: string,
  servers: AcpMcpServerDescriptor[],
  remoteRuntimeId?: string | null,
): Promise<string[]> {
  const file = toClaudeMcpFile(servers);
  if (remoteRuntimeId) {
    const path = `${projectDir.replace(/\/$/, '')}/.cursor/mcp.json`;
    const current = await readRemoteJson(remoteRuntimeId, path);
    const root = isRecord(current) ? current : {};
    const existing = isRecord(root.mcpServers) ? root.mcpServers : {};
    const incoming = file.mcpServers ?? {};
    root.mcpServers = { ...existing, ...incoming };
    await remoteRequest(remoteRuntimeId, 'write', {
      path,
      content: JSON.stringify(root, null, 2),
    });
    const names = Object.keys(incoming);
    await Promise.all(names.map(async (name) => {
      try {
        await remoteRequest(remoteRuntimeId, 'run', {
          program: 'cursor-agent',
          args: ['mcp', 'enable', name],
          cwd: projectDir,
        });
      } catch (e) {
        console.warn(`[mcp-bridge] remote cursor-agent mcp enable ${name} failed:`, e);
      }
    }));
    return names;
  }
  return invoke<string[]>('prepare_cursor_mcp', { projectDir, servers: file.mcpServers ?? {} });
}

/** Remove the krypton-injected entries from `<projectDir>/.cursor/mcp.json`. */
export async function cleanupCursorMcp(
  projectDir: string,
  names: string[],
  remoteRuntimeId?: string | null,
): Promise<void> {
  if (remoteRuntimeId) {
    const path = `${projectDir.replace(/\/$/, '')}/.cursor/mcp.json`;
    const root = await readRemoteJson(remoteRuntimeId, path);
    if (!isRecord(root) || !isRecord(root.mcpServers)) return;
    for (const name of names) delete root.mcpServers[name];
    if (Object.keys(root).length === 1 && Object.keys(root.mcpServers).length === 0) {
      await remoteRequest(remoteRuntimeId, 'remove', { path, recursive: false });
    } else {
      await remoteRequest(remoteRuntimeId, 'write', {
        path,
        content: JSON.stringify(root, null, 2),
      });
    }
    return;
  }
  await invoke('cleanup_cursor_mcp', { projectDir, names });
}

export async function gcJunieMcpOverlays(
  harnessId: string,
  remoteRuntimeId?: string | null,
  projectDir?: string | null,
): Promise<void> {
  if (remoteRuntimeId && projectDir) {
    await remoteRequest(remoteRuntimeId, 'overlay_remove', {
      backend: 'junie',
      harnessId,
    });
    return;
  }
  await invoke('gc_junie_mcp_overlays', { harnessId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readRemoteJson(runtimeId: string, path: string): Promise<Record<string, unknown>> {
  const response = await remoteRequest<{ exists: boolean; content: string }>(runtimeId, 'read', { path });
  if (!response.exists || !response.content) return {};
  try {
    const value: unknown = JSON.parse(response.content);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
