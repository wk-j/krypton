// Loopback API authorization against the running app. Krypton exposes two
// loopback HTTP servers with different trust models:
//
// - Control API (spec 0154/0175): every route needs the descriptor's bearer
//   token; the connected-computer routes also need a live lane capability.
//   CORS is opt-in by exact origin, so a foreign origin gets no CORS grant.
// - Loopback server (`[loopback_server]`, specs 0149/0168/0172/0198/0227/0288):
//   tokenless by design, protected by binding 127.0.0.1 only; capability-token
//   routes answer 404 with no body for an unknown token (no existence leak).
//
// Every request here is either unauthenticated or carries a forged credential,
// so nothing is executed, injected or exported. The single authenticated call
// is the positive control on GET /capabilities.

import { randomBytes } from 'node:crypto';

import { asRecord, externalIPv4, firstSseEvent, http, requireControl, requireLoopback, tcpProbe } from '../lib/target.ts';
import type { Exchange } from '../lib/target.ts';
import type { CaseContext, CaseMeta, Run } from '../lib/run.ts';

export const meta: CaseMeta = {
  id: 'loopback-api-authorization',
  title: 'Loopback API authorization: bearer, lane capability, capability tokens, CORS, loopback-only binding',
  code: 'S0154',
  params: { loopbackPort: 0 },
};

const FOREIGN_ORIGIN = 'https://krypton-e2e.invalid';

function forged(): string {
  return randomBytes(16).toString('hex');
}

function expectUnauthorized(run: Run, group: string, label: string, exchange: Exchange): void {
  const code = String(asRecord(asRecord(exchange.json).error).code ?? '(none)');
  run.check(group, label, exchange.status === 401 && code === 'authentication_failed', `status ${exchange.status}, error.code ${code}`);
}

function expectHiddenCapability(run: Run, label: string, exchange: Exchange): void {
  run.check(
    'capability tokens',
    label,
    exchange.status === 404 && exchange.text.length === 0,
    `status ${exchange.status}, body ${exchange.text.length} bytes`,
  );
}

