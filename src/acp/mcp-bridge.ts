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
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

type ClaudeMcpServer = ClaudeMcpStdio | ClaudeMcpHttp;

interface ClaudeMcpFile {
  mcpServers?: Record<string, ClaudeMcpServer>;
}

let loginEnvPromise: Promise<Record<string, string>> | null = null;
const projectCache = new Map<string, AcpMcpServerDescriptor[]>();

function loadLoginEnv(): Promise<Record<string, string>> {
  if (!loginEnvPromise) {
    loginEnvPromise = invoke<Record<string, string>>('acp_login_env').catch((e) => {
      console.warn('[mcp-bridge] acp_login_env failed:', e);
      return {};
    });
  }
  return loginEnvPromise;
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
): Promise<AcpMcpServerDescriptor[]> {
  if (!projectDir) return [];
  const cached = projectCache.get(projectDir);
  if (cached) return cached;

  const path = `${projectDir.replace(/\/$/, '')}/.mcp.json`;
  let raw: string | null;
  try {
    raw = await invoke<string | null>('read_mcp_config_file', { path });
  } catch (e) {
    console.warn(`[mcp-bridge] read failed: ${String(e)}`);
    projectCache.set(projectDir, []);
    return [];
  }
  if (!raw) {
    projectCache.set(projectDir, []);
    return [];
  }

  let parsed: ClaudeMcpFile;
  try {
    parsed = JSON.parse(raw) as ClaudeMcpFile;
  } catch (e) {
    console.warn(`[mcp-bridge] ${path}: invalid JSON: ${String(e)}`);
    projectCache.set(projectDir, []);
    return [];
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object') {
    projectCache.set(projectDir, []);
    return [];
  }

  const env = await loadLoginEnv();
  const result: AcpMcpServerDescriptor[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    const descriptor = translate(name, server as ClaudeMcpServer, env);
    if (descriptor) result.push(descriptor);
  }
  projectCache.set(projectDir, result);
  return result;
}

export function invalidateMcpBridgeCache(projectDir?: string): void {
  if (projectDir) projectCache.delete(projectDir);
  else projectCache.clear();
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
