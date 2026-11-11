// Spec 381 — Tools: every tool kind and status, command output, and the
// cards a tool row grows into (subagents, jobs, code cells, Guardian review).

import type { ToolView } from '../../../../acp/adapters/types';
import type { ExecutionPayload, RemoteCommandPayload, SubagentEntry, SubagentPayload } from '../../../../acp/harness-view-types';
import { imageBlock, lines, section, tool, toolView } from './fixtures';
import type { GalleryEntry, GalleryInput, GalleryState } from './types';

function command(id: string, line: string, fields: Partial<ToolView> & Pick<ToolView, 'status'>): ToolView {
  return toolView(id, { kind: 'execute', title: line, subject: line, command: line, commandLine: line, ...fields });
}

/** A file tool: `kind` on `path`, its title as the agent states it. */
function fileTool(
  kind: string,
  id: string,
  title: string,
  path: string,
  fields: Partial<ToolView> & Pick<ToolView, 'status'>,
): ToolView {
  return toolView(id, { kind, title, subject: path, modifiedPath: kind === 'edit' ? path : null, locations: [path], ...fields });
}

/** Running, completed and failed for one kind: the three states most tool kinds share. */
function lifecycle(
  build: (id: string, fields: Partial<ToolView> & Pick<ToolView, 'status'>) => ToolView,
  completed: Partial<ToolView>,
  failure: string,
): GalleryState[] {
  return [
    { label: 'running', inputs: [tool(build('running', { status: 'in_progress' }), 900)] },
    { label: 'completed', inputs: [tool(build('completed', { status: 'completed', ...completed }))] },
    { label: 'failed', inputs: [tool(build('failed', { status: 'failed', sections: [section(failure, 'error')] }))] },
  ];
}

function agent(id: string, fields: Partial<SubagentEntry>): SubagentEntry {
  return {
    id,
    agent: 'Explore',
    status: 'running',
    activity: '',
    recentTools: [],
    toolCount: null,
    tokens: null,
    durationMs: null,
    task: '',
    output: '',
    hintLabel: null,
    ...fields,
  };
}

function agents(status: ToolView['status'], payload: SubagentPayload): GalleryInput {
  return tool(
    toolView(`agents-${status}`, {
      kind: 'agents',
      declaredKind: 'think',
      status,
      title: 'Task',
      subject: 'Map the wire readers',
      subagents: payload,
    }),
    18_000,
  );
}

const PY_OUTPUT = 'kind     count\nexecute     12\nread         9\nedit         4\n';

const CODE_CELL: ExecutionPayload = {
  source: 'omp',
  language: 'py',
  title: 'Count tool kinds',
  code: "from collections import Counter\nrows = load('transcript.jsonl')\nprint(table(Counter(r['kind'] for r in rows)))",
  output: PY_OUTPUT,
  observedLive: false,
  cellStatus: 'complete',
  durationMs: 840,
  exitCode: 0,
  isError: false,
  activity: [{ op: 'phase', text: 'Loading transcript', detail: '' }],
  views: [{
    kind: 'table',
    text: PY_OUTPUT.trimEnd(),
    columns: [{ head: 'kind' }, { head: 'count', numeric: true }],
    rows: [['execute', '12'], ['read', '9'], ['edit', '4']],
  }],
  detached: null,
  truncated: [],
};

const REMOTE_COMMAND: RemoteCommandPayload = {
  source: 'mcp',
  computerId: 'buildbox',
  command: 'git status --short',
  cwd: '/srv/krypton',
  result: { exitCode: 0, outcome: 'completed', stdout: ' M src/acp/adapters/tool.ts\n?? scratch.txt\n', stderr: '', truncated: false },
  error: null,
  outcomeUnknown: false,
  displayTruncated: [],
};