export async function execute({ run, params }: CaseContext): Promise<void> {
  const control = await requireControl(run);
  const loopback = await requireLoopback(run, params);
  const bearer = { authorization: `Bearer ${control.token}` };
  const json = { 'content-type': 'application/json' };
  const harnessList = JSON.stringify({ operationId: `e2e-${run.runId}-unauth`, operation: 'harness.list', params: {} });

  // Control API: bearer token.
  const accepted = await http(run, 'capabilities-valid-bearer', `${control.url}/capabilities`, { headers: bearer });
  run.check(
    'control API bearer',
    'the descriptor bearer token is accepted (positive control)',
    accepted.status === 200,
    `status ${accepted.status}`,
  );
  expectUnauthorized(
    run,
    'control API bearer',
    'GET /capabilities without Authorization → 401',
    await http(run, 'capabilities-no-auth', `${control.url}/capabilities`),
  );
  expectUnauthorized(
    run,
    'control API bearer',
    'GET /capabilities with a forged bearer → 401',
    await http(run, 'capabilities-forged-bearer', `${control.url}/capabilities`, {
      headers: { authorization: `Bearer ${forged()}` },
    }),
  );
  expectUnauthorized(
    run,
    'control API bearer',
    'the real token without the Bearer scheme → 401',
    await http(run, 'capabilities-no-scheme', `${control.url}/capabilities`, {
      headers: { authorization: control.token },
    }),
  );
  expectUnauthorized(
    run,
    'control API bearer',
    'POST /operations without Authorization → 401, the operation never runs',
    await http(run, 'operations-no-auth', `${control.url}/operations`, { method: 'POST', headers: json, body: harnessList }),
  );
  const eventsNoAuth = await firstSseEvent(run, 'events-no-auth', `${control.url}/events`, {}, 5000);
  run.check(
    'control API bearer',
    'GET /events without credentials → 401, no stream',
    eventsNoAuth.status === 401 && eventsNoAuth.event === null,
    `status ${eventsNoAuth.status}, first event ${eventsNoAuth.event ?? '(none)'}`,
  );
  const eventsForged = await firstSseEvent(run, 'events-forged-query-token', `${control.url}/events?token=${forged()}`, {}, 5000);
  run.check(
    'control API bearer',
    'GET /events?token=<forged> → 401, no stream',
    eventsForged.status === 401 && eventsForged.event === null,
    `status ${eventsForged.status}, first event ${eventsForged.event ?? '(none)'}`,
  );

  // Control API: the connected-computer routes need a live lane capability on top.
  expectUnauthorized(
    run,
    'control API lane capability',
    'GET /computer/list with a valid bearer but no lane capability → 401',
    await http(run, 'computer-list-no-capability', `${control.url}/computer/list`, { headers: bearer }),
  );
  expectUnauthorized(
    run,
    'control API lane capability',
    'GET /computer/list with a forged lane capability → 401',
    await http(run, 'computer-list-forged-capability', `${control.url}/computer/list`, {
      headers: { ...bearer, 'x-krypton-computer-capability': forged() },
    }),
  );
  expectUnauthorized(
    run,
    'control API lane capability',
    'POST /computer/exec with a forged lane capability → 401, nothing executes',
    await http(run, 'computer-exec-forged-capability', `${control.url}/computer/exec`, {
      method: 'POST',
      headers: { ...bearer, ...json, 'x-krypton-computer-capability': forged() },
      body: JSON.stringify({ computerId: 'krypton-e2e-none', command: 'true' }),
    }),
  );

  // Cross-origin: a web page in the user's browser must not get a CORS grant.
  const preflight = (url: string, step: string): Promise<Exchange> =>
    http(run, step, url, {
      method: 'OPTIONS',
      headers: {
        origin: FOREIGN_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
  const controlPreflight = await preflight(`${control.url}/operations`, 'control-preflight-foreign-origin');
  run.check(
    'cross-origin',
    'control API grants no CORS to a foreign origin',
    !controlPreflight.headers.has('access-control-allow-origin'),
    `status ${controlPreflight.status}, access-control-allow-origin ${controlPreflight.headers.get('access-control-allow-origin') ?? '(absent)'}`,
  );
  const docFeedback = `${loopback.url}/doc-feedback?harness=krypton-e2e-none&path=README.md`;
  const loopbackPreflight = await preflight(docFeedback, 'doc-feedback-preflight-foreign-origin');
  run.check(
    'cross-origin',
    'loopback server grants no CORS to a foreign origin on /doc-feedback',
    !loopbackPreflight.headers.has('access-control-allow-origin'),
    `status ${loopbackPreflight.status}, access-control-allow-origin ${loopbackPreflight.headers.get('access-control-allow-origin') ?? '(absent)'}`,
  );
  const simplePost = await http(run, 'doc-feedback-cross-site-simple-post', docFeedback, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: FOREIGN_ORIGIN },
    body: JSON.stringify({ batchId: `e2e-${run.runId}`, comments: [] }),
  });
  run.check(
    'cross-origin',
    'a cross-site text/plain POST to the tokenless /doc-feedback is refused with 415 before any lane',
    simplePost.status === 415,
    `status ${simplePost.status}`,
  );

  // Loopback server: capability-token routes hide unknown tokens.
  const token = forged();
  const capabilityRoutes: Array<[string, string, string]> = [
    ['termctrl-page', `/termctrl/${token}`, 'GET /termctrl/<forged> → 404, empty body'],
    ['termctrl-sessions', `/termctrl/api/${token}/sessions`, 'GET /termctrl/api/<forged>/sessions → 404, empty body'],
    ['termctrl-log', `/termctrl/api/${token}/log/web`, 'GET /termctrl/api/<forged>/log/web → 404, empty body'],
    ['acp-wire-page', `/acp-wire/${token}`, 'GET /acp-wire/<forged> → 404, empty body'],
    ['acp-wire-export', `/acp-wire/${token}/export.jsonl`, 'GET /acp-wire/<forged>/export.jsonl → 404, empty body'],
    ['hurl-page', `/hurl/${token}`, 'GET /hurl/<forged> → 404, empty body'],
    ['hurl-source', `/hurl/api/${token}/source?path=README.md`, 'GET /hurl/api/<forged>/source → 404, empty body'],
    ['artifact-page', `/artifact/${token}`, 'GET /artifact/<forged> → 404, empty body'],
    ['artifact-state', `/artifact/state/${token}`, 'GET /artifact/state/<forged> → 404, empty body'],
  ];
  for (const [step, path, label] of capabilityRoutes) {
    expectHiddenCapability(run, label, await http(run, `forged-${step}`, `${loopback.url}${path}`));
  }
  expectHiddenCapability(
    run,
    'POST /artifact/feedback/<forged> → 404, no feedback reaches a lane',
    await http(run, 'forged-artifact-feedback', `${loopback.url}/artifact/feedback/${token}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ batchId: `e2e-${run.runId}`, comments: [] }),
    }),
  );

  // Both servers bind 127.0.0.1 only: the boundary for every tokenless route.
  const external = externalIPv4();
  if (external === null) {
    run.skip('network exposure', 'servers refuse non-loopback connections', 'this machine has no non-internal IPv4 address');
    return;
  }
  for (const [name, port] of [
    ['control API', Number(new URL(control.url).port)],
    ['loopback server', loopback.port],
  ] as const) {
    const outcome = await tcpProbe(external, port, 3000);
    run.check(
      'network exposure',
      `${name} port ${port} refuses connections on ${external}`,
      outcome !== 'connected',
      outcome === 'connected' ? `${external}:${port} accepted a connection` : `${external}:${port} → ${outcome}`,
    );
  }
}
