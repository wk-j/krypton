// Krypton — AI Agent Tools
// Krypton-specific tools exposed to the coding agent.
// Each tool wraps an existing Tauri IPC command.
// Tools are CWD-aware: relative paths resolve against the project directory.

import { invoke } from '../profiler/ipc';
import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { loadSkillContent, type SkillMeta } from './skills';

export interface WriteApprovalRequest {
  id: string;
  path: string;
  resolvedPath: string;
  oldContent: string;
  newContent: string;
  diff?: string;
}

export type WriteApprovalHandler = (request: WriteApprovalRequest) => Promise<boolean>;

export type BashRisk = 'write' | 'git' | 'network' | 'script' | 'unknown';

export interface BashApprovalRequest {
  id: string;
  command: string;
  cwd: string | null;
  risk: BashRisk;
  reason: string;
  highRisk: boolean;
}

export type BashApprovalHandler = (request: BashApprovalRequest) => Promise<boolean>;

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

function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (const ch of segment) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== '\'') {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === '\'') && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== '\'') {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === '\'') && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      current += ch;
      continue;
    }
    if (!quote && ((ch === '&' && next === '&') || (ch === '|' && next === '|') || ch === ';' || ch === '|')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i++;
      continue;
    }
    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

// Verbs that modify/overwrite existing state — excluded from whole-turn auto-approve.
// `mkdir` and `touch` are create-only and stay low-risk (blanket-able).
const destructiveWrite = new Set([
  'chmod', 'chown', 'cp', 'dd', 'install', 'ln', 'mv', 'perl',
  'rm', 'rmdir', 'rsync', 'tee', 'truncate',
]);
// git subcommands that discard work or rewrite history.
const dangerousGit = new Set(['reset', 'clean', 'checkout', 'restore', 'push', 'rebase']);

export function classifyBashCommand(command: string): { needsApproval: boolean; risk: BashRisk; reason: string; highRisk: boolean } {
  const trimmed = command.trim();
  if (!trimmed) return { needsApproval: false, risk: 'unknown', reason: 'Empty command.', highRisk: false };

  if (/(^|[^<])>{1,2}|&>|<</.test(trimmed)) {
    // Redirection can truncate/overwrite files — treat as high-risk.
    return { needsApproval: true, risk: 'write', reason: 'Uses shell redirection or heredoc.', highRisk: true };
  }

  const segments = splitShellSegments(trimmed);
  if (segments.length === 0) {
    return { needsApproval: true, risk: 'unknown', reason: 'Unable to parse command.', highRisk: true };
  }

  const readOnly = new Set([
    'awk', 'cat', 'date', 'du', 'echo', 'env', 'find', 'git', 'grep', 'head',
    'ls', 'nl', 'pwd', 'rg', 'sed', 'tail', 'tree', 'wc', 'which', 'whoami',
  ]);
  const alwaysWrite = new Set([
    'chmod', 'chown', 'cp', 'dd', 'install', 'ln', 'mkdir', 'mv', 'perl',
    'rm', 'rmdir', 'rsync', 'sed', 'tee', 'touch', 'truncate',
  ]);
  const scriptRunners = new Set(['bash', 'bun', 'deno', 'node', 'npx', 'python', 'python3', 'ruby', 'sh', 'tsx', 'zsh']);
  const networkInstallers = new Set(['brew', 'cargo', 'curl', 'go', 'npm', 'pnpm', 'pip', 'pip3', 'uv', 'wget', 'yarn']);
  const safeGit = new Set(['branch', 'diff', 'log', 'rev-parse', 'show', 'status']);
  const safeNpm = new Set(['test']);

  for (const segment of segments) {
    const tokens = tokenizeShellSegment(segment);
    if (tokens.length === 0) continue;
    const cmd = tokens[0];
    const args = tokens.slice(1);

    if (cmd === 'git') {
      const sub = args.find((arg) => !arg.startsWith('-')) ?? '';
      if (!safeGit.has(sub)) {
        return { needsApproval: true, risk: 'git', reason: `git ${sub || '(unknown)'} can change repository state.`, highRisk: dangerousGit.has(sub) };
      }
      continue;
    }

    if (cmd === 'npm') {
      const sub = args.find((arg) => !arg.startsWith('-')) ?? '';
      if (!safeNpm.has(sub)) {
        return { needsApproval: true, risk: 'network', reason: `npm ${sub || '(unknown)'} may modify dependencies or run scripts.`, highRisk: true };
      }
      continue;
    }

    if (cmd === 'sed' && args.some((arg) => arg === '-i' || arg.startsWith('-i'))) {
      return { needsApproval: true, risk: 'write', reason: 'sed -i edits files in place.', highRisk: true };
    }

    if (alwaysWrite.has(cmd) && cmd !== 'sed') {
      return { needsApproval: true, risk: 'write', reason: `${cmd} can modify files.`, highRisk: destructiveWrite.has(cmd) };
    }

    if (scriptRunners.has(cmd)) {
      return { needsApproval: true, risk: 'script', reason: `${cmd} can execute arbitrary code.`, highRisk: true };
    }

    if (networkInstallers.has(cmd)) {
      return { needsApproval: true, risk: 'network', reason: `${cmd} may access the network or modify dependencies.`, highRisk: true };
    }

    if (!readOnly.has(cmd)) {
      return { needsApproval: true, risk: 'unknown', reason: `${cmd} is not in the read-only allowlist.`, highRisk: true };
    }
  }

  return { needsApproval: false, risk: 'unknown', reason: 'Read-only allowlisted command.', highRisk: false };
}

export function createKryptonTools(
  projectDir: string | null,
  skills?: SkillMeta[],
  writeApproval?: WriteApprovalHandler,
  bashApproval?: BashApprovalHandler,
): AgentTool[] {
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

      if (writeApproval) {
        const accepted = await writeApproval({
          id: _id,
          path: params.path,
          resolvedPath: resolved,
          oldContent,
          newContent: params.content,
          diff: result.diff,
        });
        if (!accepted) {
          throw new Error(`User rejected write_file for ${params.path}`);
        }
      }

      await invoke('write_file', { path: resolved, content: params.content });

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
      const cwd = params.cwd ?? projectDir ?? null;
      const classification = classifyBashCommand(params.command);
      if (bashApproval && classification.needsApproval) {
        const accepted = await bashApproval({
          id: _id,
          command: params.command,
          cwd,
          risk: classification.risk,
          reason: classification.reason,
          highRisk: classification.highRisk,
        });
        if (!accepted) {
          throw new Error(`User rejected bash command: ${params.command}`);
        }
      }
      const [program, shellArgs] = await getShell();
      const output = await invoke<string>('run_command', {
        program,
        args: [...shellArgs, '-c', params.command],
        cwd,
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
