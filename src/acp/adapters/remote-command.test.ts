import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../types';
import { createLaneDecoder } from './decoder';
import { rawToolUpdate } from './test-utils';
import type { LaneDecoder, ToolView } from './types';

const title = 'mcp__krypton_harness_bus__computer_exec';
const input = { computerId: 'build', command: 'printf hello', cwd: '/srv' };
const ok = { computerId: 'build', exitCode: 0, stdout: 'hello\n', stderr: '', truncated: false, outcome: 'completed' };
const unknown = 'Remote command outcome unknown after timeout, lane cancellation, or disconnect: ';
const inputUnknown = 'Remote command outcome unknown while sending input or connection closed';

function send(decoder: LaneDecoder, update: Partial<ToolCall>, phase: 'tool_call' | 'tool_call_update' = 'tool_call'): ToolView {
  const event = decoder.event(rawToolUpdate(phase, { toolCallId: 'remote', ...update }))[0];
  if (event?.type !== 'tool') throw new Error('Expected decoded tool event');
  return event.view;
}
function mcp(output?: unknown, extra: Partial<ToolCall> = {}, backend = 'claude'): ToolView {
  return send(createLaneDecoder(backend), { title, rawInput: input, ...(output === undefined ? {} : { rawOutput: output }), ...extra });
}
function cli(command: string, output?: unknown): ToolView {
  return send(createLaneDecoder('claude'), { kind: 'execute', rawInput: { command }, ...(output === undefined ? {} : { rawOutput: output }) });
}

describe('remote command decoder — exact recognition', () => {
  it.each(['krypton-harness-bus', 'krypton_harness_bus', 'krypton-harness-memory', 'krypton_harness_memory'])('accepts the exact builtin %s', (server) => {
    expect(mcp(ok, { title: `mcp__${server}__computer_exec` }).remoteCommand?.result?.stdout).toBe('hello\n');
  });
  it.each(['mcp__foreign__computer_exec', 'mcp__krypton_harness_bus__computer_exec_extra', 'computer_exec', 'run mcp__krypton_harness_bus__computer_exec', 'mcp__KRYPTON_HARNESS_BUS__computer_exec'])('rejects lookalike %s', (name) => {
    expect(mcp(ok, { title: name }).remoteCommand).toBeUndefined();
  });
  it('honors adapter-refined contradictory metadata', () => {
    expect(mcp(ok, { _meta: { claudeCode: { toolName: 'mcp__foreign__computer_exec' } } }).remoteCommand).toBeUndefined();
    expect(mcp(ok, { _meta: { claudeCode: { toolName: title, mcpServer: { name: 'foreign' } } } }).remoteCommand).toBeUndefined();
  });
  it.each([
    { claudeCode: { toolName: 'mcp__foreign__computer_exec' } },
    { claudeCode: { toolName: title, mcpServer: { name: 'foreign' } } },
  ])('never reinterprets a rejected MCP request as its nested CLI command', (_meta) => {
    const decoder = createLaneDecoder('claude');
    const rawInput = { ...input, command: 'kryptonctl computer exec nested -- pwd' };
    expect(send(decoder, { title, kind: 'execute', rawInput, _meta }).remoteCommand).toBeUndefined();
    const later = createLaneDecoder('claude');
    expect(send(later, { title, kind: 'execute', rawInput }).remoteCommand?.computerId).toBe('build');
    expect(send(later, { _meta }, 'tool_call_update').remoteCommand).toBeUndefined();
  });
  it('drops a CLI card when a later MCP identity is rejected', () => {
    const decoder = createLaneDecoder('claude');
    send(decoder, { kind: 'execute', rawInput: { command: 'kryptonctl computer exec build -- pwd' } });
    expect(send(decoder, { title, _meta: { claudeCode: { toolName: 'mcp__foreign__computer_exec' } } }, 'tool_call_update').remoteCommand).toBeUndefined();
  });
  it.each([{ computerId: 'build' }, { ...input, computerId: 2 }, { ...input, cwd: 3 }])('rejects incomplete request %j', (rawInput) => {
    expect(mcp(ok, { rawInput }).remoteCommand).toBeUndefined();
  });
  it('does not specialize artifact paths', () => {
    expect(mcp(ok, { locations: [{ path: '/repo/.krypton/artifacts/report.html' }] }).remoteCommand).toBeUndefined();
  });
  it('leaves subagent-owned remote calls to their existing presentation', () => {
    expect(mcp(ok, { _meta: { claudeCode: { parentToolUseId: 'parent' } } }).remoteCommand).toBeUndefined();
  });
  it('does not infer a call hidden inside an OMP code cell', () => {
    const view = send(createLaneDecoder('omp'), { title: 'execute', kind: 'execute', rawInput: { language: 'js', code: 'await tools.computer_exec({computerId:"build"})', command: 'kryptonctl computer exec build -- pwd' }, rawOutput: ok });
    expect(view.remoteCommand).toBeUndefined();
    expect(view.execution).toBeDefined();
  });
});

