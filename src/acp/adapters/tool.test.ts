import { describe, expect, it } from 'vitest';

import { toolPayloadFromView } from '../harness-transcript-items';
import {
  TOOL_DIFF_DISPLAY_CHAR_LIMIT,
  TOOL_DIFF_DISPLAY_COUNT_LIMIT,
} from '../harness-tool-retention';
import type { ToolCall } from '../types';
import { createLaneDecoder } from './decoder';
import { permissionEvent, rawToolUpdate, type ToolEvent } from './test-utils';
import { TERMINAL_OUTPUT_CHAR_LIMIT, TOOL_STATE_TERMINAL_CAP } from './tool';
import type { LaneDecoder, ToolView } from './types';

function send(decoder: LaneDecoder, kind: 'tool_call' | 'tool_call_update', call: Partial<ToolCall>): ToolEvent | null {
  const [event] = decoder.event(rawToolUpdate(kind, call));
  return event?.type === 'tool' ? event : null;
}

/** The view after a `tool_call` and its updates, on a lane of `backend`. */
function decode(backend: string, call: Partial<ToolCall>, ...updates: Partial<ToolCall>[]): ToolView {
  const decoder = createLaneDecoder(backend);
  let event = send(decoder, 'tool_call', { toolCallId: 'c1', ...call });
  for (const update of updates) event = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...update }) ?? event;
  if (!event) throw new Error('no tool event');
  return event.view;
}

describe('tool decoding — generic', () => {
  it('does not show an opaque terminal handle as command output', () => {
    const view = decode('claude', {
      kind: 'execute',
      title: 'Execute rg -n modal src',
      status: 'completed',
      content: [{ type: 'terminal', terminalId: 'exec-415bef9a' }],
    });
    expect(view.sections).toEqual([]);
    expect(toolPayloadFromView(view, {}, undefined).result).toBe('');
  });

  it('keeps real stdout when a terminal handle accompanies it', () => {
    const view = decode('claude', {
      kind: 'execute',
      title: 'Execute rg -n modal src',
      status: 'completed',
      content: [{ type: 'terminal', terminalId: 'exec-opaque' }],
      rawOutput: { stdout: 'src/modal.ts:7:modal' },
    });
    expect(view.sections).toEqual([{ label: 'stdout', text: 'src/modal.ts:7:modal' }]);
  });

  it('keeps a diff, bounded, without adding a result label', () => {
    const huge = 'x'.repeat(40_000);
    const view = decode('codex', {
      kind: 'edit',
      status: 'completed',
      content: [
        { type: 'terminal', terminalId: 'exec-opaque' },
        ...Array.from({ length: 20 }, (_, index) => ({
          type: 'diff' as const, path: `file-${index}.ts`, oldText: huge, newText: huge,
        })),
      ],
    });
    const chars = view.diffs.reduce((total, diff) => total + diff.oldText.length + diff.newText.length, 0);
    expect(view.diffs.length).toBeGreaterThan(0);
    expect(view.diffs.length).toBeLessThanOrEqual(TOOL_DIFF_DISPLAY_COUNT_LIMIT);
    expect(chars).toBeLessThanOrEqual(TOOL_DIFF_DISPLAY_CHAR_LIMIT);
    expect(toolPayloadFromView(view, {}, undefined).result).toBe('');
  });

  it('keeps output and diff references when a late update only changes status', () => {
    const decoder = createLaneDecoder('claude');
    const first = send(decoder, 'tool_call', {
      toolCallId: 'late',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'npm test' },
      rawOutput: { stdout: 'kept output' },
      content: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
    });
    const last = send(decoder, 'tool_call_update', { toolCallId: 'late', status: 'completed' });
    expect(last?.view.status).toBe('completed');
    expect(last?.view.command).toBe('npm test');
    expect(last?.view.sections).toBe(first?.view.sections);
    expect(last?.view.diffs).toBe(first?.view.diffs);
  });

  it('drops an update for a call it never saw', () => {
    expect(send(createLaneDecoder('grok'), 'tool_call_update', { toolCallId: 'ghost', status: 'completed' })).toBeNull();
  });

  it('forgets every call on reset', () => {
    const decoder = createLaneDecoder('grok');
    send(decoder, 'tool_call', { toolCallId: 'c', status: 'in_progress' });
    decoder.reset();
    expect(send(decoder, 'tool_call_update', { toolCallId: 'c', status: 'completed' })).toBeNull();
  });

  it('never evicts a live call, however many settled calls follow', () => {
    const decoder = createLaneDecoder('codex');
    send(decoder, 'tool_call', { toolCallId: 'live', status: 'in_progress' });
    for (let i = 0; i < TOOL_STATE_TERMINAL_CAP + 10; i += 1) {
      send(decoder, 'tool_call', { toolCallId: `done-${i}`, status: 'completed' });
    }
    expect(send(decoder, 'tool_call_update', { toolCallId: 'live', status: 'completed' })?.view.status).toBe('completed');
    expect(send(decoder, 'tool_call_update', { toolCallId: 'done-0', status: 'failed' })).toBeNull();
  });

  it('reads the exact mcp__<server>__<tool> title as the MCP identity, and nothing else', () => {
    expect(decode('codex', { title: 'mcp__krypton_inline__host_exec' }).mcp)
      .toEqual({ server: 'krypton_inline', tool: 'host_exec' });
    expect(decode('codex', { title: 'run mcp__a__b now' }).mcp).toBeNull();
    expect(decode('codex', { title: 'host_exec', rawInput: { server: 'krypton_inline', tool: 'host_exec' } }).mcp).toBeNull();
  });

  it('describes the call for every surface: title, tool name, command line, paths', () => {
    const view = decode('codex', {
      kind: 'edit',
      title: '  Edit src/a.ts  ',
      rawInput: { toolName: 'apply_patch', command: 'patch -p1', file_path: '/repo/.krypton/artifacts/x.html' },
      locations: [{ path: '/repo/src/a.ts' }],
    });
    expect(view.title).toBe('Edit src/a.ts');
    expect(view.toolName).toBe('apply_patch');
    expect(view.commandLine).toBe('patch -p1');
    expect(view.modifiedPath).toBe('/repo/src/a.ts');
    expect(view.locations).toEqual(['/repo/src/a.ts']);
    expect(view.inputPaths).toEqual(['/repo/.krypton/artifacts/x.html']);
  });
});

