import { describe, expect, it } from 'vitest';

import { createLaneDecoder } from './decoder';
import type { RawAcpEvent } from './types';

function update(kind: string, fields: Record<string, unknown>): RawAcpEvent {
  return { type: 'session_update', kind, update: { sessionUpdate: kind, ...fields } };
}

const CLAUDE_CHILD_META = { claudeCode: { parentToolUseId: 'toolu_task' } };
const CODEX_IDLE_META = { codex: { threadStatus: { type: 'idle' } } };

describe('LaneDecoder.event — session updates', () => {
  const generic = createLaneDecoder('grok');

  it('decodes message, thought and user chunks', () => {
    expect(generic.event(update('agent_message_chunk', {
      content: { type: 'text', text: 'hi' },
      messageId: 'm-1',
    }))).toEqual([{ type: 'message_chunk', text: 'hi', content: { type: 'text', text: 'hi' }, messageId: 'm-1' }]);
    expect(generic.event(update('agent_thought_chunk', { content: { type: 'text', text: 'hmm' } })))
      .toEqual([{ type: 'thought_chunk', text: 'hmm' }]);
    expect(generic.event(update('user_message_chunk', { content: { type: 'text', text: 'ask' } })))
      .toEqual([{ type: 'user_message_chunk', text: 'ask', content: { type: 'text', text: 'ask' } }]);
  });

  it('keeps non-text blocks typed and degrades malformed ones to empty text', () => {
    const [image] = generic.event(update('agent_message_chunk', {
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    }));
    expect(image).toMatchObject({ type: 'message_chunk', text: '', content: { type: 'image', data: 'AAAA' } });
    const [broken] = generic.event(update('agent_message_chunk', { content: { type: 'image' } }));
    expect(broken).toMatchObject({ content: { type: 'text', text: '' } });
  });

  it('decodes plan, usage, commands and mode updates', () => {
    const entries = [{ content: 'step', status: 'pending' }];
    expect(generic.event(update('plan', { entries }))).toEqual([{ type: 'plan', entries }]);
    expect(generic.event(update('usage_update', { used: 10, size: 100, cost: { amount: 0.5 } })))
      .toEqual([{ type: 'usage', usage: { used: 10, size: 100, cost: { amount: 0.5, currency: 'USD' } } }]);
    expect(generic.event(update('available_commands_update', {
      availableCommands: [{ name: 'review', description: 'Review', input: { hint: 'path' } }, { name: '' }, 'junk'],
    }))).toEqual([{ type: 'available_commands', commands: [{ name: 'review', description: 'Review', inputHint: 'path' }] }]);
    expect(generic.event(update('current_mode_update', { currentModeId: 'plan' })))
      .toEqual([{ type: 'mode_update', modeId: 'plan' }]);
  });

  it('decodes tool calls into canonical tool events, keeping the call/update phase', () => {
    const decoder = createLaneDecoder('grok');
    const [call] = decoder.event(update('tool_call', { toolCallId: 't-1', title: 'ls', kind: 'execute', status: 'pending' }));
    expect(call).toMatchObject({ type: 'tool', phase: 'call', view: { id: 't-1', kind: 'execute', status: 'pending' } });
    const [done] = decoder.event(update('tool_call_update', { toolCallId: 't-1', status: 'completed' }));
    expect(done).toMatchObject({ type: 'tool', phase: 'update', view: { id: 't-1', status: 'completed', title: 'ls' } });
    expect(call).not.toHaveProperty('call');
  });

  it('drops unknown update kinds', () => {
    expect(generic.event(update('config_option_update', {}))).toEqual([]);
  });
});