function remote(
  id: string,
  status: ToolView['status'],
  fields: Partial<RemoteCommandPayload> = {},
  elapsedMs: number | null = 1_200,
): GalleryInput {
  const payload = { ...REMOTE_COMMAND, ...fields };
  const cli = payload.source === 'cli';
  const directory = payload.cwd === null ? '' : ` --cwd '${payload.cwd.replace(/'/g, "'\\''")}'`;
  const line = `kryptonctl computer exec ${payload.computerId}${directory} -- '${payload.command.replace(/'/g, "'\\''")}'`;
  return tool(toolView(`remote-${id}`, {
    kind: cli ? 'execute' : 'other',
    status,
    title: cli ? line : 'mcp__krypton-harness-memory__computer_exec',
    subject: cli ? line : 'computer_exec',
    command: cli ? line : '',
    commandLine: cli ? line : null,
    mcp: cli ? null : { server: 'krypton-harness-memory', tool: 'computer_exec' },
    remoteCommand: payload,
  }), elapsedMs);
}

function guardian(id: string, status: ToolView['status'], review: NonNullable<ToolView['guardianReview']>): GalleryInput {
  return tool(
    toolView(`guardian_assessment:${id}`, { kind: 'think', status, title: 'Guardian Review', subject: 'Guardian Review', guardianReview: review }),
    2_000,
  );
}

const GIT_DIFF_STAT = [
  ' src/acp/adapters/claude.ts    |  3 +',
  ' src/acp/adapters/generic.ts   | 18 ++++++++++++',
  ' src/acp/adapters/tool.test.ts | 59 ++++++++++++++++++++++++++++++',
  ' 3 files changed, 80 insertions(+)',
].join('\n');