describe('remote command decoder — direct CLI words', () => {
  it.each(['kryptonctl', '"$KRYPTONCTL_PATH"'])('recognizes %s and preserves quoted/empty words', (executable) => {
    const view = cli(`${executable} --json computer exec 'build' --cwd '/srv/a b' --timeout 20 -- printf '' 'a b' "c\\\"d" '$(literal)'`);
    expect(view.remoteCommand).toMatchObject({ source: 'cli', computerId: 'build', cwd: '/srv/a b', command: 'printf  a b c"d $(literal)' });
  });
  it('removes first json and then first yes anywhere, including remote words', () => {
    expect(cli('kryptonctl computer exec build -- echo --json --yes --json --yes').remoteCommand?.command).toBe('echo --json --yes');
    expect(cli('kryptonctl computer exec --json --yes build -- echo').remoteCommand?.computerId).toBe('build');
  });
  it('mirrors option parsing after global flag removal', () => {
    expect(cli('kryptonctl computer exec build --cwd --json /srv -- echo').remoteCommand?.cwd).toBe('/srv');
    expect(cli('kryptonctl computer exec build --cwd /one --cwd /two --timeout +2 -- echo').remoteCommand?.cwd).toBe('/two');
    expect(cli('kryptonctl computer exec build -- ""').remoteCommand?.command).toBe('');
  });
  it.each([
    '/usr/bin/kryptonctl computer exec build -- pwd', '"kryptonctl" computer exec build -- pwd',
    '$KRYPTONCTL_PATH computer exec build -- pwd', 'env kryptonctl computer exec build -- pwd',
    'kryptonctl computer exec build -- pwd; echo x', 'kryptonctl computer exec build -- pwd && echo x',
    'kryptonctl computer exec build -- pwd | cat', 'kryptonctl computer exec build -- pwd > out',
    'kryptonctl computer exec build -- $(pwd)', 'kryptonctl computer exec build -- "$HOME"',
    'kryptonctl computer exec build -- `pwd`', 'kryptonctl computer exec build -- *.ts',
    'kryptonctl computer exec build -- "unterminated', 'kryptonctl computer exec build -- pwd\necho x',
    'kryptonctl computer exec build --timeout -1 -- pwd', 'kryptonctl computer exec build --timeout 18446744073709551616 -- pwd',
    'kryptonctl computer exec build --other x -- pwd', 'kryptonctl computer exec build --',
  ])('keeps indirect/complex/invalid input generic: %s', (script) => {
    expect(cli(script, { stdout: JSON.stringify(ok) }).remoteCommand).toBeUndefined();
  });
  it('honors POSIX escapes without treating quoted shell syntax as local syntax', () => {
    expect(cli(String.raw`kryptonctl computer exec build -- echo a\ b "\$HOME" 'a;b|c'`).remoteCommand?.command).toBe('echo a b $HOME a;b|c');
  });
});

