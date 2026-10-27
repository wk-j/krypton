import { describe, expect, it } from 'vitest';

import { isExactMcpTool, type FencedTool } from './headless-fence';
import type { ToolCall } from './types';

const HOST_EXEC: FencedTool = { server: 'krypton_inline', tool: 'host_exec' };
const IDENTITY = 'mcp__krypton_inline__host_exec';

/** claude-agent-acp v0.95.0's MCP permission shape (renderer.js / acp-agent.js). */
function claudeCall(over: Partial<ToolCall> & { toolName?: string; server?: string } = {}): ToolCall {
  const { toolName = IDENTITY, server = 'krypton_inline', ...call } = over;
  return {
    toolCallId: 't',
    title: IDENTITY,
    kind: 'other',
    rawInput: { command: 'df -h' },
    _meta: { claudeCode: { toolName, mcpServer: { name: server, source: 'config' } } },
    ...call,
  };
}

describe('isExactMcpTool', () => {
  it('matches the exact title with agreeing claudeCode labels', () => {
    expect(isExactMcpTool(claudeCall(), HOST_EXEC)).toBe(true);
  });

  it('matches the exact title when the adapter sends no claudeCode metadata', () => {
    expect(isExactMcpTool({ toolCallId: 't', title: IDENTITY }, HOST_EXEC)).toBe(true);
  });

  it.each([
    ['another server with the same tool', { title: 'mcp__evil__host_exec', toolName: 'mcp__evil__host_exec', server: 'evil' }],
    ['a lookalike server name', { title: 'mcp__krypton_inline2__host_exec', toolName: 'mcp__krypton_inline2__host_exec', server: 'krypton_inline2' }],
    ['metadata naming another tool', { toolName: 'mcp__krypton_inline__other' }],
    ['metadata naming another server', { server: 'evil' }],
    ['a Bash request', { title: 'df -h', kind: 'execute' as const, toolName: 'Bash' }],
    ['the identity only in the arguments', { title: 'mcp__evil__run', toolName: 'mcp__evil__run', server: 'evil', rawInput: { title: IDENTITY } }],
  ])('declines %s', (_name, over) => {
    expect(isExactMcpTool(claudeCall(over), HOST_EXEC)).toBe(false);
  });

  it('declines claudeCode metadata that lacks the server', () => {
    expect(isExactMcpTool({ toolCallId: 't', title: IDENTITY, _meta: { claudeCode: { toolName: IDENTITY } } }, HOST_EXEC)).toBe(false);
  });
});
