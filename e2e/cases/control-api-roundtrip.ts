// Control API round trip (spec 0154/0175): every operation crosses the whole
// running app — axum server → Tauri event `acp-control-request` →
// `src/acp/control-bridge.ts` → HarnessDirectory / AcpHarnessView →
// `acp_control_reply` → HTTP reply. Read-only: nothing is created or sent.

import { asRecord, firstSseEvent, http, requireControl } from '../lib/target.ts';
import type { CaseContext, CaseMeta } from '../lib/run.ts';

export const meta: CaseMeta = {
  id: 'control-api-roundtrip',
  title: 'Control API round trip through the running app',
  code: 'S0154',
};

const CORE_OPERATIONS = ['harness.list', 'lane.list', 'peer.list'];

export async function execute({ run }: CaseContext): Promise<void> {
  const control = await requireControl(run);
  const auth = { authorization: `Bearer ${control.token}` };
  const operation = async (step: string, name: string, operationId: string): Promise<{ status: number; reply: Record<string, unknown> }> => {
    const exchange = await http(run, step, `${control.url}/operations`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ operationId, operation: name, params: {} }),
    });
    return { status: exchange.status, reply: asRecord(exchange.json) };
  };
  // The frontend caches replies by operationId, so each run uses fresh ids.
  const opId = (name: string): string => `e2e-${run.runId}-${name}`;

  const caps = await http(run, 'capabilities', `${control.url}/capabilities`, { headers: auth });
  const capsResult = asRecord(asRecord(caps.json).result);
  const apiVersion = typeof capsResult.apiVersion === 'string' ? capsResult.apiVersion : '';
  run.check(
    'capabilities',
    'GET /capabilities answers 200 with apiVersion 1.x',
    caps.status === 200 && apiVersion.split('.')[0] === '1',
    `status ${caps.status}, apiVersion ${apiVersion || '(missing)'}`,
  );
  const operations = Array.isArray(capsResult.operations) ? capsResult.operations : [];
  const missing = CORE_OPERATIONS.filter((name) => !operations.includes(name));
  const sse = asRecord(capsResult.streaming).sse;
  run.check(
    'capabilities',
    'advertises harness.list, lane.list, peer.list and the SSE path',
    missing.length === 0 && sse === '/control/v1/events',
    `${operations.length} operations${missing.length ? `, missing ${missing.join(', ')}` : ''}; streaming.sse ${String(sse)}`,
  );

  const invalid = await operation('operation-empty-id', 'harness.list', '');
  const invalidCode = asRecord(invalid.reply.error).code;
  run.check(
    'validation',
    'empty operationId is rejected in Rust with 400 invalid_request',
    invalid.status === 400 && invalidCode === 'invalid_request',
    `status ${invalid.status}, error.code ${String(invalidCode)}`,
  );

  const harnesses = await operation('harness-list', 'harness.list', opId('harness-list'));
  const harnessRows = Array.isArray(harnesses.reply.result) ? harnesses.reply.result.map(asRecord) : null;
  const harnessShapeOk =
    harnessRows !== null &&
    harnessRows.every(
      (h) => typeof h.harnessId === 'string' && (h.cwd === null || typeof h.cwd === 'string') && Array.isArray(h.lanes),
    );
  run.check(
    'frontend round trip',
    'harness.list returns 200 with {harnessId, cwd, lanes[]} rows',
    harnesses.status === 200 && harnessShapeOk,
    harnesses.status === 504
      ? 'status 504 — the frontend control bridge did not answer'
      : `status ${harnesses.status}, ${harnessRows === null ? `error ${JSON.stringify(harnesses.reply.error ?? null)}` : `${harnessRows.length} harness(es)`}`,
  );
  const rows = harnessRows ?? [];
  if (rows.length === 0) run.info('frontend round trip', 'no ACP harness open', 'lane checks run on empty lists');
  const harnessIds = new Set(rows.map((h) => String(h.harnessId)));
  const harnessLaneNames = rows
    .flatMap((h) => (Array.isArray(h.lanes) ? h.lanes.map((lane) => String(asRecord(lane).displayName)) : []))
    .sort();

  const peers = await operation('peer-list', 'peer.list', opId('peer-list'));
  const peerNames = Array.isArray(peers.reply.result)
    ? peers.reply.result.map((lane) => String(asRecord(lane).displayName)).sort()
    : null;
  run.check(
    'frontend round trip',
    'peer.list names the same lanes as harness.list',
    peers.status === 200 && peerNames !== null && JSON.stringify(peerNames) === JSON.stringify(harnessLaneNames),
    `status ${peers.status}; peer.list [${(peerNames ?? []).join(', ')}]; harness.list [${harnessLaneNames.join(', ')}]`,
  );

  const lanes = await operation('lane-list', 'lane.list', opId('lane-list'));
  const laneRows = Array.isArray(lanes.reply.result) ? lanes.reply.result.map(asRecord) : null;
  const strays = (laneRows ?? []).filter(
    (lane) => typeof lane.displayName !== 'string' || !harnessIds.has(String(lane.harnessId)),
  );
  run.check(
    'frontend round trip',
    'lane.list rows carry a displayName and a harnessId from harness.list',
    lanes.status === 200 && laneRows !== null && strays.length === 0,
    `status ${lanes.status}, ${laneRows?.length ?? 0} lane(s)${strays.length ? `, ${strays.length} without a known harness` : ''}`,
  );

  const events = await firstSseEvent(run, 'events-stream', `${control.url}/events`, auth, 5000);
  run.check(
    'events',
    'GET /events streams a ready event within 5 s',
    events.status === 200 && events.event === 'ready',
    `status ${events.status}, first event ${events.event ?? '(none)'}`,
  );
}