describe('remote command decoder — production terminal channels', () => {
  const output = (data: string) => ({ _meta: { terminal_output: { terminal_id: 'c1', data } } });
  const exit = { _meta: { terminal_exit: { terminal_id: 'c1', exit_code: 0, signal: null } } };
  const start = (backend: string) => {
    const decoder = createLaneDecoder(backend);
    send(decoder, { kind: 'execute', status: 'in_progress', rawInput: { command: 'kryptonctl computer exec build -- pwd' } });
    return decoder;
  };
  it.each(['claude', 'codex'])('reads %s terminal output and keeps remote exit distinct from shell exit', (backend) => {
    const decoder = start(backend);
    const view = send(decoder, output(JSON.stringify({ ...ok, exitCode: 7, stderr: 'remote failure\n' })), 'tool_call_update');
    expect(view.remoteCommand?.result).toMatchObject({ exitCode: 7, stderr: 'remote failure\n' });
    const done = send(decoder, { ...exit, status: 'completed' }, 'tool_call_update');
    expect(done.remoteCommand?.result?.exitCode).toBe(7);
    expect(done.sections).toEqual([]);
  });
  it('assembles Codex chunks before terminal preview compaction and retains a late result', () => {
    const decoder = start('codex');
    const text = JSON.stringify({ ...ok, stdout: 'x'.repeat(25_000), stderr: 'tail\n' });
    const partial = send(decoder, output(text.slice(0, 12_000)), 'tool_call_update');
    expect(partial.remoteCommand).toMatchObject({ result: null, error: null, outcomeUnknown: false });
    send(decoder, output(text.slice(12_000, 20_000)), 'tool_call_update');
    const view = send(decoder, output(text.slice(20_000)), 'tool_call_update');
    expect(view.remoteCommand?.result).toMatchObject({ stdout: 'x'.repeat(16_384), stderr: 'tail\n', truncated: false });
    expect(view.remoteCommand?.displayTruncated).toEqual(['stdout']);
    const done = send(decoder, { ...exit, status: 'completed' }, 'tool_call_update');
    expect(done.remoteCommand).toBe(view.remoteCommand);
    expect(done.sections).toEqual([]);
  });
  it('decodes a whole Claude result larger than its retained terminal preview', () => {
    const decoder = start('claude');
    const view = send(decoder, output(JSON.stringify({ ...ok, stdout: '界'.repeat(10_000), stderr: 'kept' })), 'tool_call_update');
    expect(view.remoteCommand?.result?.stdout).toBe('界'.repeat(5_461));
    expect(view.remoteCommand?.result?.stderr).toBe('kept');
    expect(view.remoteCommand?.displayTruncated).toEqual(['stdout']);
  });
  it('reads unknown-outcome errors split across terminal chunks', () => {
    const decoder = start('codex');
    const text = `kryptonctl: computer_exec_failed: Remote command outcome unknown after timeout, lane cancellation, or disconnect: ${JSON.stringify({ ...ok, outcome: 'unknown', exitCode: null, stdout: 'partial\n' })}`;
    send(decoder, output(text.slice(0, 100)), 'tool_call_update');
    const view = send(decoder, output(text.slice(100)), 'tool_call_update');
    expect(view.remoteCommand).toMatchObject({ outcomeUnknown: true, result: { outcome: 'unknown', exitCode: null, stdout: 'partial\n' } });
  });
});

