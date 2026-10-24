// Krypton e2e — discovering the running app's two loopback servers and
// talking to them with every exchange kept as evidence.
//
// - Control API (`src-tauri/src/control.rs`, spec 0154/0175): authenticated,
//   found through the `0600` runtime descriptor that `kryptonctl` also reads.
// - Loopback server (`src-tauri/src/hook_server.rs`, `[loopback_server]`):
//   unauthenticated by design except capability-token routes; its port comes
//   from `krypton.toml` (default 8765) or `--param loopbackPort=N`.

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

import type { ParamValue, Run } from './run.ts';

const START_HINT = 'start Krypton (open -a Krypton, or make dev) and run again';
const TEXT_CAPTURE_LIMIT = 16 * 1024;

export interface ControlTarget {
  url: string;
  token: string;
  pid: number;
  apiVersion: string;
  appVersion: string;
}

export interface LoopbackTarget {
  url: string;
  port: number;
}

export interface Exchange {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export function kryptonConfigDir(): string {
  return join(homedir(), '.config', 'krypton');
}

/** Read and check the control descriptor; any failure blocks the run. */
export async function requireControl(run: Run): Promise<ControlTarget> {
  const group = 'precondition';
  const label = 'control API is up';
  const path = join(kryptonConfigDir(), 'runtime', 'controller.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    run.block(group, label, `control descriptor ${path} not found — ${START_HINT}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    run.block(group, label, `control descriptor ${path} is not JSON: ${String(error)}`);
  }
  const d = asRecord(parsed);
  const target: ControlTarget = {
    url: typeof d.url === 'string' ? d.url.replace(/\/+$/, '') : '',
    token: typeof d.token === 'string' ? d.token : '',
    pid: typeof d.pid === 'number' ? d.pid : 0,
    apiVersion: typeof d.apiVersion === 'string' ? d.apiVersion : '',
    appVersion: typeof d.appVersion === 'string' ? d.appVersion : '',
  };
  run.addSecret(target.token);
  if (!target.url || !target.token || !target.pid || !target.apiVersion) {
    run.block(group, label, `control descriptor ${path} lacks url, token, pid or apiVersion`);
  }
  if (!pidIsLive(target.pid)) {
    run.block(group, label, `stale control descriptor (pid ${target.pid} is not running) — ${START_HINT}`);
  }
  if (target.apiVersion.split('.')[0] !== '1') {
    run.block(group, label, `control API ${target.apiVersion} is not 1.x`);
  }
  const { hostname, port } = new URL(target.url);
  const reach = await tcpProbe(hostname, Number(port), 3000);
  if (reach !== 'connected') {
    run.block(group, label, `${target.url} is not accepting connections (${reach}) — ${START_HINT}`);
  }
  run.versions.app = target.appVersion;
  run.versions.controlApi = target.apiVersion;
  run.info(group, label, `${target.url}, pid ${target.pid}, app ${target.appVersion}, API ${target.apiVersion}`);
  return target;
}

/**
 * Locate the loopback server and prove it is Krypton's (`GET /tools.json`).
 * `loopbackPort` 0 means "read `[loopback_server] port` from krypton.toml".
 */
export async function requireLoopback(run: Run, params: Record<string, ParamValue>): Promise<LoopbackTarget> {
  const group = 'precondition';
  const label = 'loopback server is up';
  const configured = loopbackConfig();
  const explicit = Number(params.loopbackPort ?? 0);
  if (!Number.isInteger(explicit) || explicit < 0 || explicit > 65535) {
    run.block(group, label, `loopbackPort=${String(params.loopbackPort)} is not a port number`);
  }
  if (!explicit && !configured.enabled) {
    run.block(group, label, `[loopback_server] enabled = false in ${configured.path}`);
  }
  const port = explicit || configured.port;
  if (!port) {
    run.block(group, label, `[loopback_server] port = 0 (ephemeral) — pass --param loopbackPort=<port>`);
  }
  const url = `http://127.0.0.1:${port}`;
  const reach = await tcpProbe('127.0.0.1', port, 3000);
  if (reach !== 'connected') {
    run.block(
      group,
      label,
      `${url} is not accepting connections (${reach}) — ${START_HINT}; if the server fell back to an ephemeral port, pass --param loopbackPort=<port>`,
    );
  }
  const probe = await http(run, 'loopback-identity', `${url}/tools.json`);
  if (probe.status !== 200 || !Array.isArray(asRecord(probe.json).tools)) {
    run.block(group, label, `${url}/tools.json answered ${probe.status} without a tools list — not Krypton's loopback server`);
  }
  run.info(group, label, `${url} (${explicit ? 'from --param loopbackPort' : `from ${configured.source}`})`);
  return { url, port };
}

/** One HTTP exchange, captured as evidence: request method/url/header names, full response. */
export async function http(run: Run, step: string, url: string, options: RequestOptions = {}): Promise<Exchange> {
  const method = options.method ?? 'GET';
  const headers = options.headers ?? {};
  const response = await fetch(url, {
    method,
    headers,
    body: options.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  run.capture(step, {
    request: { method, url, headerNames: Object.keys(headers) },
    response: {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: json ?? truncate(text),
    },
  });
  return { status: response.status, headers: response.headers, text, json };
}

/**
 * Open an SSE stream and wait for its first named event. Non-200 replies return
 * at once with their body; a 200 stream is aborted after the first event or
 * after `timeoutMs`.
 */
export async function firstSseEvent(
  run: Run,
  step: string,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; event: string | null; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let event: string | null = null;
  let received = '';
  let json: unknown = undefined;
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    status = response.status;
    if (status !== 200 || !response.body) {
      received = await response.text();
      try {
        json = received ? JSON.parse(received) : undefined;
      } catch {
        json = undefined;
      }
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (event === null) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
        const match = /^event: ?(.+)$/m.exec(received);
        if (match) event = match[1].trim();
      }
      controller.abort();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  run.capture(step, {
    request: { method: 'GET', url, headerNames: Object.keys(headers) },
    response: { status, firstEvent: event, received: json ?? truncate(received) },
  });
  return { status, event, json };
}

/** `connected`, or the socket error code (ECONNREFUSED, ETIMEDOUT, …). */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const socket = connect({ host, port });
  const done = (outcome: string): void => {
    socket.destroy();
    resolve(outcome);
  };
  socket.setTimeout(timeoutMs, () => done('ETIMEDOUT'));
  socket.once('connect', () => done('connected'));
  socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? error.message));
  return promise;
}

/** First non-internal IPv4 address of this machine, if any. */
export function externalIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `[loopback_server] enabled/port` from krypton.toml. A line scan, not a TOML
 * parser: it reads plain `key = value` lines inside that one table, which is
 * how Krypton writes the default config.
 */
function loopbackConfig(): { enabled: boolean; port: number; path: string; source: string } {
  const path = join(kryptonConfigDir(), 'krypton.toml');
  const result = { enabled: true, port: 8765, path, source: 'default 8765' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return result;
  }
  let table = '';
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    if (table !== 'loopback_server') continue;
    const entry = /^\s*(enabled|port)\s*=\s*([^\s#]+)/.exec(line);
    if (entry?.[1] === 'enabled') result.enabled = entry[2] !== 'false';
    if (entry?.[1] === 'port') {
      result.port = Number(entry[2]);
      result.source = `${path} [loopback_server] port`;
    }
  }
  return result;
}

function truncate(text: string): string {
  return text.length > TEXT_CAPTURE_LIMIT ? `${text.slice(0, TEXT_CAPTURE_LIMIT)}… (${text.length} bytes)` : text;
}
