import { describe, expect, it } from 'vitest';

import {
  MAX_RECORDS_PER_VIEW,
  ProgramStatusStore,
  parseProgramStatus,
  type ProgramStatusReport,
  type ProgramStatusSummary,
} from './program-status';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function setReport(body: string): Extract<ProgramStatusReport, { type: 'set' }>['record'] {
  const report = parseProgramStatus(body);
  if (report?.type !== 'set') throw new Error(`expected set report for ${body}, got ${JSON.stringify(report)}`);
  return report.record;
}

describe('parseProgramStatus', () => {
  it('parses the spec terraform example', () => {
    const record = setReport(
      'state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/',
    );
    expect(record).toEqual({
      id: '',
      state: 'blocked',
      kind: 'permission',
      progress: null,
      app: 'terraform',
      title: null,
      msg: 'Apply 3 to add, 1 to change, 0 to destroy?',
    });
  });

  it('recognises the feature-detection query', () => {
    expect(parseProgramStatus('?')).toEqual({ type: 'query' });
  });

  it('ignores reports with a missing or unknown state, so a future state never becomes idle', () => {
    expect(parseProgramStatus('app=cargo')).toBeNull();
    expect(parseProgramStatus('state=paused')).toBeNull();
    expect(parseProgramStatus('state=constructor')).toBeNull();
  });

  it('skips malformed pairs but keeps the rest; last repeated key wins; unknown keys ignored', () => {
    const record = setReport(' state = working : junk : =x : app=a;b : future=1 : progress=10 : progress=40 ');
    expect(record.state).toBe('working');
    expect(record.app).toBeNull(); // `;` is outside the value set → pair skipped
    expect(record.progress).toBe(40);
  });

  it('drops kind outside blocked and progress outside working/blocked or out of range', () => {
    expect(setReport('state=working:kind=auth').kind).toBeNull();
    expect(setReport('state=blocked:kind=telepathy').kind).toBeNull();
    expect(setReport('state=done:progress=50').progress).toBeNull();
    expect(setReport('state=working:progress=101').progress).toBeNull();
    expect(setReport('state=working:progress=-1').progress).toBeNull();
    expect(setReport('state=blocked:progress=100').progress).toBe(100);
  });

  it('treats an app outside its character set as absent', () => {
    expect(setReport('state=idle:app=a,b').app).toBeNull();
  });

  it('accepts unpadded base64 and rejects undecodable base64 or control characters whole', () => {
    expect(setReport(`state=done:msg=${b64('ok!').replace(/=+$/, '')}`).msg).toBe('ok!');
    expect(setReport('state=done:msg=@@@@').msg).toBeNull(); // `@` outside the value set: pair skipped
    expect(parseProgramStatus('state=done:msg=A')).toBeNull(); // length % 4 == 1 cannot decode
    expect(parseProgramStatus(`state=done:msg=${b64('line1\nline2')}`)).toBeNull();
    expect(parseProgramStatus(`state=done:title=${b64('\u009bx')}`)).toBeNull();
  });

  it('enforces size limits by discarding the whole report', () => {
    expect(parseProgramStatus(`state=done:msg=${b64('x'.repeat(2048))}`)).not.toBeNull();
    expect(parseProgramStatus(`state=done:msg=${b64('x'.repeat(2049))}`)).toBeNull();
    expect(parseProgramStatus(`state=done:title=${b64('x'.repeat(193))}`)).toBeNull();
    expect(parseProgramStatus(`state=done:app=${'a'.repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=done:${'k'.repeat(17)}=1`)).toBeNull();
    expect(parseProgramStatus(`state=done:pad=${'a'.repeat(4096)}`)).toBeNull();
  });

  it('validates hierarchical ids and never falls back to the root', () => {
    expect(setReport('state=working:id=deploy/us-east').id).toBe('deploy/us-east');
    expect(parseProgramStatus('state=working:id=a//b')).toBeNull();
    expect(parseProgramStatus(`state=working:id=${'x'.repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=working:id=${Array(9).fill('a').join('/')}`)).toBeNull();
    expect(parseProgramStatus('state=working:id=a,b')).toBeNull();
  });

  it('parses clear with and without an id', () => {
    expect(parseProgramStatus('state=clear')).toEqual({ type: 'clear', id: null });
    expect(parseProgramStatus('state=clear:id=build')).toEqual({ type: 'clear', id: 'build' });
  });
});

