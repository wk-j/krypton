import { describe, expect, it } from 'vitest';

import { executionOutputParts, executionState, parseExecutionPayload } from './harness-execution';
import { compactToolCallForRetention } from './harness-tool-retention';
import type { ExecutionPayload } from './harness-view-types';
import type { ToolCall, ToolCallUpdate } from './types';

const START: ToolCall = {
  toolCallId: 'eval-1', kind: 'execute', status: 'pending', title: 'eval source echo',
  rawInput: { language: 'py', title: 'Count records', code: 'print(3)' },
};

function result(cell: Record<string, unknown> = {}, details: Record<string, unknown> = {}): ToolCallUpdate {
  return {
    toolCallId: START.toolCallId, status: 'in_progress',
    rawOutput: { details: { cells: [{ language: 'python', code: 'print(3)', ...cell }], ...details } },
  };
}

function parsed(update: ToolCall | ToolCallUpdate = START, previous?: ExecutionPayload): ExecutionPayload {
  const payload = parseExecutionPayload('omp', update, previous);
  if (!payload) throw new Error('Expected a recognized execution');
  return payload;
}

function stringSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((size: number, item: unknown) => size + stringSize(item), 0);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce<number>((size, item: unknown) => size + stringSize(item), 0);
  }
  return 0;
}

function jsonView(text: string, value: unknown = { count: 3 }): Record<string, unknown> {
  return { text, view: { kind: 'json', value } };
}

describe('execution recognition and source retention', () => {
  it('recognizes current OMP Python and JavaScript inputs without inspecting the ACP title', () => {
    const python = parsed();
    expect(python).toMatchObject({ source: 'omp', language: 'py', title: 'Count records', code: 'print(3)', output: null });
    const js = parsed({ ...START, title: 'an unrelated title', rawInput: { language: 'js', code: 'console.log(3)' } });
    expect(js.language).toBe('js');
    expect(js.code).toBe('console.log(3)');
    expect(js.title).not.toBe('an unrelated title');
  });

  it('does not recognize other backends, kinds, shell input, or title-only and legacy schemas', () => {
    for (const backend of ['claude', 'codex', 'custom']) {
      expect(parseExecutionPayload(backend, START, parsed())).toBeUndefined();
    }
    const rejected: ToolCall[] = [
      { ...START, kind: 'read' },
      { ...START, kind: undefined },
      { ...START, rawInput: { command: 'python -c "print(3)"' } },
      { ...START, rawInput: { language: 'python', code: 'print(3)' } },
      { ...START, rawInput: { language: 'py', code: 3 } },
      { ...START, rawInput: { cells: [{ language: 'py', code: 'print(3)' }] } },
      { toolCallId: 'x', kind: 'execute', title: 'eval Python print(3)' },
    ];
    for (const call of rejected) expect(parseExecutionPayload('omp', call)).toBeUndefined();
  });

  it('recognizes a single current result cell and normalizes python, including terminal-only replay', () => {
    const payload = parsed({ ...result({ output: '3', status: 'complete', durationMs: 12, title: 'Read totals' }), status: 'completed' });
    expect(payload).toMatchObject({ language: 'py', code: 'print(3)', title: 'Read totals', output: '3', observedLive: false, durationMs: 12 });
    expect(executionState(payload, 'completed')).toBe('complete');
    expect(parsed(result({ language: 'js', code: 'console.log(3)' })).language).toBe('js');
  });

  it('rejects malformed, multiple, unknown-language, or legacy result cells and unrelated explicit tool kinds', () => {
    for (const cells of [[], [{ language: 'python' }], [{ code: 'x', language: 'sh' }],
      [{ code: 'x', language: 'js' }, { code: 'y', language: 'js' }]]) {
      expect(parseExecutionPayload('omp', { toolCallId: 'x', rawOutput: { details: { cells } } })).toBeUndefined();
    }
    expect(parseExecutionPayload('omp', { toolCallId: 'x', rawOutput: { cells: [{ language: 'js', code: 'x' }] } })).toBeUndefined();
    expect(parseExecutionPayload('omp', { ...result(), kind: 'read' })).toBeUndefined();
  });

  it('allows harmless extra wire fields but does not retain arbitrary adapter trees', () => {
    const payload = parsed({ ...START, rawInput: { language: 'py', code: 'print(3)', unknown: { secret: 'input-tree' } },
      rawOutput: { details: { cells: [{ language: 'python', code: 'print(3)', output: '3', unknown: { secret: 'cell-tree' } }] } } });
    expect(Object.keys(payload)).not.toContain('unknown');
    expect(Object.values(payload)).not.toContain('input-tree');
    expect(payload.output).toBe('3');
  });

  it('preserves omitted source/title and permits explicit input updates after recognition', () => {
    const first = parsed();
    const next = parsed({ toolCallId: START.toolCallId, rawInput: { language: 'js', code: 'console.log(4)' } }, first);
    expect(next).toMatchObject({ language: 'js', code: 'console.log(4)', title: first.title });
    const final = parsed({ toolCallId: START.toolCallId, status: 'completed' }, next);
    expect(final).toBe(next);
  });

  it('keeps the bounded display payload when fresh updates omit raw fields after wire compaction', () => {
    const incoming = { ...START, rawInput: { language: 'py', code: 'source\n'.repeat(4000) },
      rawOutput: result({ output: 'result\n'.repeat(5000), statusEvents: [{ op: 'phase', title: 'Collect' }] }).rawOutput };
    const payload = parsed(incoming);
    const retained = compactToolCallForRetention(incoming);
    expect(typeof retained.rawInput).toBe('string');
    expect(typeof retained.rawOutput).toBe('string');
    const next = parsed({ toolCallId: START.toolCallId, status: 'completed', _meta: { unrelated: true } }, payload);
    expect(next).toBe(payload);
    expect(next.code).toBe(payload.code);
    expect(next.activity).toBe(payload.activity);
    expect(next.output).toBe(payload.output);
  });
});