describe('tool decoding — Grok only', () => {
  const grokBash = {
    title: 'git commit',
    kind: 'execute' as const,
    status: 'completed' as const,
    rawInput: { command: 'git commit -m x' },
    rawOutput: {
      type: 'Bash',
      exit_code: 0,
      output_for_prompt: 'exit: 0\n[master 599d8d8] feat(palette): navigate results\n 3 files changed\n',
    },
  };

  it('peels Grok Bash output_for_prompt before the line cap', () => {
    const view = decode('grok', grokBash);
    expect(view.exit).toBe(0);
    expect(view.sections[0]?.text).toContain('[master 599d8d8]');
    expect(view.sections[0]?.text).not.toContain('exit: 0');
  });

  it('leaves an `exit: N` first line as text on other lanes', () => {
    const view = decode('claude', {
      kind: 'execute', status: 'completed', rawInput: { command: 'cat log' },
      rawOutput: { stdout: 'exit: 3\nnext line' },
    });
    expect(view.exit).toBeNull();
    expect(view.sections[0]?.text).toBe('exit: 3\nnext line');
  });

  it('unwraps search XML before the 6-line cap so the close tag is not required', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `/Users/wk/Source/krypton/src/f${i}.ts\n${i}:  hit`);
    const view = decode('grok', {
      title: 'SEARCH',
      kind: 'search',
      status: 'completed',
      rawOutput: {
        stdout: `<workspace_result workspace_path="/Users/wk/Source/krypton">\nFound at least 67 matching lines\n${lines.join('\n')}\n</workspace_result>`,
      },
    });
    expect(view.sections[0]?.text).not.toContain('workspace_result');
    expect(view.sections[0]?.text).toContain('src/f0.ts');
    expect(view.sections[0]?.text.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('strips read_file line anchors on Grok lanes only', () => {
    const read = {
      title: 'READ',
      kind: 'read' as const,
      status: 'completed' as const,
      content: [{ type: 'content' as const, content: { type: 'text' as const, text: '1→---\nname: karpathy-guidelines' } }],
    };
    expect(decode('grok', read).sections[0]?.text).toBe('---\nname: karpathy-guidelines');
    expect(decode('codex', read).sections[0]?.text).toBe('1→---\nname: karpathy-guidelines');
  });

  it('paints structured grep and typed reads from Grok rawOutput', () => {
    const xml = '<workspace_result workspace_path="/Users/wk/Source/krypton">\nNo matches found\n</workspace_result>';
    const grep = decode('grok', {
      title: 'grep',
      kind: 'search',
      status: 'completed',
      rawOutput: {
        type: 'GrepSearch',
        stdout: Array.from(new TextEncoder().encode(xml)),
        file_matches: [{ path: '/Users/wk/Source/krypton/src/a.ts', matches: [{ line_number: 10, content: 'hit' }] }],
      },
    });
    expect(grep.sections[0]?.text).toContain('src/a.ts');
    expect(grep.sections[0]?.text).toContain('10:hit');
    expect(grep.sections[0]?.text).not.toContain('workspace_result');

    const read = decode('grok', {
      title: 'READ',
      kind: 'read',
      status: 'completed',
      rawOutput: { type: 'ReadFile', FileContent: { content: '1→---\nname: skill' } },
    });
    expect(read.sections[0]?.text).toBe('---\nname: skill');
  });
});

describe('tool decoding — Claude', () => {
  const childMeta = { claudeCode: { parentToolUseId: 'toolu_task' } };

  it('remembers the subagent parent after updates stop carrying _meta', () => {
    const view = decode('claude', { title: 'Read a.ts', _meta: childMeta }, { status: 'completed' });
    expect(view.parentId).toBe('toolu_task');
    expect(decode('codex', { title: 'Read a.ts', _meta: childMeta }).parentId).toBeNull();
  });

  it('voids the MCP identity when Claude metadata names another tool or server', () => {
    const title = 'mcp__krypton_inline__host_exec';
    expect(decode('claude', { title, _meta: { claudeCode: { toolName: title } } }).mcp)
      .toEqual({ server: 'krypton_inline', tool: 'host_exec' });
    expect(decode('claude', { title, _meta: { claudeCode: { toolName: 'mcp__evil__host_exec' } } }).mcp).toBeNull();
    expect(decode('claude', { title, _meta: { claudeCode: { toolName: title, mcpServer: { name: 'evil' } } } }).mcp).toBeNull();
  });

  it('reads a run_in_background launch on Claude lanes only', () => {
    const launch = {
      title: 'npm run watch',
      kind: 'execute' as const,
      rawInput: { command: 'npm run watch' },
      content: [{
        type: 'content' as const,
        content: { type: 'text' as const, text: 'Command running in background with ID: bx1. Output is being written to: /tmp/bx1.out' },
      }],
    };
    expect(decode('claude', launch).background).toEqual({ id: 'bx1', outputPath: '/tmp/bx1.out', command: 'npm run watch' });
    expect(decode('grok', launch).background).toBeNull();
  });

  const launchText = 'Command running in background with ID: bx1. Output is being written to: /tmp/bx1.out';
  const background = { id: 'bx1', outputPath: '/tmp/bx1.out', command: 'npm run watch' };
  const backgroundCall = {
    title: 'Watch project',
    kind: 'execute' as const,
    rawInput: { command: 'npm run watch', run_in_background: true },
  };

  it.each([
    { stdout: launchText },
    launchText,
    { message: launchText },
  ])('reads generic rawOutput launches only on Claude lanes: %j', (rawOutput) => {
    const call = { ...backgroundCall, rawOutput };
    expect(decode('claude', call).background).toEqual(background);
    expect(decode('codex', call).background).toBeNull();
  });

  it('captures a rawOutput launch beyond the displayed output lines', () => {
    const view = decode('claude', {
      ...backgroundCall,
      rawOutput: { stdout: `${'still starting\n'.repeat(30)}${launchText}` },
    });
    expect(view.background).toEqual(background);
    expect(view.sections.some((section) => section.text.includes(launchText))).toBe(false);
  });

  it('prefers content, then terminal launch text over rawOutput', () => {
    const terminalText = launchText.replaceAll('bx1', 'terminal');
    const rawOutput = { stdout: launchText.replaceAll('bx1', 'raw') };
    const call = {
      ...backgroundCall,
      rawOutput,
      content: [{ type: 'content' as const, content: { type: 'text' as const, text: launchText } }],
      _meta: { terminal_output: { terminal_id: 'c1', data: terminalText } },
    };
    expect(decode('claude', call).background).toEqual(background);
    expect(decode('claude', { ...call, content: [] }).background)
      .toEqual({ ...background, id: 'terminal', outputPath: '/tmp/terminal.out' });
  });

  it.each([
    { stdout: launchText.replace('/tmp/bx1.out', 'tmp/bx1.out') },
    { stdout: 'Command is running in the background.' },
    { stdout: 'ordinary command output' },
    undefined,
  ])('does not infer a launch from a flag or unvalidated output: %j', (rawOutput) => {
    expect(decode('claude', { ...backgroundCall, rawOutput }).background).toBeNull();
  });

});

describe('tool decoding — Codex', () => {
  it('turns a Guardian assessment into its own card with no output copy', () => {
    const view = decode('codex', {
      toolCallId: 'guardian_assessment:1',
      kind: 'think',
      title: 'Guardian Review',
      status: 'completed',
      rawOutput: { review: { status: 'approved', riskLevel: 'low', rationale: 'reads only' } },
      content: [{ type: 'content', content: { type: 'text', text: 'Status: approved' } }],
    });
    expect(view.guardianReview).toBeDefined();
    expect(view.sections).toEqual([]);
    expect(view.diffs).toEqual([]);
  });
});

describe('tool decoding — OMP', () => {
  it('keeps a settled background spawn settled while it keeps reporting', () => {
    const view = decode(
      'omp',
      { title: 'task', status: 'completed' },
      { status: 'in_progress', rawOutput: { details: { async: { state: 'running' } } } },
    );
    expect(view.status).toBe('completed');
  });

  it('reports a wait snapshot only on the frame that carried it', () => {
    const decoder = createLaneDecoder('omp');
    const jobs = {
      details: {
        op: 'wait',
        jobs: [{ id: 'j1', type: 'bash', status: 'completed', durationMs: 5, label: 'build' }],
      },
    };
    const carried = send(decoder, 'tool_call', { toolCallId: 'w', title: 'wait', rawOutput: jobs });
    expect(carried?.view.kind).toBe('wait');
    expect(carried?.view.sections).toEqual([]);
    expect(carried?.jobsReport?.map((job) => job.id)).toEqual(['j1']);
    const statusOnly = send(decoder, 'tool_call_update', { toolCallId: 'w', status: 'completed' });
    expect(statusOnly?.view.jobs).toBeDefined();
    expect(statusOnly?.jobsReport).toBeUndefined();
  });
});

describe('toolPayloadFromView', () => {
  it('seeds a braille spinner for in-flight statuses, never · or ⟳', () => {
    const view = decode('codex', { title: 'execute', rawInput: { command: 'ls' } });
    expect(toolPayloadFromView({ ...view, status: 'pending' }, {}, undefined).glyph).toBe('⠋');
    expect(toolPayloadFromView({ ...view, status: 'in_progress' }, {}, undefined).glyph).toBe('⠋');
    expect(toolPayloadFromView({ ...view, status: 'completed' }, {}, undefined).glyph).toBe('✓');
    expect(toolPayloadFromView({ ...view, status: 'failed' }, {}, undefined).glyph).toBe('✗');
  });

  it('labels a non-zero exit and keeps a shown result', () => {
    const view = decode('codex', { kind: 'execute', rawOutput: { exit_code: 2 } });
    const first = toolPayloadFromView(view, {}, undefined);
    expect(first.result).toBe('exit 2');
    expect(toolPayloadFromView({ ...view, exit: null }, {}, first).result).toBe('exit 2');
  });
});

describe('permission decoding (spec 380 phase 2b)', () => {
  it('decodes the request alone and leaves the call state untouched', () => {
    const decoder = createLaneDecoder('codex');
    const started = send(decoder, 'tool_call', { toolCallId: 'p1', title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } });
    const [request] = decoder.event({
      type: 'permission_request',
      requestId: 3,
      params: { toolCall: { toolCallId: 'p1', title: 'Allow rm?' }, options: [] },
    });
    expect(request).toMatchObject({ type: 'permission_request', view: { id: 'p1', title: 'Allow rm?', commandLine: null } });
    const next = send(decoder, 'tool_call_update', { toolCallId: 'p1', status: 'completed' });
    expect(next?.view.title).toBe('npm test');
    expect(next?.view.sections).toBe(started?.view.sections);
    const [unseen] = decoder.event({ type: 'permission_request', requestId: 4, params: { toolCall: { toolCallId: 'p2' }, options: [] } });
    expect(unseen?.type).toBe('permission_request');
    expect(send(decoder, 'tool_call_update', { toolCallId: 'p2', status: 'completed' })).toBeNull();
  });

  it('carries the policy facts the view decides from', () => {
    const harness = permissionEvent('codex', { toolCallId: 'h', title: 'mcp__krypton_harness_bus__peer_send' });
    expect(harness.harnessTool).toBe('peer_send');
    expect(harness.highRisk).toBe(false);
    const shell = permissionEvent('codex', {
      toolCallId: 's', kind: 'execute', title: 'rg peer_send ~/x/krypton-harness-memory',
      rawInput: { command: 'rg peer_send ~/x/krypton-harness-memory' },
    });
    expect(shell.harnessTool).toBeNull();
    const unreadable = permissionEvent('codex', { toolCallId: 'u', kind: 'execute', title: 'Run' });
    expect(unreadable.highRisk).toBe(true);
    const destructive = permissionEvent('codex', { toolCallId: 'd', kind: 'execute', rawInput: { command: 'rm -rf build' } });
    expect(destructive.highRisk).toBe(true);
    expect(destructive.view.declaredKind).toBe('execute');
  });

  it('keeps the declared kind separate from the inferred one', () => {
    const inferred = permissionEvent('codex', { toolCallId: 'e', title: 'Edit src/a.ts' });
    expect(inferred.view.kind).toBe('edit');
    expect(inferred.view.declaredKind).toBeNull();
  });
});

