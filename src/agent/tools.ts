// Krypton — AI Agent Tools
// Krypton-specific tools exposed to the coding agent.
// Each tool wraps an existing Tauri IPC command.
// Tools are CWD-aware: relative paths resolve against the project directory.

import { invoke } from '@tauri-apps/api/core';
import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';

// ─── Parameter schemas ────────────────────────────────────────────

const ReadFileSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path' }),
});

const WriteFileSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path' }),
  content: Type.String({ description: 'Full file content to write' }),
});

const BashSchema = Type.Object({
  command: Type.String({ description: 'Shell command to run (passed to sh -c)' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory (defaults to project root)' })),
});

// ─── Result helper ────────────────────────────────────────────────

function text(t: string): AgentToolResult<string> {
  return { content: [{ type: 'text', text: t }], details: t };
}

// ─── Path resolution ──────────────────────────────────────────────

function resolvePath(path: string, projectDir: string | null): string {
  if (path.startsWith('/')) return path;
  if (!projectDir) return path;
  return `${projectDir}/${path}`;
}

// ─── Tool factories ─────────────────────────────────────────────

export function createKryptonTools(projectDir: string | null): AgentTool[] {
  const readFileTool: AgentTool<typeof ReadFileSchema, string> = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the full contents of a file. Returns the text content.',
    parameters: ReadFileSchema,
    async execute(_id: string, rawParams: unknown): Promise<AgentToolResult<string>> {
      const params = rawParams as Static<typeof ReadFileSchema>;
      const content = await invoke<string>('read_file', { path: resolvePath(params.path, projectDir) });
      return text(content);
    },
  };

  const writeFileTool: AgentTool<typeof WriteFileSchema, string> = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write or overwrite a file with the given content. Creates parent directories if needed.',
    parameters: WriteFileSchema,
    async execute(_id: string, rawParams: unknown): Promise<AgentToolResult<string>> {
      const params = rawParams as Static<typeof WriteFileSchema>;
      await invoke('write_file', { path: resolvePath(params.path, projectDir), content: params.content });
      return text(`Written: ${params.path}`);
    },
  };

  const bashTool: AgentTool<typeof BashSchema, string> = {
    name: 'bash',
    label: 'Bash',
    description: 'Run a shell command and return its stdout. Use for listing files, running tests, building, grep, etc.',
    parameters: BashSchema,
    async execute(_id: string, rawParams: unknown): Promise<AgentToolResult<string>> {
      const params = rawParams as Static<typeof BashSchema>;
      const output = await invoke<string>('run_command', {
        program: 'sh',
        args: ['-c', params.command],
        cwd: params.cwd ?? projectDir ?? null,
      });
      return text(output || '(no output)');
    },
  };

  return [
    readFileTool as unknown as AgentTool,
    writeFileTool as unknown as AgentTool,
    bashTool as unknown as AgentTool,
  ];
}