describe('LaneDecoder.event — backend adapters', () => {
  it('reads the Claude subagent parent only on a Claude lane', () => {
    const chunk = update('agent_message_chunk', { content: { type: 'text', text: 'x' }, _meta: CLAUDE_CHILD_META });
    expect(createLaneDecoder('claude').event(chunk)).toEqual([
      { type: 'message_chunk', text: 'x', content: { type: 'text', text: 'x' }, parentToolId: 'toolu_task' },
    ]);
    expect(createLaneDecoder('codex').event(chunk)[0]).not.toHaveProperty('parentToolId');
    const thought = update('agent_thought_chunk', { content: { type: 'text', text: 't' }, _meta: CLAUDE_CHILD_META });
    expect(createLaneDecoder('claude').event(thought)).toEqual([
      { type: 'thought_chunk', text: 't', parentToolId: 'toolu_task' },
    ]);
  });

  it('reads Codex thread state only on a Codex lane', () => {
    const info = update('session_info_update', { _meta: CODEX_IDLE_META });
    expect(createLaneDecoder('codex').event(info)).toEqual([{ type: 'turn_state', state: 'idle' }]);
    expect(createLaneDecoder('claude').event(info)).toEqual([]);
    expect(createLaneDecoder('codex').event(update('session_info_update', { title: 'x' }))).toEqual([]);
  });
});

describe('LaneDecoder.event — Krypton-emitted events', () => {
  const decoder = createLaneDecoder('grok');

  it('parses ask_user_question from every shape Rust may forward', () => {
    const questions = [{ question: 'Pick', options: [{ label: 'A' }], multi_select: true }];
    const expected = [{ question: 'Pick', options: [{ label: 'A', description: '', preview: undefined }], multiSelect: true }];
    expect(decoder.event({ type: 'ask_user_question', requestId: 4, questions, toolCallId: 'call-1' }))
      .toEqual([{ type: 'ask_user_question', requestId: 4, questions: expected, toolCallId: 'call-1' }]);
    expect(decoder.event({ type: 'ask_user_question', requestId: 4, questions: { questions } }))
      .toMatchObject([{ questions: expected }]);
    expect(decoder.event({ type: 'ask_user_question', requestId: 4, questions: { params: { questions } } }))
      .toMatchObject([{ questions: expected }]);
    expect(decoder.event({ type: 'ask_user_question', requestId: 5, questions: null }))
      .toEqual([{ type: 'ask_user_question', requestId: 5, questions: [], toolCallId: undefined }]);
  });

  it('decodes permission, elicitation, fs, provider error, stop and error events', () => {
    const toolCall = { toolCallId: 't-2', title: 'rm -rf build', kind: 'execute' as const, rawInput: { command: 'rm -rf build' } };
    expect(decoder.event({ type: 'permission_request', requestId: 1, params: { toolCall, options: [] } }))
      .toMatchObject([{
        type: 'permission_request',
        requestId: 1,
        view: { id: 't-2', kind: 'execute', declaredKind: 'execute', commandLine: 'rm -rf build' },
        options: [],
        harnessTool: null,
        highRisk: true,
      }]);
    expect(decoder.event({ type: 'elicitation_request', requestId: 2, message: 'Name?', requestedSchema: { type: 'object' } }))
      .toEqual([{ type: 'elicitation_request', requestId: 2, message: 'Name?', requestedSchema: { type: 'object' }, toolCallId: undefined }]);
    expect(decoder.event({ type: 'fs_activity', method: 'write', path: '/a', ok: true }))
      .toEqual([{ type: 'fs_activity', method: 'write', path: '/a', ok: true, error: undefined }]);
    expect(decoder.event({ type: 'fs_write_pending', requestId: 3, path: '/a', oldText: 'x', newText: 'y' }))
      .toEqual([{ type: 'fs_write_pending', requestId: 3, path: '/a', oldText: 'x', newText: 'y' }]);
    const payload = { category: 'auth' as const, headline: 'Sign in', retryable: false, raw: '401' };
    expect(decoder.event({ type: 'provider_error', payload })).toEqual([{ type: 'provider_error', payload }]);
    expect(decoder.event({ type: 'stop', reason: 'subprocess exited' }))
      .toEqual([{ type: 'stop', stopReason: 'end_turn', reason: 'subprocess exited' }]);
    expect(decoder.event({ type: 'error' })).toEqual([{ type: 'error', message: 'unknown error' }]);
  });

  it('decodes turn markers and rejects malformed ones', () => {
    expect(decoder.event({ type: 'turn_marker', kind: 'steer', requestId: 9, outcome: 'injected' }))
      .toEqual([{ type: 'turn_marker', kind: 'steer', requestId: 9, outcome: 'injected' }]);
    expect(decoder.event({ type: 'turn_marker', kind: 'prompt', requestId: 9, outcome: 'injected' }))
      .toEqual([{ type: 'turn_marker', kind: 'prompt', requestId: 9, outcome: null }]);
    expect(decoder.event({ type: 'turn_marker', kind: 'steer', requestId: 9, outcome: 'odd' }))
      .toMatchObject([{ outcome: 'failed' }]);
    expect(decoder.event({ type: 'turn_marker', kind: 'other' })).toEqual([]);
  });
});