// Spec 380 phase 3 — the wire shapes claude-agent-acp and codex-acp send a
// client that declares `clientCapabilities._meta.terminal_output`.
describe('tool decoding — terminal convention', () => {
  const claudeCommand: Partial<ToolCall> = {
    kind: 'execute',
    title: 'printf hi',
    status: 'pending',
    rawInput: { command: 'printf hi', description: 'Print hi' },
    content: [{ type: 'terminal', terminalId: 'c1' }],
    _meta: { claudeCode: { toolName: 'Bash' }, terminal_info: { terminal_id: 'c1' } },
  };
  const claudeEnd = (exitCode: number | null, status: 'completed' | 'failed' = 'completed'): Partial<ToolCall> => ({
    status,
    content: [{ type: 'terminal', terminalId: 'c1' }],
    _meta: { claudeCode: { toolName: 'Bash' }, terminal_exit: { terminal_id: 'c1', exit_code: exitCode, signal: null } },
  });
  const output = (data: string): Partial<ToolCall> => ({
    _meta: { terminal_output: { terminal_id: 'c1', data } },
  });

  it('reports Claude terminal exit code', () => {
    const view = decode('claude', claudeCommand, output('hi\n'), claudeEnd(0));
    expect(view.exit).toBe(0);
    expect(toolPayloadFromView(view, {}, undefined).exitCode).toBe(0);
  });

  it('reports a failed command exit, not a guessed one', () => {
    const failed = decode('claude', claudeCommand, output('boom\n'), claudeEnd(1, 'failed'));
    expect(failed.exit).toBe(1);
    expect(toolPayloadFromView(failed, {}, undefined).result).toBe('exit 1');
    const unknown = decode('claude', claudeCommand, output('done\n'), claudeEnd(null));
    expect(unknown.status).toBe('completed');
    expect(unknown.exit).toBeNull();
  });

  it('drops the content copy once Codex terminal output arrives', () => {
    const decoder = createLaneDecoder('codex');
    const started = send(decoder, 'tool_call', {
      toolCallId: 'c1',
      kind: 'execute',
      title: 'printf a; false',
      status: 'in_progress',
      content: [
        { type: 'terminal', terminalId: 'c1' },
        { type: 'content', content: { type: 'text', text: 'Run printf a; false' } },
      ],
      _meta: { terminal_info: { cwd: '/repo', terminal_id: 'c1' } },
    });
    expect(started?.view.sections).toEqual([{ label: 'content', text: 'Run printf a; false' }]);
    send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('a\n') });
    const second = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('b\n') });
    expect(second?.view.sections.map((section) => section.label)).toEqual(['output']);
    const ended = send(decoder, 'tool_call_update', {
      toolCallId: 'c1',
      status: 'failed',
      _meta: { terminal_exit: { exit_code: 1, signal: null, terminal_id: 'c1' } },
    });
    expect(ended?.view.exit).toBe(1);
  });

  it('keeps the terminal exit over a rawOutput code, and rawOutput when no terminal exit came', () => {
    const terminal = decode('codex', { kind: 'execute', title: 'x', status: 'in_progress' }, {
      status: 'completed',
      rawOutput: { exit_code: 0 },
      _meta: { terminal_exit: { exit_code: 2, signal: null, terminal_id: 'c1' } },
    });
    expect(terminal.exit).toBe(2);
    const raw = decode('codex', { kind: 'read', title: 'cat a', status: 'in_progress' }, {
      status: 'completed',
      rawOutput: { exit_code: 0 },
      content: [{ type: 'content', content: { type: 'text', text: 'file text' } }],
    });
    expect(raw.exit).toBe(0);
    expect(raw.sections).toEqual([{ label: 'content', text: 'file text' }]);
  });

  it('keeps content text, such as a denial, when no terminal output arrived', () => {
    const view = decode('claude', claudeCommand, {
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'The user denied this command.' } }],
    });
    expect(view.sections).toEqual([{ label: 'content', text: 'The user denied this command.' }]);
    expect(view.exit).toBeNull();
  });

  it('keeps the output arrays when an update moves nothing the well shows', () => {
    const decoder = createLaneDecoder('claude');
    send(decoder, 'tool_call', { toolCallId: 'c1', ...claudeCommand });
    const shown = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('hi\n') });
    const status = send(decoder, 'tool_call_update', { toolCallId: 'c1', status: 'in_progress' });
    expect(status?.view.sections).toBe(shown?.view.sections);
    // A background task's late `terminal_exit` with no code changes nothing.
    const lateExit = send(decoder, 'tool_call_update', {
      toolCallId: 'c1',
      _meta: { terminal_exit: { terminal_id: 'c1', exit_code: null, signal: null } },
    });
    expect(lateExit?.view.sections).toBe(shown?.view.sections);
  });

  it('bounds the collected output and stops repainting past the bound', () => {
    const decoder = createLaneDecoder('codex');
    send(decoder, 'tool_call', { toolCallId: 'c1', kind: 'execute', title: 'yes', status: 'in_progress' });
    const full = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('y\n'.repeat(TERMINAL_OUTPUT_CHAR_LIMIT)) });
    const more = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('tail\n') });
    expect(more?.view.sections).toBe(full?.view.sections);
    expect(more?.view.sections[0]?.text.split('\n')).toHaveLength(12);
  });

  it('reads a Claude background launch from terminal output', () => {
    const view = decode('claude', {
      ...claudeCommand,
      title: 'npm run watch',
      rawInput: { command: 'npm run watch', run_in_background: true },
    }, output('Command running in background with ID: bx1. Output is being written to: /tmp/bx1.out'));
    expect(view.background).toEqual({ id: 'bx1', outputPath: '/tmp/bx1.out', command: 'npm run watch' });
  });

  it('scans terminal output for image paths', () => {
    const decoder = createLaneDecoder('claude');
    send(decoder, 'tool_call', { toolCallId: 'c1', ...claudeCommand });
    const shot = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('saved /tmp/shot.png\n') });
    expect(shot?.images.scanned).toEqual(['/tmp/shot.png']);
  });

  describe("Claude's `Exit code N` line", () => {
    const failedText = (text: string): Partial<ToolCall> => ({
      content: [{ type: 'content', content: { type: 'text', text } }],
    });

    it('is dropped from terminal output once terminal_exit reports the same code', () => {
      const view = decode('claude', claudeCommand, output('Exit code 3\nboom\n'), claudeEnd(3, 'failed'));
      expect(view.exit).toBe(3);
      expect(toolPayloadFromView(view, {}, undefined).result).toBe('exit 3');
    });

    it('leaves an empty well when the line was the whole output (`false`)', () => {
      const view = decode('claude', claudeCommand, output('Exit code 1'), claudeEnd(1, 'failed'));
      expect(view.sections).toEqual([]);
      expect(view.exit).toBe(1);
    });

    it('is dropped from content text the same way', () => {
      const view = decode('claude', claudeCommand, {
        ...claudeEnd(3, 'failed'),
        content: [{ type: 'content', content: { type: 'text', text: 'Exit code 3\nboom' } }],
      });
      expect(view.sections).toEqual([{ label: 'content', text: 'boom' }]);
    });

    it('stays while the exit is unknown, or when it names another code', () => {
      const decoder = createLaneDecoder('claude');
      send(decoder, 'tool_call', { toolCallId: 'c1', ...claudeCommand });
      const early = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('Exit code 3\nboom\n') });
      expect(early?.view.exit).toBeNull();
      expect(early?.view.sections[0].text).toContain('Exit code 3');
      const other = decode('claude', claudeCommand, output('Exit code 3\nboom\n'), claudeEnd(2, 'failed'));
      expect(other.sections[0].text).toContain('Exit code 3');
      const noExit = decode('claude', claudeCommand, { status: 'failed', ...failedText('Exit code 3\nboom') });
      expect(noExit.sections).toEqual([{ label: 'content', text: 'Exit code 3\nboom' }]);
    });

    it('is only a first line, and only on Claude lanes', () => {
      const later = decode('claude', claudeCommand, output('boom\nExit code 3\n'), claudeEnd(3, 'failed'));
      expect(later.sections[0].text).toContain('\nExit code 3');
      const codex = decode('codex', { kind: 'execute', title: 'x', status: 'in_progress' }, {
        status: 'failed',
        _meta: { terminal_output: { terminal_id: 'c1', data: 'Exit code 3\nboom' }, terminal_exit: { terminal_id: 'c1', exit_code: 3, signal: null } },
      });
      expect(codex.sections).toEqual([{ label: 'output', text: 'Exit code 3\nboom' }]);
    });

    it('keeps the output array when a later update moves nothing', () => {
      const decoder = createLaneDecoder('claude');
      send(decoder, 'tool_call', { toolCallId: 'c1', ...claudeCommand });
      send(decoder, 'tool_call_update', { toolCallId: 'c1', ...output('Exit code 3\nboom\n') });
      const ended = send(decoder, 'tool_call_update', { toolCallId: 'c1', ...claudeEnd(3, 'failed') });
      const again = send(decoder, 'tool_call_update', { toolCallId: 'c1', status: 'failed' });
      expect(again?.view.sections).toBe(ended?.view.sections);
    });
  });
});
