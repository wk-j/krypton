// Krypton — AI Agent Tools
// Krypton-specific tools exposed to the coding agent.
// Each tool wraps an existing Tauri IPC command.
// Tools are CWD-aware: relative paths resolve against the project directory.

import { invoke } from '../profiler/ipc';
import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { loadSkillContent, type SkillMeta } from './skills';

// ─── Parameter schemas ────────────────────────────────────────────

const ReadFileSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path' }),
});

const WriteFileSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path' }),
  content: Type.String({ description: 'Full file content to write' }),
});

const BashSchema = Type.Object({
  command: Type.String({ description: 'Shell command to run (passed to the user\'s default login shell)' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory (defaults to project root)' })),
});

const ActivateSkillSchema = Type.Object({
  name: Type.String({ description: 'Name of the skill to activate' }),
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

/** Cached shell config (resolved once per session). */
let cachedShell: [string, string[]] | null = null;

async function getShell(): Promise<[string, string[]]> {
  if (cachedShell) return cachedShell;
  try {
    cachedShell = await invoke<[string, string[]]>('get_default_shell');
  } catch {
    cachedShell = ['/bin/sh', []];
  }
  return cachedShell;
}

export function createKryptonTools(projectDir: string | null, skills?: SkillMeta[]): AgentTool[] {
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
      const resolved = resolvePath(params.path, projectDir);

      // Read old content for diff (skip for very large files)
      let oldContent = '';
      let hasDiff = false;
      try {
        oldContent = await invoke<string>('read_file', { path: resolved });
        hasDiff = (oldContent.length + params.content.length) <= 50 * 1024;
      } catch {
        // New file — old content stays empty
        hasDiff = params.content.length <= 50 * 1024;
      }

      await invoke('write_file', { path: resolved, content: params.content });

      const result: AgentToolResult<string> & { diff?: string; filePath?: string } = {
        content: [{ type: 'text', text: `Written: ${params.path}` }],
        details: `Written: ${params.path}`,
      };

      if (hasDiff) {
        try {
          const { createTwoFilesPatch } = await import('diff');
          result.diff = createTwoFilesPatch(params.path, params.path, oldContent, params.content);
          result.filePath = params.path;
        } catch {
          // diff computation failed — proceed without it
        }
      }

      return result;
    },
  };

  const bashTool: AgentTool<typeof BashSchema, string> = {
    name: 'bash',
    label: 'Bash',
    description: 'Run a shell command and return its stdout. Use for listing files, running tests, building, grep, etc.',
    parameters: BashSchema,
    async execute(_id: string, rawParams: unknown): Promise<AgentToolResult<string>> {
      const params = rawParams as Static<typeof BashSchema>;
      const [program, shellArgs] = await getShell();
      const output = await invoke<string>('run_command', {
        program,
        args: [...shellArgs, '-c', params.command],
        cwd: params.cwd ?? projectDir ?? null,
      });
      return text(output || '(no output)');
    },
  };

  const tools: AgentTool[] = [
    readFileTool as unknown as AgentTool,
    writeFileTool as unknown as AgentTool,
    bashTool as unknown as AgentTool,
  ];

  // Only register activate_skill tool if there are skills available
  if (skills && skills.length > 0) {
    const activateSkillTool: AgentTool<typeof ActivateSkillSchema, string> = {
      name: 'activate_skill',
      label: 'Activate Skill',
      description: 'Load a skill\'s full instructions to follow its workflow. Call this before starting work when a skill matches the user\'s request.',
      parameters: ActivateSkillSchema,
      async execute(_id: string, rawParams: unknown): Promise<AgentToolResult<string>> {
        const params = rawParams as Static<typeof ActivateSkillSchema>;
        const skill = skills.find((s) => s.name === params.name);
        if (!skill) {
          const available = skills.map((s) => s.name).join(', ');
          return text(`Skill "${params.name}" not found. Available: ${available}`);
        }
        const content = await loadSkillContent(skill);
        if (!content) {
          return text(`Skill "${params.name}" has no content.`);
        }
        return text(`# Skill: ${skill.name}\n\nFollow these instructions for this request:\n\n${content}`);
      },
    };
    tools.push(activateSkillTool as unknown as AgentTool);
  }

  return tools;
}
