import { describe, expect, it } from 'vitest';

import { harnessAutoAllowToolName } from './acp-harness-view';

import type { ToolCall } from './types';

function permissionFor(toolCall: Partial<ToolCall>): { toolCall: ToolCall } {
  return {
    toolCall: {
      toolCallId: 't1',
      ...toolCall,
    },
  };
}

describe('ACP harness auto-allow permission detection', () => {
  it('accepts Codex-style namespaced built-in memory tool names', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'mcp__krypton_harness_memory__memory_set',
      rawInput: {
        toolName: 'mcp__krypton_harness_memory__memory_set',
        arguments: { summary: 'done', detail: 'details' },
      },
    }))).toBe('memory_set');
  });

  it('accepts built-in memory endpoint markers with plain tool names', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'memory_get',
      rawInput: {
        name: 'memory_get',
        serverUrl: 'http://127.0.0.1:34123/mcp/harness/H1/lane/Codex-1',
      },
    }))).toBe('memory_get');
  });

  it('accepts rendered ACP memory tool labels from permission content', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'MEMORY_SET',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: 'Tool: krypton-harness-memory/memory_set',
        },
      }],
      rawInput: {
        summary: 'done',
        detail: 'details',
      },
    }))).toBe('memory_set');
  });

  it('rejects memory-like tool names without a built-in memory marker', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'memory_set',
      rawInput: {
        name: 'memory_set',
        server: 'third-party-memory',
      },
    }))).toBeNull();
  });

  it('rejects non-memory tools even when the built-in marker is present', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'mcp__krypton_harness_memory__shell_run',
      rawInput: {
        name: 'shell_run',
        server: 'krypton_harness_memory',
      },
    }))).toBeNull();
  });

  it('accepts Codex-style underscored bus namespace for peer_send', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'mcp__krypton_harness_bus__peer_send',
      rawInput: {
        toolName: 'mcp__krypton_harness_bus__peer_send',
        arguments: { to_lane: 'Claude-1', message: 'hi', done: false },
      },
    }))).toBe('peer_send');
  });

  it('accepts peer_list under the hyphenated bus marker', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'peer_list',
      rawInput: {
        name: 'peer_list',
        server: 'krypton-harness-bus',
      },
    }))).toBe('peer_list');
  });

  it('accepts peer_send detected via fallback regex on content text', () => {
    expect(harnessAutoAllowToolName(permissionFor({
      title: 'PEER_SEND',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: 'Tool: krypton-harness-bus/peer_send',
        },
      }],
      rawInput: {
        to_lane: 'Codex-1',
        message: 'hi',
      },
    }))).toBe('peer_send');
  });
});