describe('remote command decoder — result envelopes and errors', () => {
  it.each([ok, JSON.stringify(ok), { content: [{ type: 'text', text: JSON.stringify(ok) }], isError: false }])('decodes known MCP envelope %j', (output) => {
    expect(mcp(output).remoteCommand?.result).toMatchObject({ exitCode: 0, stdout: 'hello\n', stderr: '' });
    expect(mcp(output).sections).toEqual([]);
  });
  it('decodes ACP content text before generic line compaction', () => {
    const result = { ...ok, stdout: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') };
    const view = mcp(undefined, { content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result, null, 2) } }] });
    expect(view.remoteCommand?.result?.stdout).toContain('line 99');
  });
  it('reads CLI stdout independently of its outer shell exit', () => {
    const view = cli('kryptonctl computer exec build -- pwd', { stdout: JSON.stringify({ ...ok, exitCode: 7, stderr: '  failure\n' }), exit_code: 0 });
    expect(view.remoteCommand?.result).toMatchObject({ exitCode: 7, stderr: '  failure\n' });
  });
  it.each([null, 0, 5])('retains empty streams and nullable exit %s', (exitCode) => {
    expect(mcp({ ...ok, stdout: '', stderr: '', exitCode }).remoteCommand?.result).toMatchObject({ stdout: '', stderr: '', exitCode });
  });
  it.each([
    { ...ok, computerId: 'other' }, { nested: ok }, { ...ok, stdout: 3 }, { ...ok, exitCode: 1.5 },
    { ...ok, outcome: 'success' }, { ...ok, truncated: undefined }, '{"computerId":"build",',
  ])('does not fabricate a valid result from %j', (output) => {
    const view = mcp(output, { status: 'completed' });
    expect(view.remoteCommand?.result ?? null).toBeNull();
    expect(view.sections.length).toBeGreaterThan(0);
  });
  it('keeps an undecodable completed response diagnostic without inventing a tool failure', () => {
    const view = mcp('{"computerId":"build",', { status: 'completed' });
    expect(view.remoteCommand).toMatchObject({ result: null, error: null, outcomeUnknown: false });
    expect(view.sections.some((section) => section.text.includes('computerId'))).toBe(true);
  });
  it('falls back entirely for a result from a different computer', () => {
    expect(mcp({ ...ok, computerId: 'other' }).remoteCommand).toBeUndefined();
  });
  it('does not hide extra content it does not own', () => {
    const view = mcp({ content: [{ type: 'text', text: JSON.stringify(ok) }, { type: 'text', text: 'unrelated diagnostic' }] });
    expect(view.sections.length).toBeGreaterThan(0);
    expect(view.remoteCommand?.result).toBeNull();
  });
  it('accepts identical mirrored envelopes but not conflicting completed results', () => {
    const content: ToolCall['content'] = [{ type: 'content', content: { type: 'text', text: JSON.stringify(ok) } }];
    expect(mcp(ok, { content }).remoteCommand?.result?.exitCode).toBe(0);
    expect(mcp({ ...ok, exitCode: 9 }, { content }).remoteCommand?.result).toBeNull();
  });
  it('keeps extra ACP diagnostics alongside a raw result', () => {
    const view = mcp(ok, { content: [{ type: 'content', content: { type: 'text', text: 'unrelated diagnostic' } }] });
    expect(view.sections.some((section) => section.text.includes('unrelated diagnostic'))).toBe(true);
  });
  it('preserves MCP error-envelope diagnostics even with a result-shaped success', () => {
    const view = mcp({ content: [{ type: 'text', text: JSON.stringify(ok) }], isError: true });
    expect(view.remoteCommand?.error).toBe('Remote command tool reported an error');
    expect(view.sections.length).toBeGreaterThan(0);
  });
  it('records unknown structured outcome regardless of included exit or outer success', () => {
    expect(mcp({ ...ok, outcome: 'unknown', exitCode: 0 }, { status: 'completed' }).remoteCommand?.outcomeUnknown).toBe(true);
  });
  it('decodes exact unknown error with partial output and CLI wrapper', () => {
    const text = unknown + JSON.stringify({ ...ok, outcome: 'unknown', stdout: 'partial', exitCode: null });
    const view = cli('kryptonctl computer exec build -- pwd', { stderr: `kryptonctl: computer_exec_failed: ${text}\n`, exit_code: 1 });
    expect(view.remoteCommand).toMatchObject({ outcomeUnknown: true, result: { stdout: 'partial', exitCode: null }, error: text });
  });
  it('handles exact unknown input failure and decline without inventing an exit', () => {
    expect(mcp({ content: [{ type: 'text', text: inputUnknown }], isError: true }).remoteCommand).toMatchObject({ outcomeUnknown: true, result: null, error: inputUnknown });
    expect(mcp('Remote command declined or approval expired').remoteCommand).toMatchObject({ outcomeUnknown: false, result: null, error: 'Remote command declined or approval expired' });
  });
  it.each([`prefix ${inputUnknown}`, `${inputUnknown} suffix`, `kryptonctl: wrong_code: ${inputUnknown}`])('never searches embedded unknown prefix: %s', (text) => {
    expect(cli('kryptonctl computer exec build -- pwd', { stderr: text }).remoteCommand?.outcomeUnknown).toBe(false);
  });
  it('keeps malformed unknown result diagnostic instead of claiming success', () => {
    const view = mcp(unknown + '{"computerId":', { status: 'completed' });
    expect(view.remoteCommand).toMatchObject({ result: null, outcomeUnknown: true });
    expect(view.sections.length).toBeGreaterThan(0);
  });
});

