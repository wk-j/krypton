import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { Color, Icon, getPreferenceValues } from '@raycast/api';

// Transport for the Krypton control API (/control/v1, docs 154/175), spec 205.
// Mirrors kryptonctl: read the runtime descriptor, verify pid + apiVersion,
// POST operations with the bearer token.

export interface RuntimeDescriptor {
  pid: number;
  url: string;
  apiVersion: string;
  appVersion: string;
  token: string;
}

export type KryptonErrorKind = 'not-running' | 'version-mismatch' | 'api' | 'network';

export class KryptonError extends Error {
  readonly kind: KryptonErrorKind;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(kind: KryptonErrorKind, message: string, opts: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'KryptonError';
    this.kind = kind;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
  }
}

export function isNotRunning(err: unknown): boolean {
  return err instanceof KryptonError && err.kind === 'not-running';
}

const DESCRIPTOR_PATH = join(homedir(), '.config', 'krypton', 'runtime', 'controller.json');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readDescriptor(): Promise<RuntimeDescriptor> {
  let raw: string;
  try {
    raw = await readFile(DESCRIPTOR_PATH, 'utf8');
  } catch {
    throw new KryptonError('not-running', 'controller.json not found — Krypton is not running');
  }
  let desc: RuntimeDescriptor;
  try {
    desc = JSON.parse(raw) as RuntimeDescriptor;
  } catch {
    throw new KryptonError('not-running', 'controller.json is not valid JSON');
  }
  if (typeof desc?.pid !== 'number' || typeof desc?.url !== 'string' || typeof desc?.token !== 'string') {
    throw new KryptonError('not-running', 'controller.json is malformed');
  }
  if (!pidAlive(desc.pid)) {
    throw new KryptonError('not-running', 'stale descriptor — the Krypton process is gone');
  }
  const major = Number.parseInt(String(desc.apiVersion ?? '').split('.')[0] ?? '', 10);
  if (major !== 1) {
    throw new KryptonError('version-mismatch', `control API v${desc.apiVersion} is not supported by this extension`);
  }
  return desc;
}

interface ControlErrorEnvelope {
  code?: string;
  message?: string;
  retryable?: boolean;
}