describe('LaneDecoder — command results', () => {
  const decoder = createLaneDecoder('claude');

  it('decodes initialize into capability flags, a reported model and fallback modes', () => {
    expect(decoder.init({
      agent_protocol_version: 1,
      auth_methods: [{ id: 'oauth' }],
      agent_capabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {} },
        loadSession: true,
        mcpCapabilities: { http: true },
        _meta: { defaults: { model: ' sonnet ' } },
        availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan' }, { name: 'no id' }],
      },
      steering_supported: true,
    })).toEqual({
      promptImage: true,
      promptEmbeddedContext: true,
      sessions: { canList: true, canResume: true, canLoad: true },
      mcp: { http: true, sse: false },
      steering: true,
      authMethods: [{ id: 'oauth' }],
      reportedModel: 'sonnet',
      modes: [
        { id: 'default', name: 'Default', description: undefined },
        { id: 'plan', name: 'plan', description: undefined },
      ],
    });
  });

  it('decodes an empty initialize to all-off capabilities', () => {
    expect(decoder.init({})).toEqual({
      promptImage: false,
      promptEmbeddedContext: false,
      sessions: { canList: false, canResume: false, canLoad: false },
      mcp: { http: false, sse: false },
      steering: false,
      authMethods: [],
      reportedModel: null,
      modes: [],
    });
  });

  it('decodes a session with models and ACP modes', () => {
    expect(decoder.session({
      session_id: 'ses-1',
      model_apply_failed: true,
      available_models: [{ model_id: 'opus', name: 'Opus', description: null }],
      current_model_id: 'opus',
      modes: {
        currentModeId: 'acceptEdits',
        availableModes: [{ id: 'default', name: 'Default', description: 'Ask first' }, { id: 'acceptEdits', name: 'Accept edits' }],
      },
    })).toEqual({
      sessionId: 'ses-1',
      models: [{ model_id: 'opus', name: 'Opus', description: null }],
      currentModelId: 'opus',
      modes: [
        { id: 'default', name: 'Default', description: 'Ask first' },
        { id: 'acceptEdits', name: 'Accept edits', description: undefined },
      ],
      currentModeId: 'acceptEdits',
      modelApplyFailed: true,
    });
  });

  it('decodes a session without model or mode state', () => {
    expect(decoder.session({ session_id: 'ses-2', available_models: [], current_model_id: null, modes: null }))
      .toEqual({ sessionId: 'ses-2', models: [], currentModelId: null, modes: [], currentModeId: null, modelApplyFailed: false });
  });

  it('decodes a session list without vendor metadata', () => {
    expect(decoder.sessionList({
      sessions: [
        { sessionId: 's-1', cwd: '/p', title: 'Fix', updatedAt: '2026-11-10', _meta: { vendor: true } },
        { cwd: '/p' },
      ],
      nextCursor: 'c-2',
    })).toEqual({
      sessions: [{ sessionId: 's-1', cwd: '/p', title: 'Fix', updatedAt: '2026-11-10' }],
      nextCursor: 'c-2',
    });
    expect(decoder.sessionList({ sessions: [] })).toEqual({ sessions: [], nextCursor: null });
  });

  it('reads prompt usage at the top level or under _meta, and drops empty usage', () => {
    expect(decoder.promptResult({ stopReason: 'cancelled', usage: { inputTokens: 5 } }))
      .toEqual({ stopReason: 'cancelled', usage: { inputTokens: 5 } });
    expect(decoder.promptResult({ stopReason: 'end_turn', _meta: { usage: { outputTokens: 7 } } }))
      .toEqual({ stopReason: 'end_turn', usage: { outputTokens: 7 } });
    expect(decoder.promptResult({ usage: {} })).toEqual({ stopReason: 'end_turn', usage: null });
  });
});