describe('remote command decoder — retention and update identity', () => {
  it('preserves payload identity on status-only, repeated and partial output updates', () => {
    const decoder = createLaneDecoder('claude');
    const first = send(decoder, { title, rawInput: input, rawOutput: ok, status: 'in_progress' });
    const status = send(decoder, { status: 'completed' }, 'tool_call_update');
    const repeat = send(decoder, { rawOutput: ok }, 'tool_call_update');
    const partial = send(decoder, { rawOutput: '{"computerId":' }, 'tool_call_update');
    expect(status.remoteCommand).toBe(first.remoteCommand);
    expect(repeat.remoteCommand).toBe(first.remoteCommand);
    expect(partial.remoteCommand).toBe(first.remoteCommand);
    expect(partial.sections.length).toBeGreaterThan(0);
  });
  it('does not reparse compacted output on status-only updates', () => {
    const decoder = createLaneDecoder('claude');
    const first = send(decoder, { title, rawInput: input, rawOutput: { ...ok, stdout: '😀'.repeat(8000) } });
    const last = send(decoder, { status: 'completed' }, 'tool_call_update');
    expect(last.remoteCommand).toBe(first.remoteCommand);
    expect(last.remoteCommand?.result?.stdout).toBe('😀'.repeat(4096));
    expect(last.sections).toBe(first.sections);
  });
  it('preserves a request longer than wire retention across late results and stale active frames', () => {
    const decoder = createLaneDecoder('claude');
    const command = '😀'.repeat(10_000);
    const first = send(decoder, { title, rawInput: { ...input, command }, status: 'completed' });
    const late = send(decoder, { rawOutput: ok, status: 'in_progress' }, 'tool_call_update');
    expect(late.status).toBe('completed');
    expect(late.remoteCommand?.command).toBe(first.remoteCommand?.command);
    expect(late.remoteCommand?.result?.exitCode).toBe(0);
    expect(late.remoteCommand).not.toBe(first.remoteCommand);
  });
  it('lets final transport failure outrank a prior completed snapshot and never reopens it', () => {
    const decoder = createLaneDecoder('claude');
    send(decoder, { title, rawInput: input, rawOutput: ok, status: 'completed' });
    const failed = send(decoder, { status: 'failed', rawOutput: 'transport failed' }, 'tool_call_update');
    expect(failed.status).toBe('failed');
    expect(failed.remoteCommand?.error).toBe('transport failed');
    expect(send(decoder, { status: 'in_progress' }, 'tool_call_update').status).toBe('failed');
  });
  it.each(['pending', 'in_progress', 'completed', 'failed', 'canceled'])('retains outer status %s without inventing result', (status) => {
    const view = mcp(undefined, { status: status as ToolCall['status'] });
    expect(view.status).toBe(status);
    expect(view.remoteCommand?.result).toBeNull();
  });
  it('invalidates specialization on contradictory later identity', () => {
    const decoder = createLaneDecoder('claude');
    send(decoder, { title, rawInput: input, rawOutput: ok });
    expect(send(decoder, { title: 'mcp__foreign__computer_exec' }, 'tool_call_update').remoteCommand).toBeUndefined();
  });
  it('bounds every retained field on UTF-8 boundaries independently of backend truncation', () => {
    const view = mcp({ ...ok, computerId: '😀'.repeat(1000), stdout: '😀'.repeat(5000), stderr: '界'.repeat(6000), truncated: false }, {
      rawInput: { computerId: '😀'.repeat(1000), command: '😀'.repeat(5000), cwd: '界'.repeat(1000) },
    });
    const p = view.remoteCommand!;
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    expect(bytes(p.computerId)).toBe(1024);
    expect(bytes(p.cwd!)).toBeLessThanOrEqual(1024);
    expect(bytes(p.command)).toBe(16384);
    expect(bytes(p.result!.stdout)).toBe(16384);
    expect(bytes(p.result!.stderr)).toBeLessThanOrEqual(16384);
    expect(p.result!.truncated).toBe(false);
    expect(p.displayTruncated).toEqual(['computerId', 'cwd', 'command', 'stdout', 'stderr']);
  });
  it('matches full long IDs before bounding and after compacted request updates', () => {
    const decoder = createLaneDecoder('claude');
    const computerId = 'a'.repeat(2000);
    send(decoder, { title, rawInput: { ...input, computerId, command: 'x'.repeat(30_000) }, status: 'completed' });
    const late = send(decoder, { rawOutput: { ...ok, computerId } }, 'tool_call_update');
    expect(late.remoteCommand?.result?.exitCode).toBe(0);
    const wrong = send(decoder, { rawOutput: { ...ok, computerId: 'a'.repeat(1999) + 'b' } }, 'tool_call_update');
    expect(wrong.remoteCommand).toBeUndefined();
  });
  it('accepts the exact internal ID cap while retaining only the bounded display', () => {
    const computerId = '😀'.repeat(4096);
    const view = mcp({ ...ok, computerId }, { rawInput: { ...input, computerId } });
    expect(view.remoteCommand?.result?.exitCode).toBe(0);
    expect(view.remoteCommand?.computerId).toBe('😀'.repeat(256));
  });
  it('falls back generically above the internal exact-ID retention cap', () => {
    const computerId = '😀'.repeat(4097);
    const view = mcp({ ...ok, computerId }, { rawInput: { ...input, computerId } });
    expect(view.remoteCommand).toBeUndefined();
    expect(view.sections.length).toBeGreaterThan(0);
  });
  it('bounds error text and keeps backend truncation separate', () => {
    const error = '界'.repeat(2000);
    const p = mcp(error).remoteCommand!;
    expect(new TextEncoder().encode(p.error!).length).toBeLessThanOrEqual(4096);
    expect(p.displayTruncated).toContain('error');
    const truncated = mcp({ ...ok, truncated: true }).remoteCommand!;
    expect(truncated.result?.truncated).toBe(true);
    expect(truncated.displayTruncated).toEqual([]);
  });
});