async function post(desc: RuntimeDescriptor, body: unknown): Promise<Response> {
  try {
    return await fetch(`${desc.url}/operations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${desc.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // server-side operation timeout is 30 s; abort a little after it
      signal: AbortSignal.timeout(35_000),
    });
  } catch (err) {
    throw new KryptonError('network', err instanceof Error ? err.message : String(err));
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  let payload: { result?: T; error?: ControlErrorEnvelope } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    // fall through to the status check
  }
  if (payload.error) {
    throw new KryptonError('api', payload.error.message ?? `control error (${res.status})`, {
      code: payload.error.code,
      retryable: payload.error.retryable ?? false,
    });
  }
  if (!res.ok) {
    throw new KryptonError('api', `control request failed (${res.status})`, {
      code: res.status === 504 ? 'timeout' : undefined,
      retryable: res.status === 504,
    });
  }
  return payload.result as T;
}

export interface OpOptions {
  mutation?: boolean;
}

export async function op<T>(
  operation: string,
  params: Record<string, unknown> = {},
  opts: OpOptions = {},
): Promise<T> {
  const desc = await readDescriptor();
  // Non-empty, collision-resistant: the frontend idempotency cache is keyed
  // by operationId, and fan-out calls run concurrently.
  const operationId = randomUUID();
  let res = await post(desc, { operationId, operation, params });
  if (res.status === 401) {
    // Token rotated (Krypton relaunched or descriptor raced). Lane names and
    // counters reset with the process, so a replayed mutation could hit a
    // different lane with the same displayName — reads only.
    if (opts.mutation) {
      throw new KryptonError('api', 'Krypton restarted — the lane list is stale, refresh and retry', {
        code: 'token_rotated',
      });
    }
    const fresh = await readDescriptor();
    // Same pid = same process, its idempotency cache survived: reuse the id.
    const retryId = fresh.pid === desc.pid ? operationId : randomUUID();
    res = await post(fresh, { operationId: retryId, operation, params });
  }
  return unwrap<T>(res);
}

// ---------------------------------------------------------------------------
// Result shapes (verbatim from the control handler, acp-harness-view.ts)

export type LaneStatus =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'needs_permission'
  | 'awaiting_peer'
  | 'error'
  | 'stopped';

export type PermissionMode = 'normal' | 'acceptEdits' | 'bypass';

export interface HarnessSummary {
  harnessId: string;
  cwd: string;
  lanes: unknown[];
}

export interface LaneRow {
  harnessId: string;
  cwd: string;
  laneId: string;
  displayName: string;
  backendId: string;
  status: LaneStatus;
  sessionId: string | null;
  modelName: string | null;
  queueDepth: number;
  pendingPermissions: number;
  permissionMode: PermissionMode;
}

export interface AttentionItem {
  id: string;
  lane: string;
  question: string;
  chosen: string;
  rationale: string;
  tradedOff: string[];
  uncertainty: string;
  reversibility: string;
  diffstat?: string | null;
  createdAt: string | number;
  status: string;
}

export interface PermissionOption {
  optionId?: string;
  kind?: string;
  name?: string;
}

export interface PermissionRequest {
  requestId: string;
  tool: string;
  options: PermissionOption[];
}

export interface TranscriptEntry {
  id: string;
  kind: string;
  text: string;
  createdAt?: string | number;
  status?: string;
}

export interface SendResult {
  status: 'started' | 'queued';
  lane: string;
  queueDepth?: number;
}

// ---------------------------------------------------------------------------
// Multi-harness enumeration. control-bridge fans out across harnesses only
// for lane.list; attention.* without a harnessId throws ambiguous_harness as
// soon as two harness views are open — enumerate and tag instead (spec 205).

export interface PerHarness<T> {
  harnessId: string;
  cwd: string;
  result: T;
}

export async function opPerHarness<T>(
  operation: string,
  params: Record<string, unknown> = {},
): Promise<PerHarness<T>[]> {
  const harnesses = await op<HarnessSummary[]>('harness.list');
  return Promise.all(
    harnesses.map(async (h) => ({
      harnessId: h.harnessId,
      cwd: h.cwd,
      result: await op<T>(operation, { ...params, harnessId: h.harnessId }),
    })),
  );
}

// ---------------------------------------------------------------------------
// UI helpers shared by the commands

// lane.cancel is honored for every in-flight state, including awaiting_peer
export const CANCELLABLE: ReadonlySet<LaneStatus> = new Set(['busy', 'needs_permission', 'awaiting_peer']);
// restartLane() silently no-ops on any other state while the API still
// reports success — only offer the action where it acts
export const RESTARTABLE: ReadonlySet<LaneStatus> = new Set(['error', 'stopped']);

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  switch (mode) {
    case 'normal':
      return 'acceptEdits';
    case 'acceptEdits':
      return 'bypass';
    default:
      return 'normal';
  }
}

export function statusIcon(status: LaneStatus): { source: Icon; tintColor: Color } {
  switch (status) {
    case 'idle':
      return { source: Icon.CircleFilled, tintColor: Color.Green };
    case 'busy':
      return { source: Icon.CircleFilled, tintColor: Color.Orange };
    case 'needs_permission':
      return { source: Icon.ExclamationMark, tintColor: Color.Red };
    case 'awaiting_peer':
      return { source: Icon.CircleFilled, tintColor: Color.Blue };
    case 'error':
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
    default:
      return { source: Icon.Circle, tintColor: Color.SecondaryText };
  }
}

export function hasAllowOption(request: PermissionRequest): boolean {
  return request.options.some((o) => (o.kind ?? '').startsWith('allow'));
}

// The hook server has no runtime descriptor, so the configured port is the
// best available truth: [hooks] port in krypton.toml (falls back to the 8765
// default). Minimal section-aware scan — no TOML dependency for one key.
function hookPortFromConfig(): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(homedir(), '.config', 'krypton', 'krypton.toml'), 'utf8');
  } catch {
    return null;
  }
  let inHooks = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inHooks = trimmed === '[hooks]';
      continue;
    }
    if (!inHooks) continue;
    const match = /^port\s*=\s*(\d+)/.exec(trimmed);
    if (match) {
      const port = Number.parseInt(match[1], 10);
      return port > 0 ? port : null;
    }
  }
  return null;
}

// /telemetry is the cheapest unauthenticated hook-server JSON endpoint; a
// Krypton hook server always answers it with a { harnesses: [...] } body.
async function isKryptonHookServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/telemetry`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = (await res.json()) as { harnesses?: unknown };
    return Array.isArray(body.harnesses);
  } catch {
    return false;
  }
}

export async function surfaceUrl(page: 'dashboard' | 'gallery' | 'docs'): Promise<string> {
  const { hookPort } = getPreferenceValues<{ hookPort?: string }>();
  const pref = Number.parseInt(hookPort ?? '', 10) || null;
  // Candidates in trust order, but each is PROBED before use — a stale
  // preference (e.g. a stored old default) must not win over reality.
  const candidates = [...new Set([pref, hookPortFromConfig(), 8765].filter((p): p is number => p !== null && p > 0))];
  for (const port of candidates) {
    if (await isKryptonHookServer(port)) return `http://127.0.0.1:${port}/${page}`;
  }
  throw new KryptonError(
    'network',
    `hook server not reachable on port ${candidates.join(', ')} — check [hooks] in krypton.toml`,
  );
}

export function launchKrypton(): void {
  execFile('open', ['-a', 'Krypton']);
}

export function basename(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
