import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  harnessEntry,
  listHarnessEntries,
  resolveDisplayName,
} from './harness-directory';
import type { Compositor } from '../compositor';

interface ControlEvent {
  requestId: string;
  operationId: string;
  operation: string;
  params: Record<string, unknown>;
}

interface ControlReply {
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

const completed = new Map<string, ControlReply>();
const COMPLETED_CAP = 256;
let compositor: Compositor | null = null;

export async function startAcpControlBridge(owner: Compositor): Promise<void> {
  compositor = owner;
  await listen<ControlEvent>('acp-control-request', (event) => {
    void handleAndReply(event.payload);
  });
}

async function handleAndReply(event: ControlEvent): Promise<void> {
  const cached = completed.get(event.operationId);
  if (cached) {
    await reply(event.requestId, cached);
    return;
  }
  let response: ControlReply;
  try {
    response = { result: await route(event.operation, event.params ?? {}) };
  } catch (error) {
    response = normalizeError(error);
  }
  completed.set(event.operationId, response);
  if (completed.size > COMPLETED_CAP) {
    const oldest = completed.keys().next().value;
    if (oldest) completed.delete(oldest);
  }
  await reply(event.requestId, response);
}

async function route(operation: string, params: Record<string, unknown>): Promise<unknown> {
  if (operation === 'harness.create') {
    if (!compositor) throw controlError('control_failed', 'compositor is unavailable');
    const cwd = typeof params.cwd === 'string' ? params.cwd : null;
    await compositor.openAcpHarnessView(cwd);
    return { created: true, cwd };
  }
  if (operation === 'harness.list') {
    return listHarnessEntries().map((entry) => ({
      harnessId: entry.harnessId,
      cwd: entry.cwd,
      lanes: entry.listLanes(),
    }));
  }
  if (operation === 'peer.list') {
    return listHarnessEntries().flatMap((entry) => entry.listLanes());
  }

  const target = targetHarness(operation, params);
  if (!target.control) throw controlError('unsupported_operation', `${operation} is not supported by this harness`);
  return target.control(operation, params);
}

function targetHarness(operation: string, params: Record<string, unknown>) {
  const laneName = typeof params.lane === 'string' ? params.lane : null;
  if (laneName) {
    const resolved = resolveDisplayName(laneName);
    if (!resolved) throw controlError('unknown_lane', `unknown lane: ${laneName}`);
    const entry = harnessEntry(resolved.harnessId);
    if (!entry) throw controlError('harness_closed', `harness closed: ${resolved.harnessId}`);
    return entry;
  }
  const harnessId = typeof params.harnessId === 'string' ? params.harnessId : null;
  if (harnessId) {
    const entry = harnessEntry(harnessId);
    if (!entry) throw controlError('unknown_harness', `unknown harness: ${harnessId}`);
    return entry;
  }
  const entries = listHarnessEntries();
  if (entries.length === 1) return entries[0];
  if (entries.length === 0) throw controlError('unknown_harness', 'no ACP harness is open');
  throw controlError('ambiguous_harness', `${operation} requires harnessId`);
}

async function reply(requestId: string, value: ControlReply): Promise<void> {
  try {
    await invoke('acp_control_reply', { requestId, reply: value });
  } catch (error) {
    console.warn('[acp-control] reply failed', error);
  }
}

function normalizeError(error: unknown): ControlReply {
  if (isControlError(error)) {
    return { error: { code: error.code, message: error.message, retryable: error.retryable } };
  }
  return {
    error: {
      code: 'control_failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
}

interface ControlBridgeError extends Error {
  code: string;
  retryable: boolean;
}

function controlError(code: string, message: string, retryable = false): ControlBridgeError {
  return Object.assign(new Error(message), { code, retryable });
}

function isControlError(value: unknown): value is ControlBridgeError {
  return value instanceof Error
    && typeof (value as Partial<ControlBridgeError>).code === 'string'
    && typeof (value as Partial<ControlBridgeError>).retryable === 'boolean';
}