export const TOOL_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'tool-execute',
    title: 'Command',
    group: 'tools',
    summary: 'A shell command: its status, output well, and the git parsers.',
    components: ['tool-row', 'spinner'],
    scenario: null,
    states: [
      { label: 'pending', inputs: [tool(command('pending', 'npm test', { status: 'pending' }), null)] },
      { label: 'running', inputs: [tool(command('running', 'npm test', { status: 'in_progress' }), 3_400)] },
      { label: 'exit 0', inputs: [tool(command('exit0', 'printf hi', { status: 'completed', exit: 0, sections: [section('hi')] }))] },
      {
        label: 'exit 1',
        inputs: [tool(command('exit1', 'echo boom; exit 1', { status: 'failed', exit: 1, sections: [section('boom')] }))],
      },
      {
        label: 'no exit reported',
        inputs: [tool(command('noexit', 'ls src/acp/adapters', { status: 'completed', sections: [section('claude.ts\ncodex.ts\ngeneric.ts')] }))],
      },
      {
        label: 'long output trimmed',
        inputs: [tool(command('long', 'seq 1 400', { status: 'completed', exit: 0, sections: [section(lines(12, 'line'))] }))],
      },
      {
        label: 'git status',
        inputs: [tool(command('gitstatus', 'git status --short', {
          status: 'completed',
          exit: 0,
          sections: [section(' M src/acp/adapters/claude.ts\n M src/acp/adapters/tool.ts\nA  src/acp/image-paths.ts\n?? notes.md')],
        }))],
      },
      {
        label: 'git diff',
        inputs: [tool(command('gitdiff', 'git diff --stat', { status: 'completed', exit: 0, sections: [section(GIT_DIFF_STAT)] }))],
      },
      {
        label: 'background task',
        inputs: [tool(command('background', 'npm run watch', {
          status: 'completed',
          sections: [section('Command running in background with ID: bx1. Output is being written to: /tmp/bx1.output')],
          background: { id: 'bx1', outputPath: '/tmp/bx1.output', command: 'npm run watch' },
        }))],
      },
      { label: 'canceled', inputs: [tool(command('canceled', 'npm run e2e', { status: 'canceled' }), 5_200)] },
      {
        label: 'run of three',
        inputs: [
          tool(command('run1', 'git status --short', { status: 'completed', exit: 0, sections: [section(' M src/acp/adapters/tool.ts')] }), 300),
          tool(command('run2', 'npm run check', { status: 'completed', exit: 0, sections: [section('> tsc --noEmit')] }), 6_800),
          tool(command('run3', 'npm test', { status: 'failed', exit: 1, sections: [section('1 failed | 74 passed')] }), 9_100),
        ],
      },
    ],
  },
  {
    id: 'tool-remote-command',
    title: 'Remote command',
    group: 'tools',
    summary: 'Connected Computer MCP and direct CLI commands, with retained command, separate streams and working Details.',
    components: ['tool-row', 'remote-command-card', 'remote-command-dialog'],
    scenario: null,
    states: [
      { label: 'pending', inputs: [remote('pending', 'pending', { result: null }, null)] },
      { label: 'approval in progress', inputs: [remote('approval', 'in_progress', { result: null }, 3_400)] },
      { label: 'MCP exit 0', inputs: [remote('exit0', 'completed')] },
      {
        label: 'CLI nonzero with stderr',
        inputs: [remote('exit2', 'completed', {
          source: 'cli',
          command: 'git diff --check',
          result: { exitCode: 2, outcome: 'completed', stdout: 'Checking working tree\n', stderr: 'src/main.ts:8: trailing whitespace.\n+  return true;  \n', truncated: false },
        })],
      },
      {
        label: 'empty output',
        inputs: [remote('empty', 'completed', {
          source: 'cli',
          command: 'true',
          cwd: null,
          result: { exitCode: 0, outcome: 'completed', stdout: '', stderr: '', truncated: false },
        })],
      },
      {
        label: 'missing exit',
        inputs: [remote('missing-exit', 'completed', {
          result: { exitCode: null, outcome: 'completed', stdout: 'Command completed; no exit value supplied.\n', stderr: '', truncated: false },
        })],
      },
      {
        label: 'declined or expired',
        inputs: [remote('declined', 'failed', { result: null, error: 'Remote command declined or approval expired' })],
      },
      {
        label: 'unknown with partial output',
        inputs: [remote('unknown-output', 'failed', {
          source: 'cli',
          command: 'make release',
          outcomeUnknown: true,
          error: 'Remote command outcome unknown after timeout.',
          result: { exitCode: null, outcome: 'unknown', stdout: 'Compiling release\n  linking application\n', stderr: 'Connection interrupted\n', truncated: false },
        })],
      },
      {
        label: 'unknown without output',
        inputs: [remote('unknown-input', 'failed', {
          result: null,
          outcomeUnknown: true,
          error: 'Remote command outcome unknown while sending input.',
        })],
      },
      {
        label: 'transport failure',
        inputs: [remote('transport', 'failed', { result: null, error: 'Computer buildbox is not connected' })],
      },
      { label: 'cancellation', inputs: [remote('cancelled', 'canceled', { result: null }, 5_200)] },
      {
        label: 'backend truncation',
        inputs: [remote('backend-limit', 'completed', {
          result: { exitCode: 0, outcome: 'completed', stdout: lines(10, 'retained backend output'), stderr: '', truncated: true },
        })],
      },
      {
        label: 'UI truncation',
        inputs: [remote('display-limit', 'failed', {
          command: 'make release\n'.repeat(1_260).slice(0, 16_384),
          result: { exitCode: 1, outcome: 'completed', stdout: 'build output\n'.repeat(1_500).slice(0, 16_384), stderr: 'build failed\n'.repeat(1_500).slice(0, 16_384), truncated: false },
          error: 'Compiler diagnostics\n'.repeat(250).slice(0, 4_096),
          displayTruncated: ['command', 'stdout', 'stderr', 'error'],
        })],
      },
      {
        label: 'long computer and command',
        inputs: [remote('long-metadata', 'completed', {
          source: 'cli',
          computerId: `production-buildbox-${'region-'.repeat(30)}01`,
          cwd: `/srv/${'very-long-project-directory/'.repeat(12)}krypton`,
          command: `printf '%s\\n' '${'long requested command with significant spaces  '.repeat(12)}'`,
        })],
      },
      {
        label: 'undecodable result diagnostics',
        inputs: [tool(toolView('remote-diagnostics', {
          kind: 'other',
          status: 'completed',
          title: 'mcp__krypton-harness-memory__computer_exec',
          subject: 'computer_exec',
          mcp: { server: 'krypton-harness-memory', tool: 'computer_exec' },
          remoteCommand: { ...REMOTE_COMMAND, result: null },
          sections: [section('Result envelope incomplete: exitCode and outcome were not reported.\n  stdout: retained diagnostic only\n\nNo remote result was inferred.', 'output')],
        }))],
      },
    ],
  },
  {
    id: 'tool-read',
    title: 'Read',
    group: 'tools',
    summary: 'A file read and the head of what came back.',
    components: ['tool-row'],
    scenario: null,
    states: lifecycle(
      (id, fields) => fileTool('read', `read-${id}`, 'Read src/acp/adapters/claude.ts', 'src/acp/adapters/claude.ts', fields),
      { sections: [section("// Spec 380 — Claude (`@agentclientprotocol/claude-agent-acp`, backend id `claude`).\n\nimport type { ToolCall, ToolCallUpdate } from '../types';", 'content')] },
      'ENOENT: no such file or directory',
    ),
  },
  {
    id: 'tool-edit',
    title: 'Edit',
    group: 'tools',
    summary: 'A file edit as a unified diff, including a new file.',
    components: ['tool-row', 'diff-block'],
    scenario: null,
    states: [
      { label: 'running', inputs: [tool(fileTool('edit', 'edit-running', 'Edit src/acp/adapters/claude.ts', 'src/acp/adapters/claude.ts', { status: 'in_progress' }), 400)] },
      {
        label: 'diff',
        inputs: [tool(fileTool('edit', 'edit-diff', 'Edit src/acp/adapters/claude.ts', 'src/acp/adapters/claude.ts', {
          status: 'completed',
          diffs: [{
            path: 'src/acp/adapters/claude.ts',
            oldText: "  supplies: { ...UNVERIFIED_SUPPLIES, turnState: 'no' },\n",
            newText: "  supplies: { ...UNVERIFIED_SUPPLIES, turnState: 'no' },\n  exitLine: /^Exit code (-?\\d+)/,\n",
          }],
        }))],
      },
      {
        label: 'new file',
        inputs: [tool(fileTool('edit', 'edit-new', 'Write src/acp/text-truncate.ts', 'src/acp/text-truncate.ts', {
          status: 'completed',
          diffs: [{
            path: 'src/acp/text-truncate.ts',
            oldText: '',
            newText: 'export function truncate(s: string, max: number): string {\n  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;\n}\n',
          }],
        }))],
      },
      { label: 'failed', inputs: [tool(fileTool('edit', 'edit-failed', 'Edit src/acp/adapters/claude.ts', 'src/acp/adapters/claude.ts', { status: 'failed', sections: [section('old_string not found in file', 'error')] }))] },
    ],
  },
  {
    id: 'tool-delete',
    title: 'Delete',
    group: 'tools',
    summary: 'A file removed.',
    components: ['tool-row'],
    scenario: null,
    states: lifecycle(
      (id, fields) => fileTool('delete', `delete-${id}`, 'Delete src/acp/harness-guardian-review.ts', 'src/acp/harness-guardian-review.ts', fields),
      {},
      'permission denied',
    ),
  },
  {
    id: 'tool-move',
    title: 'Move',
    group: 'tools',
    summary: 'A file renamed or moved.',
    components: ['tool-row'],
    scenario: null,
    states: lifecycle(
      (id, fields) => toolView(`move-${id}`, {
        kind: 'move',
        title: 'Move src/acp/harness-guardian-review.ts to src/acp/adapters/codex-guardian.ts',
        subject: 'Move src/acp/harness-guardian-review.ts to src/acp/adapters/codex-guardian.ts',
        ...fields,
      }),
      {},
      'destination exists',
    ),
  },
  {
    id: 'tool-search',
    title: 'Search',
    group: 'tools',
    summary: 'A search, with grep hits laid out by file and line.',
    components: ['tool-row'],
    scenario: null,
    states: lifecycle(
      (id, fields) => toolView(`search-${id}`, { kind: 'search', title: 'rg -n dropExitLine src', subject: 'rg -n dropExitLine src', ...fields }),
      {
        sections: [section([
          'src/acp/adapters/generic.ts:273:export function dropExitLine(',
          'src/acp/adapters/tool.ts:16:  dropExitLine,',
          'src/acp/adapters/tool.ts:290:  const shown = adapter.exitLine ? dropExitLine(peeled.sections, exit, adapter.exitLine) : peeled.sections;',
        ].join('\n'))],
      },
      'rg: src: No such file or directory',
    ),
  },
  {
    id: 'tool-fetch',
    title: 'Fetch',
    group: 'tools',
    summary: 'A web fetch and the head of the page.',
    components: ['tool-row'],
    scenario: null,
    states: lifecycle(
      (id, fields) => toolView(`fetch-${id}`, {
        kind: 'fetch',
        title: 'Fetch https://agentclientprotocol.com/protocol/tool-calls',
        subject: 'Fetch https://agentclientprotocol.com/protocol/tool-calls',
        ...fields,
      }),
      { sections: [section('Tool calls represent actions that language models request agents to perform during a prompt turn.', 'content')] },
      'HTTP 404',
    ),
  },
  {
    id: 'tool-think',
    title: 'Think',
    group: 'tools',
    summary: 'An internal reasoning step the agent reports as a tool.',
    components: ['tool-row'],
    scenario: null,
    states: lifecycle(
      (id, fields) => toolView(`think-${id}`, { kind: 'think', title: 'Plan the follow-up', subject: 'Plan the follow-up', ...fields }),
      { sections: [section('1. Check where the line arrives\n2. Strip it only when the code matches', 'content')] },
      'interrupted',
    ),
  },
  {
    id: 'tool-other',
    title: 'Other',
    group: 'tools',
    summary: 'A tool with no ACP kind, such as an MCP call.',
    components: ['tool-row'],
    scenario: null,
    states: lifecycle(
      (id, fields) => toolView(`other-${id}`, {
        kind: 'other',
        title: 'mcp__krypton-harness-memory__peer_list',
        subject: 'mcp__krypton-harness-memory__peer_list',
        mcp: { server: 'krypton-harness-memory', tool: 'peer_list' },
        ...fields,
      }),
      { sections: [section('OMP-1 idle · Codex-1 idle')] },
      'MCP server not connected',
    ),
  },
  {
    id: 'tool-agents',
    title: 'Agents',
    group: 'tools',
    summary: 'A call that spawned subagents becomes their card.',
    components: ['tool-row', 'subagent-card'],
    scenario: null,
    states: [
      {
        label: 'running',
        inputs: [agents('in_progress', {
          source: 'claude',
          background: false,
          overflow: 0,
          agents: [agent('scout', {
            activity: 'Read src/acp/adapters/tool.ts',
            recentTools: ['Grep', 'Read'],
            toolCount: 4,
            tokens: 12_400,
            durationMs: 8_000,
            task: 'Find every module outside src/acp/adapters that reads rawInput or rawOutput.',
          })],
        })],
      },
      {
        label: 'mixed',
        inputs: [agents('in_progress', {
          source: 'omp',
          background: false,
          overflow: 0,
          agents: [
            agent('fixtures', { agent: 'task', status: 'completed', toolCount: 9, tokens: 30_100, durationMs: 41_000, output: 'Captured 8 scenarios.' }),
            agent('contract', { agent: 'task', status: 'running', activity: 'Writing adapters.contract.test.ts', toolCount: 5, durationMs: 22_000 }),
            agent('docs', { agent: 'task', status: 'failed', toolCount: 2, durationMs: 6_000, output: 'docs/0069 is locked by another lane.' }),
          ],
        })],
      },
      {
        label: 'done',
        inputs: [agents('completed', {
          source: 'codex',
          background: false,
          overflow: 0,
          agents: [
            agent('reviewer', { agent: '', status: 'completed', output: 'No blocking findings.' }),
            agent('tester', { agent: '', status: 'completed', output: 'All 3,623 tests pass.' }),
          ],
        })],
      },
    ],
  },
  {
    id: 'tool-wait',
    title: 'Wait',
    group: 'tools',
    summary: 'A wait on background jobs paints their list, not the model-facing text.',
    components: ['tool-row', 'job-list'],
    scenario: null,
    states: [
      {
        label: 'job list',
        inputs: [tool(toolView('wait', {
          kind: 'wait',
          declaredKind: 'other',
          status: 'completed',
          title: 'wait',
          subject: 'wait',
          jobs: {
            overflow: 0,
            interrupted: false,
            jobs: [
              { id: 'job-1', type: 'task', status: 'completed', label: 'scout', durationMs: 42_000, exitCode: null },
              { id: 'job-2', type: 'bash', status: 'running', label: 'npm test', durationMs: 12_000, exitCode: null },
              { id: 'job-3', type: 'bash', status: 'failed', label: 'cargo test', durationMs: 30_000, exitCode: 101 },
            ],
          },
        }), 60_000)],
      },
    ],
  },
  {
    id: 'tool-execution',
    title: 'Code cell',
    group: 'tools',
    summary: 'An OMP code cell: source, output and its table view.',
    components: ['tool-row', 'execution-card'],
    scenario: null,
    states: [
      {
        label: 'complete',
        inputs: [tool(toolView('cell-complete', { kind: 'execute', status: 'completed', title: 'Count tool kinds', subject: 'Count tool kinds', execution: CODE_CELL }), 840)],
      },
      {
        label: 'error',
        inputs: [tool(toolView('cell-error', {
          kind: 'execute',
          status: 'failed',
          title: 'Count tool kinds',
          subject: 'Count tool kinds',
          execution: {
            ...CODE_CELL,
            output: "Traceback (most recent call last):\n  File \"<cell>\", line 2\nNameError: name 'load' is not defined",
            cellStatus: 'error',
            exitCode: 1,
            isError: true,
            views: [],
          },
        }), 120)],
      },
    ],
  },
  {
    id: 'tool-guardian',
    title: 'Guardian review',
    group: 'tools',
    summary: "Codex's own review of a risky action, with its risk and rationale.",
    components: ['guardian-review-row'],
    scenario: null,
    states: [
      {
        label: 'reviewing',
        inputs: [guardian('reviewing', 'in_progress', {
          outcome: 'reviewing', action: 'rm -rf build', risk: null, authorization: null, rationale: null, rationaleTruncated: false,
        })],
      },
      {
        label: 'approved',
        inputs: [guardian('approved', 'completed', {
          outcome: 'approved',
          action: 'git push origin acp-lane-adapters',
          risk: 'low',
          authorization: 'high',
          rationale: 'The user asked for this push, and the branch is not protected.',
          rationaleTruncated: false,
        })],
      },
      {
        label: 'denied',
        inputs: [guardian('denied', 'completed', {
          outcome: 'denied',
          action: 'rm -rf ~/.config',
          risk: 'critical',
          authorization: 'low',
          rationale: 'Deletes user configuration outside the project, and nothing in the request asks for it.',
          rationaleTruncated: false,
        })],
      },
    ],
  },
  {
    id: 'tool-images',
    title: 'Tool images',
    group: 'tools',
    summary: 'Images a tool returned, shown on its row.',
    components: ['tool-row', 'image-strip'],
    scenario: null,
    states: [
      {
        label: 'image block',
        inputs: [{
          kind: 'tool',
          view: fileTool('read', 'image', 'Read /tmp/shot.png', '/tmp/shot.png', { status: 'completed' }),
          elapsedMs: 300,
          images: { blocks: [imageBlock], locations: [], pairPath: null, scanned: [], overflow: 0 },
        }],
      },
    ],
  },
];