describe('ProgramStatusStore', () => {
  function harness() {
    let t = 0;
    const changes: Array<{ viewId: string; next: ProgramStatusSummary | null }> = [];
    const store = new ProgramStatusStore((viewId, _prev, next) => changes.push({ viewId, next }), () => ++t);
    const send = (viewId: string, body: string): void => {
      const report = parseProgramStatus(body);
      if (!report) throw new Error(`rejected: ${body}`);
      store.apply(viewId, report);
    };
    return { store, changes, send };
  }

  it('replaces a record completely: keys missing from the new report are gone', () => {
    const { store, send } = harness();
    send('v', `state=working:app=brew:msg=${b64('Installing')}`);
    send('v', 'state=done');
    expect(store.summary('v')).toMatchObject({ state: 'done', app: null, msg: null });
  });

  it('summarises by priority blocked > error > done > working > idle and inherits app from ancestors', () => {
    const { store, send } = harness();
    send('v', 'state=working:app=deploy');
    send('v', 'state=done:id=us-east');
    send('v', 'state=blocked:kind=permission:id=eu-west/prod');
    expect(store.summary('v')).toMatchObject({ state: 'blocked', kind: 'permission', app: 'deploy', attention: 2 });
  });

  it('clear removes the id and its subtree only; bare clear removes everything', () => {
    const { store, send } = harness();
    send('v', 'state=done:id=build');
    send('v', 'state=error:id=build/test');
    send('v', 'state=working:id=builder');
    send('v', 'state=clear:id=build');
    expect(store.summary('v')?.state).toBe('working');
    send('v', 'state=clear');
    expect(store.summary('v')).toBeNull();
  });

  it('evicts the least recently updated record past the per-view cap', () => {
    const { store, send } = harness();
    send('v', 'state=blocked:id=first');
    for (let i = 0; i < MAX_RECORDS_PER_VIEW; i++) send('v', `state=working:id=r${i}`);
    expect(store.summary('v')?.state).toBe('working'); // `first` was the oldest → evicted
  });

  it('prompt/exit drops working, blocked and idle but keeps done and error', () => {
    const { store, send } = harness();
    send('v', 'state=blocked:id=a');
    send('v', 'state=done:id=b');
    store.dropTransient('v');
    expect(store.summary('v')).toMatchObject({ state: 'done', attention: 1 });
  });

  it('acknowledge drops done and error but keeps a still-blocked record', () => {
    const { store, send } = harness();
    send('v', 'state=error:id=a');
    send('v', 'state=blocked:id=b');
    store.acknowledge('v');
    expect(store.summary('v')).toMatchObject({ state: 'blocked', attention: 1 });
    send('w', 'state=done');
    store.acknowledge('w');
    expect(store.summary('w')).toBeNull();
  });

  it('reports a change only when the summary actually changes, and null on dispose', () => {
    const { store, changes, send } = harness();
    send('v', 'state=working:progress=10');
    send('v', 'state=working:progress=10');
    store.dispose('v');
    expect(changes.map((c) => c.next?.state ?? null)).toEqual(['working', null]);
  });

  it('nextAttention orders blocked, error, done (oldest first) and cycles', () => {
    const { store, send } = harness();
    send('done1', 'state=done');
    send('blocked2', 'state=blocked');
    send('blocked1', 'state=blocked');
    send('err', 'state=error');
    send('busy', 'state=working');
    expect(store.nextAttention(null)).toBe('blocked2');
    expect(store.nextAttention('blocked2')).toBe('blocked1');
    expect(store.nextAttention('blocked1')).toBe('err');
    expect(store.nextAttention('err')).toBe('done1');
    expect(store.nextAttention('done1')).toBe('blocked2');
    expect(store.nextAttention('busy')).toBe('blocked2');
  });
});
