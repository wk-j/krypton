import { describe, expect, it } from 'vitest';

import { harnessMemoryPermissionToolName } from './acp-harness-view';

import type { ToolCall } from './types';

function permissionFor(toolCall: Partial<ToolCall>): { toolCall: ToolCall } {
  return {
    toolCall: {
      toolCallId: 't1',
      ...toolCall,
    },
  };
}

describe('ACP harness memory permission detection', () => {
  it('accepts Codex-style namespaced built-in memory tool names', () => {
    expect(harnessMemoryPermissionToolName(permissionFor({
      title: 'mcp__krypton_harness_memory__memory_set',
      rawInput: {
        toolName: 'mcp__krypton_harness_memory__memory_set',
        arguments: { summary: 'done', detail: 'details' },
      },
    }))).toBe('memory_set');
  });

  it('accepts built-in memory endpoint markers with plain tool names', () => {
    expect(harnessMemoryPermissionToolName(permissionFor({
      title: 'memory_get',
      rawInput: {
        name: 'memory_get',
        serverUrl: 'http://127.0.0.1:34123/mcp/harness/H1/lane/Codex-1',
      },
    }))).toBe('memory_get');
  });

  it('accepts rendered ACP memory tool labels from permission content', () => {
    expect(harnessMemoryPermissionToolName(permissionFor({
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
    expect(harnessMemoryPermissionToolName(permissionFor({
      title: 'memory_set',
      rawInput: {
        name: 'memory_set',
        server: 'third-party-memory',
      },
    }))).toBeNull();
  });

  it('rejects non-memory tools even when the built-in marker is present', () => {
    expect(harnessMemoryPermissionToolName(permissionFor({
      title: 'mcp__krypton_harness_memory__shell_run',
      rawInput: {
        name: 'shell_run',
        server: 'krypton_harness_memory',
      },
    }))).toBeNull();
  });
});