describe('execution snapshot merging', () => {
  it('replaces supplied output, activity, and views rather than appending snapshots', () => {
    const first = parsed(result({ output: 'one', statusEvents: [{ op: 'phase', title: 'First' }], views: [jsonView('one', 1)] }));
    const second = parsed(result({ output: 'two', statusEvents: [{ op: 'log', message: 'Second' }], views: [jsonView('two', 2)] }), first);
    expect(second.output).toBe('two');
    expect(second.activity).toEqual([{ op: 'log', text: 'Second', detail: '' }]);
    expect(second.views).toEqual([{ kind: 'json', text: 'two', json: '2' }]);
    const empty = parsed(result({ output: '', statusEvents: [], views: [] }), second);
    expect(empty.output).toBe('');
    expect(empty.activity).toEqual([]);
    expect(empty.views).toEqual([]);
  });

  it('preserves omitted snapshot fields and reference identities for semantically equal results', () => {
    const update = result({ output: 'three', statusEvents: [{ op: 'phase', title: 'Read' }, { op: 'log', message: '3 rows' }], views: [jsonView('three')] });
    const first = parsed(update);
    expect(parsed(result({ output: 'three', statusEvents: [{ op: 'phase', title: 'Read' }, { op: 'log', message: '3 rows' }], views: [jsonView('three')] }), first)).toBe(first);
    const duration = parsed(result({ durationMs: 12 }), first);
    expect(duration.code).toBe(first.code);
    expect(duration.output).toBe(first.output);
    expect(duration.activity).toBe(first.activity);
    expect(duration.views).toBe(first.views);
    const changed = parsed(result({ statusEvents: [{ op: 'phase', title: 'Read' }, { op: 'log', message: '4 rows' }] }), first);
    expect(changed.activity[0]).toBe(first.activity[0]);
    expect(changed.activity[1].text).toBe('4 rows');
  });

  it('keeps backend phase/log ordering and bounded unknown event details without inventing progress', () => {
    const payload = parsed(result({ statusEvents: [
      { op: 'phase', title: 'Load' }, { op: 'log', message: 'loaded' },
      { op: 'tool', tool: 'read', result: 'ok' }, { op: 'phase', title: 'Summarize' },
    ] }));
    expect(payload.activity.map((event) => event.op)).toEqual(['phase', 'log', 'tool', 'phase']);
    expect(payload.activity.map((event) => event.text)).toEqual(['Load', 'loaded', '', 'Summarize']);
    expect(JSON.parse(payload.activity[2].detail)).toEqual({ op: 'tool', tool: 'read', result: 'ok' });
  });

  it('retains an actual empty output rather than using source-echoing ACP content', () => {
    const payload = parsed({ ...result({ output: '' }), content: [{ type: 'content', content: { type: 'text', text: 'print(3)' } }] }, parsed());
    expect(payload.output).toBe('');
    expect(executionOutputParts(payload)).toEqual([]);
    const absent = parsed({ ...START, content: [{ type: 'content', content: { type: 'text', text: 'print(3)' } }] });
    expect(absent.output).toBeNull();
  });

  it('replaces successful output with an error before cells exist while retaining the source', () => {
    const first = parsed(result({ output: 'success', views: [jsonView('success')], statusEvents: [{ op: 'phase', title: 'Work' }] }), parsed());
    const failed = parsed({ toolCallId: START.toolCallId, status: 'failed', rawOutput: { content: [{ type: 'text', text: 'Runtime unavailable' }] } }, first);
    expect(failed.code).toBe(first.code);
    expect(failed.output).toBe('Runtime unavailable');
    expect(failed.activity).toEqual([]);
    expect(failed.views).toEqual([]);
    expect(executionState(failed, 'failed')).toBe('error');
    const plain = parsed({ toolCallId: START.toolCallId, status: 'failed', rawOutput: 'Kernel stopped' }, first);
    expect(plain.output).toBe('Kernel stopped');
    expect(parseExecutionPayload('omp', { toolCallId: 'unknown', status: 'failed', rawOutput: 'Kernel stopped' })).toBeUndefined();
  });

  it('keeps empty/image-only error output empty and extracts only actual text blocks', () => {
    const first = parsed(result({ output: 'old success' }));
    const image = { type: 'image', data: 'image-data', mimeType: 'image/png' };
    const empty = parsed({ toolCallId: START.toolCallId, status: 'failed', rawOutput: { content: [image] } }, first);
    expect(empty.output).toBe('');
    const mixed = parsed({ toolCallId: START.toolCallId, status: 'failed', rawOutput: {
      content: [image, { type: 'text', text: 'first' }, image, { type: 'text', text: 'last' }],
    } }, first);
    expect(mixed.output).toBe('first\nlast');
    const withoutCells = parsed({ toolCallId: START.toolCallId, status: 'failed', rawOutput: { message: 'No runtime' } }, first);
    expect(JSON.parse(withoutCells.output ?? '')).toEqual({ message: 'No runtime' });
  });

  it('reports metadata errors independently of the ACP success envelope', () => {
    const previous = parsed(result({ output: 'old success' }));
    const failed = parsed({ toolCallId: START.toolCallId, status: 'completed', rawOutput: { details: { isError: true }, content: [{ type: 'text', text: 'Backend failed' }] } }, previous);
    expect(failed.output).toBe('Backend failed');
    expect(failed.isError).toBe(true);
    expect(executionState(failed, 'completed')).toBe('error');
    expect(executionState(parsed(result({ status: 'error', output: 'traceback', exitCode: 1 })), 'completed')).toBe('error');
    expect(executionState(parsed(result({ status: 'complete', exitCode: 0 })), 'failed')).toBe('error');
  });

  it('validates optional scalars and keeps useful previous values when malformed data arrives', () => {
    const first = parsed(result({ durationMs: 10, exitCode: 0, status: 'running' }));
    for (const invalid of [NaN, Infinity, -1, '12']) {
      expect(parsed(result({ durationMs: invalid }), first).durationMs).toBe(10);
    }
    for (const invalid of [NaN, Infinity, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(parsed(result({ exitCode: invalid }), first).exitCode).toBe(0);
    }
    const malformed = parsed(result({ status: 'waiting' }, { isError: 'true', async: { state: 'running', jobId: 123 } }), first);
    expect(malformed.cellStatus).toBe('running');
    expect(malformed.isError).toBe(false);
    expect(malformed.detached).toBeNull();
    expect(parsed(result({ durationMs: 0, exitCode: -2 })).durationMs).toBe(0);
    expect(executionState(parsed(result({ exitCode: -2 })), 'completed')).toBe('error');
  });
});

describe('safe execution output views', () => {
  it('replaces unique exact spans and retains surrounding output in order', () => {
    const payload = parsed(result({ output: 'before JSON between TABLE after', views: [
      jsonView('JSON', { value: '<script>inert</script>' }),
      { text: 'TABLE', view: { kind: 'table', columns: [{ head: 'Name' }, { head: 'Count', numeric: true }], rows: [['a', '3']] } },
    ] }));
    const parts = executionOutputParts(payload);
    expect(parts.map((part) => part.kind)).toEqual(['text', 'view', 'text', 'view', 'text']);
    expect(parts.filter((part) => part.kind === 'text').map((part) => part.text)).toEqual(['before ', ' between ', ' after']);
    expect(payload.views[0].kind === 'json' && JSON.parse(payload.views[0].json)).toEqual({ value: '<script>inert</script>' });
    expect(payload.views[1]).toEqual({ kind: 'table', text: 'TABLE', columns: [{ head: 'Name' }, { head: 'Count', numeric: true }], rows: [['a', '3']] });
  });

  it('preserves raw output for repeated, missing, empty, duplicate, and overlapping spans', () => {
    for (const [output, views] of [
      ['same same', [jsonView('same')]],
      ['unchanged', [jsonView('missing')]],
      ['unchanged', [jsonView('')]],
      ['same', [jsonView('same'), jsonView('same')]],
      ['abcdef', [jsonView('abcd'), jsonView('cdef')]],
      ['aaaa', [jsonView('aaa')]],
    ] as const) {
      expect(executionOutputParts(parsed(result({ output, views })))).toEqual([{ kind: 'text', text: output }]);
    }
  });

  it('can format an unambiguous view while preserving another ambiguous span', () => {
    const payload = parsed(result({ output: 'x x JSON', views: [jsonView('x'), jsonView('JSON')] }));
    expect(executionOutputParts(payload)).toEqual([{ kind: 'text', text: 'x x ' }, { kind: 'view', view: payload.views[1] }]);
  });

  it('falls back to the original text for unsupported or malformed rich data', () => {
    const malformed = [
      { text: 'original', view: { kind: 'markdown', text: '<script>bad()</script>' } },
      { text: 'original', view: { kind: 'json' } },
      { text: 'original', view: { kind: 'table', columns: [{ head: 3 }], rows: [['x']] } },
      { text: 'original', view: { kind: 'table', columns: [{ head: 'x', numeric: 'yes' }], rows: [['x']] } },
      { text: 'original', view: { kind: 'table', columns: [{ head: 'x' }], rows: [[1]] } },
      { text: 'original', view: { kind: 'table', columns: [{ head: 'x' }], rows: [['x', 'y']] } },
    ];
    for (const view of malformed) {
      const payload = parsed(result({ output: 'original', views: [view] }));
      expect(executionOutputParts(payload)).toEqual([{ kind: 'text', text: 'original' }]);
      expect(payload.views).toEqual([]);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parsed(result({ output: 'original', views: [jsonView('original', cyclic)] })).views).toEqual([]);
  });
});

describe('execution retention bounds', () => {
  it('retains a marked source prefix, output tail, and bounded scalar labels', () => {
    const code = 'FIRST\n' + 'c'.repeat(40_000) + '\nLAST';
    const output = 'FIRST\n' + 'o'.repeat(40_000) + '\nLAST';
    const payload = parsed({ ...START, rawInput: { language: 'py', code, title: 't'.repeat(1000) }, rawOutput: result({ output }, { async: { state: 'running', jobId: 'j'.repeat(1000) } }).rawOutput });
    expect(payload.code.length).toBeLessThanOrEqual(16 * 1024);
    expect(payload.code.startsWith('FIRST\n')).toBe(true);
    expect(payload.code.endsWith('\nLAST')).toBe(false);
    expect(payload.output?.length).toBeLessThanOrEqual(24 * 1024);
    expect(payload.output?.endsWith('\nLAST')).toBe(true);
    expect(payload.output?.startsWith('FIRST\n')).toBe(false);
    expect(payload.truncated).toEqual(expect.arrayContaining(['code', 'output']));
    expect(payload.title.length).toBeLessThanOrEqual(256);
    expect(payload.detached?.jobId.length).toBeLessThanOrEqual(128);
    expect(stringSize(payload)).toBeLessThanOrEqual(64 * 1024);
  });

  it('retains only the recent bounded activity tail, with explicit truncation', () => {
    const payload = parsed(result({ statusEvents: Array.from({ length: 30 }, (_, index) => ({ op: 'log', message: `event-${index} ` + 'x'.repeat(400) })) }));
    expect(payload.activity.length).toBeLessThanOrEqual(16);
    expect(stringSize(payload.activity)).toBeLessThanOrEqual(4 * 1024);
    expect(payload.activity[payload.activity.length - 1]?.text.startsWith('event-29 ')).toBe(true);
    expect(payload.activity.some((event) => event.text.startsWith('event-0 '))).toBe(false);
    expect(payload.truncated).toContain('activity');
    expect(payload.activity.some((event) => event.text.includes('…') || event.detail.includes('…'))).toBe(true);
    const op = parsed(result({ statusEvents: [{ op: 'custom'.repeat(30), payload: 'x'.repeat(20_000) }] }));
    expect(op.activity[0].op.length).toBeLessThanOrEqual(32);
    expect(stringSize(op.activity)).toBeLessThanOrEqual(4 * 1024);
  });

  it('bounds rich-view count, serialized JSON, table geometry, and individual strings', () => {
    const many = parsed(result({ views: Array.from({ length: 20 }, (_, index) => jsonView(`view-${index}`, index)) }));
    expect(many.views.length).toBeLessThanOrEqual(8);
    expect(many.truncated).toContain('views');
    const json = parsed(result({ output: 'JSON', views: [jsonView('JSON', { value: 'x'.repeat(40_000) })] }));
    expect(stringSize(json.views)).toBeLessThanOrEqual(16 * 1024);
    expect(json.truncated).toContain('views');
    expect(executionOutputParts(json)).toEqual([{ kind: 'text', text: 'JSON' }]);
    const table = parsed(result({ output: 'table', views: [{ text: 'table', view: {
      kind: 'table', columns: Array.from({ length: 22 }, (_, index) => ({ head: String(index) })),
      rows: Array.from({ length: 110 }, () => Array.from({ length: 22 }, () => 'v')),
    } }] }));
    const view = table.views[0];
    expect(view?.kind).toBe('table');
    if (view?.kind !== 'table') throw new Error('Expected retained table');
    expect(view.columns).toHaveLength(20);
    expect(view.rows).toHaveLength(100);
    expect(table.truncated).toContain('views');
    const cells = parsed(result({ views: [{ text: 'x', view: { kind: 'table', columns: [{ head: 'h'.repeat(1000) }], rows: [['c'.repeat(1000)]] } }] }));
    const cellView = cells.views[0];
    if (cellView?.kind !== 'table') throw new Error('Expected bounded table');
    expect(cellView.columns[0].head.length).toBeLessThanOrEqual(256);
    expect(cellView.rows[0][0].length).toBeLessThanOrEqual(256);
  });

  it('counts every retained string, including view.text, within category and aggregate budgets', () => {
    const payload = parsed({ ...START, rawInput: { language: 'py', code: 'c'.repeat(40_000), title: 't'.repeat(1000) }, rawOutput: result({
      output: 'o'.repeat(40_000),
      statusEvents: Array.from({ length: 40 }, () => ({ op: 'log', message: 'a'.repeat(1000) })),
      views: Array.from({ length: 8 }, () => jsonView('v'.repeat(1000), { value: 'j'.repeat(4000) })),
    }, { async: { state: 's'.repeat(1000), jobId: 'j'.repeat(1000) } }).rawOutput });
    expect(stringSize(payload)).toBeLessThanOrEqual(64 * 1024);
    expect(stringSize(payload.views)).toBeLessThanOrEqual(16 * 1024);
    expect(stringSize(payload.activity)).toBeLessThanOrEqual(4 * 1024);
    const oversizedSpan = parsed(result({ output: 'raw', views: [jsonView('v'.repeat(30_000))] }));
    expect(oversizedSpan.views).toEqual([]);
    expect(oversizedSpan.truncated).toContain('views');
  });

  it('never substitutes rich views against truncated output or view data', () => {
    const payload = parsed(result({ output: 'x'.repeat(30_000) + 'JSON', views: [jsonView('JSON')] }));
    expect(payload.truncated).toContain('output');
    expect(executionOutputParts(payload)).toEqual([{ kind: 'text', text: payload.output }]);
    const error = parsed({ toolCallId: START.toolCallId, status: 'failed', rawOutput: 'e'.repeat(50_000) }, parsed());
    expect(error.output?.length).toBeLessThanOrEqual(24 * 1024);
    expect(error.truncated).toContain('output');
  });
});

describe('execution state and observation semantics', () => {
  it('observes live timing only from explicit pending/in_progress updates and never synthesizes replay time', () => {
    const replay = parsed({ ...START, status: 'completed' });
    expect(replay.observedLive).toBe(false);
    expect(parsed({ ...START, status: undefined }).observedLive).toBe(false);
    const live = parsed({ toolCallId: START.toolCallId, status: 'in_progress' }, replay);
    expect(live.observedLive).toBe(true);
    expect(parsed({ toolCallId: START.toolCallId, status: 'completed' }, live).observedLive).toBe(true);
    expect(parsed().observedLive).toBe(true);
    expect(parsed({ ...result({ status: 'complete' }), status: 'completed' }).durationMs).toBeNull();
  });

  it('prioritizes cancellation, errors, detached snapshots, pending, running, and completion', () => {
    const payload = parsed(result({ status: 'complete', exitCode: 0 }, { async: { state: 'running', jobId: 'job-1' } }));
    expect(executionState(payload, 'completed')).toBe('background');
    expect(executionState(payload, 'pending')).toBe('background');
    expect(executionState(payload, 'cancelled')).toBe('cancelled');
    expect(executionState(payload, 'canceled')).toBe('cancelled');
    expect(executionState(payload, 'failed')).toBe('error');
    const error = parsed(result({ status: 'error' }, { async: { state: 'running', jobId: 'job-1' } }));
    expect(executionState(error, 'completed')).toBe('error');
    expect(executionState(error, 'cancelled')).toBe('cancelled');
    expect(executionState(parsed(), 'pending')).toBe('pending');
    expect(executionState(parsed(result({ status: 'running' })), 'in_progress')).toBe('running');
    expect(executionState(parsed(result({ status: 'running' })), 'completed')).toBe('complete');
  });

  it('preserves last-reported background metadata without assuming a later settlement', () => {
    const first = parsed({ ...result({ status: 'running', output: 'started' }, { async: { state: 'running', jobId: 'job-7' } }), status: 'completed' });
    expect(first.observedLive).toBe(false);
    const statusOnly = parsed({ toolCallId: START.toolCallId, status: 'completed' }, first);
    expect(statusOnly).toBe(first);
    expect(statusOnly.detached).toBe(first.detached);
    expect(executionState(statusOnly, 'completed')).toBe('background');
    const repeated = parsed(result({}, { async: { state: 'running', jobId: 'job-7' } }), first);
    expect(repeated.detached).toBe(first.detached);
    expect(parsed(result({}, { async: { state: '', jobId: '' } }), first).detached).toBe(first.detached);
  });
});
