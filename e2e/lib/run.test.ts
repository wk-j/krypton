import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { BlockedError, REPO_ROOT, Run, verdictOf } from './run.ts';
import { firstSseEvent, http } from './target.ts';

test('check metadata preserves old calls, redacts values and classifies blockers', (t) => {
  const run = new Run('recorder-unit', new Date());
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  run.addSecret('test-secret');
  run.check('legacy', 'old call', true, 'unchanged', 'axum');
  run.check('checks', 'new fields', false, 'test-secret', 'axum', {
    step: 'request', target: { type: 'http', name: 'GET /test-secret' },
    params: { enabled: true, count: 2, name: 'test-secret' },
    evidence: { artifact: 'request', pointer: '/response' },
    expected: 'test-secret expected', actual: 'test-secret actual',
  });
  assert.equal(run.checks[0].at, 'axum');
  assert.equal(run.checks[0].kind, 'expect');
  assert.equal(run.checks[1].params?.enabled, true);
  assert.equal(run.checks[1].params?.count, 2);
  assert.equal(run.checks[1].actual, '<redacted> actual');
  assert.equal(run.checks[1].evidence?.pointer, '/response');
  assert.equal(JSON.stringify(run.checks).includes('test-secret'), false);
  assert.throws(() => run.block('environment', 'missing app', 'not running'), BlockedError);
  assert.equal(run.checks.at(-1)?.kind, 'precondition');
  assert.equal(run.checks.at(-1)?.status, 'blocked');
});

test('HTTP and SSE actions link safe inputs and response evidence without deciding assertions', async (t) => {
  const run = new Run('request-unit', new Date());
  t.after(() => rmSync(run.dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init): Promise<Response> => {
    requests.push({ url: String(input), body: init?.body });
    if (String(input).includes('/events')) {
      return new Response('event: ready\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{"error":{"code":"authentication_failed"}}', { status: 401 });
  };
  run.addSecret('test-secret');
  const reply = await http(run, 'call-one', 'http://127.0.0.1/artifact/test-secret?token=test-secret&path=README.md', {
    method: 'POST', headers: { authorization: 'Bearer test-secret' },
    body: JSON.stringify({ operation: 'harness.list', enabled: true, token: 'test-secret', params: {} }),
  });
  const events = await firstSseEvent(run, 'events', 'http://127.0.0.1/events', {}, 1000);
  assert.equal(reply.status, 401);
  assert.equal(events.event, 'ready');
  assert.equal(run.checks[0].kind, 'step');
  assert.equal(run.checks[0].step, 'call-one');
  assert.equal(run.checks[0].target?.name, 'POST /artifact/{token}');
  assert.deepEqual(run.checks[0].params, { path: 'README.md', operation: 'harness.list', enabled: true });
  assert.equal(run.checks[1].step, 'events');
  assert.equal(verdictOf(run.checks), 'ERROR');
  run.check('auth', 'rejects bearer', reply.status === 401, `status ${reply.status}`, undefined,
    { ...reply.check, expected: '401', actual: String(reply.status) });
  assert.equal(verdictOf(run.checks), 'PASS');
  assert.equal(run.checks[2].step, 'call-one');
  for (const check of run.checks) {
    assert.ok(run.artifacts.some((artifact) => artifact.label === check.evidence?.artifact));
  }
  const artifact = run.artifacts.find((entry) => entry.label === 'call-one');
  assert.ok(artifact);
  const capture = readFileSync(join(REPO_ROOT, artifact.path), 'utf8');
  assert.equal(capture.includes('test-secret'), false);
  assert.equal(JSON.parse(capture).response.status, 401);
  assert.equal(JSON.parse(JSON.parse(capture).request.body).operation, 'harness.list');
  assert.ok(requests[0].url.includes('test-secret'));
  assert.equal(JSON.parse(String(requests[0].body)).token, 'test-secret');
});
