// Krypton — built-in `#` command palette for the ACP harness composer.
//
// Unlike the slash palette (agent-provided `/` commands) and the mention palette
// (`@lane` peers), `#` commands are handled entirely by the harness itself in
// `AcpHarnessView.runHashCommand`. This module is the single source of truth for
// what those commands are, so the composer can offer discoverable autocomplete
// without the user having to memorise them. Keep this list in sync with the
// dispatch in `runHashCommand`.
//
// spec 185: `buildCommandManifest()` extends the same roster with category,
// badges, workflow anatomy, and the REAL injected system-prompt templates
// (rendered by the very builders the dispatch calls, with placeholder args),
// for the `/commands` loopback reference page.

import {
  HANDOFF_WRITE_PROMPT,
  analyzeGithubIssuePrompt,
  createGithubIssuePrompt,
  directivePrompt,
  fixGithubIssuePrompt,
  goalSeedPrompt,
  handleGithubIssuePrompt,
  handoffResumePrompt,
  issueFixPrompt,
  postGithubCommentPrompt,
  renderActiveTicketPin,
  tagGithubIssuePrompt,
  tldrawDrawPrompt,
  wikiIngestPrompt,
  wikiRecallPrompt,
} from './harness-prompts';
import { pollyRequestPrompt } from './polly';
import { debbyRequestPrompt } from './debby';
import { saltyRequestPrompt } from './salty';
import { reviewRequestPrompt } from './review';
import { resolveVerbTokens } from './verb-compose';
import { injectableVerbPrompt } from './verb-registry';

export interface HashCommand {
  /** Command token WITHOUT the leading `#` (e.g. `review`, `new!`). */
  name: string;
  /** One-line hint for argument grammar, shown dim after the name. Empty = no args. */
  args: string;
  /** Plain-language description of what the command does. */
  description: string;
}

/** Built-in `#` commands, in the order they should appear in the palette. */
export const HASH_COMMANDS: readonly HashCommand[] = [
  { name: 'new', args: '', description: 'start a fresh session (keep memory)' },
  { name: 'new!', args: '', description: 'start a fresh session, clear memory' },
  { name: 'goal', args: '[set <text> | clear]', description: 'set/clear the lane focus goal' },
  { name: 'cancel', args: '', description: 'stop the current turn or peer conversation' },
  { name: 'restart', args: '', description: 'restart the lane backend process' },
  { name: 'mem', args: '[clear]', description: 'memory commands (clear lane memory)' },
  { name: 'mcp', args: '', description: 'print harness MCP server status' },
  { name: 'dashboard', args: '', description: 'open the live harness dashboard in a browser' },
  { name: 'gallery', args: '', description: 'open the artifact gallery (pending + live artifacts) in a browser' },
  { name: 'docs', args: '', description: 'open the repo docs browser in a browser' },
  { name: 'analyses', args: '', description: 'open the GitHub issue analysis viewer in a browser' },
  { name: 'commands', args: '', description: 'open the built-in # command reference in a browser' },
  { name: 'tools', args: '', description: 'open the built-in MCP tool reference in a browser' },
  { name: 'handoff', args: '', description: 'write a resume-ready handoff doc to memory' },
  { name: 'resume', args: '', description: 'resume from the last handoff doc' },
  { name: 'wiki', args: '[<hint>]', description: 'ingest this conversation into the repo wiki' },
  { name: 'recall', args: '<question>', description: 'answer a question from the repo wiki' },
  { name: 'directive', args: '<what to create/change>', description: 'author a reusable harness directive' },
  { name: 'draw', args: '<request>', description: 'draw in the focused tldraw Offline canvas' },
  { name: 'review', args: '[<lane>…] [-- <doc | note>]', description: 'run a multi-reviewer design/diff review' },
  { name: 'orchestrator', args: '', description: 'designate this lane the orchestrator seat + open the console' },
  { name: 'polly', args: '<task>', description: 'Polly orchestration — spawns Cursor + Claude + Codex workers' },
  { name: 'debby', args: '<question>', description: 'Debby brainstorming — asks Claude + Codex heads' },
  {
    name: 'salty',
    args: '[+fellow] <task> | clear',
    description: 'Salty model-tiered orchestration — Sonnet/Opus/Codex executors with a plan-pushback gate',
  },
  {
    name: 'ticket',
    args: '[<issue url | owner/repo#123> | refresh | clear]',
    description: 'set the shared working ticket for all lanes (picker when no args)',
  },
  {
    name: 'dispatch-github-issue',
    args: '<issue url | owner/repo#123>',
    description: 'fetch a GitHub issue and dispatch it to a fresh lane',
  },
  {
    name: 'create-github-issue',
    args: '<what to file> [-R owner/repo]',
    description: 'draft and create a new GitHub issue from a plain-language request',
  },
  {
    name: 'analyze-github-issue',
    args: '<issue url | owner/repo#123>',
    description: 'analyze an issue for a fix solution + download its resources into a .krypton bundle, then tag it "status: Analyzed"',
  },
  {
    name: 'fix-github-issue',
    args: '<issue url | owner/repo#123>',
    description: 'fix a GitHub issue in the current lane',
  },
  {
    name: 'tag-github-issue',
    args: '<issue url | owner/repo#123> [labels…]',
    description: 'apply labels to a GitHub issue',
  },
  {
    name: 'post-github-comment',
    args: '<issue url | owner/repo#123>',
    description: 'post a comment to a GitHub issue',
  },
  {
    name: 'handle-github-issue',
    args: '<issue url | owner/repo#123>',
    description: 'analyze → fix → comment on a GitHub issue (composed)',
  },
  { name: 'queue', args: '[clear | edit N]', description: 'manage queued prompts' },
  { name: 'unqueue', args: '[N]', description: 'remove the last (or Nth) queued prompt' },
];

/** Composer draft is a bare `#token` at the very start, no space yet typed. */
const HASH_PALETTE_REGEX = /^#[A-Za-z0-9!_-]*$/;

export function hashPaletteVisible(draft: string, dismissed: boolean): boolean {
  if (dismissed) return false;
  return HASH_PALETTE_REGEX.test(draft);
}

export function filteredHashCommands(draft: string): HashCommand[] {
  if (!HASH_PALETTE_REGEX.test(draft)) return [];
  const prefix = draft.slice(1).toLowerCase();
  return HASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(prefix));
}

// ─── spec 185: command manifest for the /commands reference page ────────────

export type CommandCategory = 'session' | 'surface' | 'agent';
export type CommandBadge = 'workflow' | 'agent' | 'hidden';

export interface CommandManifestEntry {
  name: string;
  args: string;
  description: string;
  category: CommandCategory;
  badges: CommandBadge[];
  /** Alternate token dispatched to the same branch (e.g. `console`). */
  alias?: string;
  /** Workflow anatomy: `step → step → step` (workflow commands only). */
  anatomy?: string;
  /** Lane cost chip: `3 lanes` | `+1 lane` | `same lane`. */
  lanes?: string;
  /** The REAL injected system-prompt template, args as `<placeholder>` tokens. */
  prompt?: string;
}

type CommandMeta = Omit<CommandManifestEntry, 'name' | 'args' | 'description'>;

/** Placeholder roster shared by the polly/debby templates. */
const PLACEHOLDER_ORCHESTRATOR = { displayName: '<lane>', laneId: '<lane-id>', backendId: '<backend>' };

/** spec 194: placeholder ticket for the manifest's `#ticket` pin template. */
const PLACEHOLDER_TICKET = {
  issueKey: '<owner/repo#123>',
  repo: '<owner/repo>',
  number: '<number>',
  title: '<title>',
  revision: 1,
};

/** Exported ONLY for the drift-guard test, which asserts this map's key set
 *  equals the manifest name set — so a new roster entry cannot silently fall
 *  through to the `session`/no-badge fallback in `buildCommandManifest`. */
export function commandMeta(): Record<string, CommandMeta> {
  return {
    new: { category: 'session', badges: [] },
    'new!': { category: 'session', badges: [] },
    goal: { category: 'session', badges: [], prompt: goalSeedPrompt('<text>') },
    ticket: { category: 'session', badges: [], prompt: renderActiveTicketPin(PLACEHOLDER_TICKET) },
    cancel: { category: 'session', badges: [] },
    restart: { category: 'session', badges: [] },
    mem: { category: 'session', badges: [] },
    mcp: { category: 'session', badges: [] },
    queue: { category: 'session', badges: [] },
    unqueue: { category: 'session', badges: [] },
    dashboard: { category: 'surface', badges: [] },
    gallery: { category: 'surface', badges: [] },
    docs: { category: 'surface', badges: [] },
    analyses: { category: 'surface', badges: [] },
    commands: { category: 'surface', badges: [] },
    tools: { category: 'surface', badges: [] },
    handoff: {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'write memory doc → (later) read doc back → continue where it left off',
      lanes: 'same lane',
      prompt: HANDOFF_WRITE_PROMPT,
    },
    resume: {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'read handoff doc → continue where it left off',
      lanes: 'same lane',
      prompt: handoffResumePrompt('<lane>'),
    },
    wiki: {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'read conversation → distill durable knowledge → write wiki pages',
      lanes: 'same lane',
      prompt: wikiIngestPrompt('<hint>'),
    },
    recall: {
      category: 'agent',
      badges: ['agent'],
      prompt: wikiRecallPrompt('<question>'),
    },
    directive: {
      category: 'agent',
      badges: ['agent'],
      prompt: directivePrompt('<config-path>', '<intent>'),
    },
    draw: {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'discover canvas → inspect shapes → batch edit via /exec → verify screenshot',
      lanes: 'same lane',
      prompt: tldrawDrawPrompt('<drawing request>'),
    },
    review: {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'pick reviewer lanes → peer_send review request → collect verdicts → summary',
      lanes: 'N lanes',
      prompt: reviewRequestPrompt({
        reviewers: ['<reviewer-1>', '<reviewer-2>'],
        subject: { kind: 'doc', path: '<doc — or the working diff>' },
        intent: '<intent>',
      }),
    },
    orchestrator: { category: 'agent', badges: [], alias: 'console' },
    polly: {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'ensure workers (pool minus self) → fan-out via peer_send → cross-review → synthesis',
      lanes: '3 lanes',
      prompt: pollyRequestPrompt({
        task: '<task>',
        intent: '',
        roster: {
          orchestrator: PLACEHOLDER_ORCHESTRATOR,
          workers: [
            { displayName: '<worker-1>', laneId: '<lane-id>', backendId: 'cursor' },
            { displayName: '<worker-2>', laneId: '<lane-id>', backendId: 'claude' },
          ],
          spawned: [],
          missing: [],
          errored: [],
        },
      }),
    },
    debby: {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'ensure heads (claude + codex, always) → fan question → side-by-side + debate → synthesis',
      lanes: '3 lanes',
      prompt: debbyRequestPrompt({
        task: '<question>',
        intent: '',
        roster: {
          orchestrator: PLACEHOLDER_ORCHESTRATOR,
          heads: [
            { displayName: '<head-1>', laneId: '<lane-id>', backendId: 'claude' },
            { displayName: '<head-2>', laneId: '<lane-id>', backendId: 'codex' },
          ],
          spawned: [],
          missing: [],
          errored: [],
        },
      }),
    },
    salty: {
      category: 'agent',
      badges: ['workflow'],
      anatomy:
        'ensure tiered executors (sonnet/opus/codex, +fable opt-in) → plan → thinker/codex pushback → dispatch by tier → gates + cross-review → synthesis',
      lanes: '4 lanes (+fellow: 5)',
      prompt: saltyRequestPrompt({
        task: '<task>',
        intent: '',
        roster: {
          orchestrator: PLACEHOLDER_ORCHESTRATOR,
          executors: [
            {
              displayName: '<mechanical>',
              laneId: '<lane-id>',
              backendId: 'claude',
              role: 'mechanical',
              modelApply: { requested: 'sonnet', effective: '<model-id>', applied: true },
            },
            {
              displayName: '<thinker>',
              laneId: '<lane-id>',
              backendId: 'claude',
              role: 'thinker',
              modelApply: { requested: 'opus', effective: '<model-id>', applied: true },
            },
            {
              displayName: '<codex-peer>',
              laneId: '<lane-id>',
              backendId: 'codex',
              role: 'codexPeer',
              modelApply: { effective: '<model-id>', applied: true },
            },
          ],
          spawned: [],
          missing: [],
          errored: [],
        },
      }),
    },
    'dispatch-github-issue': {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'parse ref → gh fetch title → spawn lane → dispatch fix',
      lanes: '+1 lane',
      prompt: issueFixPrompt({
        issueKey: '<owner/repo#123>',
        title: '<title>',
        issueUrl: '<issue-url>',
        repo: '<owner/repo>',
        number: '<123>',
      }),
    },
    'create-github-issue': {
      category: 'agent',
      badges: ['agent'],
      lanes: 'same lane',
      prompt: createGithubIssuePrompt('<what to file>', '<owner/repo>'),
    },
    'analyze-github-issue': {
      category: 'agent',
      badges: ['agent'],
      lanes: 'same lane',
      prompt: analyzeGithubIssuePrompt(ISSUE_VERB_PLACEHOLDER),
    },
    'fix-github-issue': {
      category: 'agent',
      badges: ['agent'],
      lanes: 'same lane',
      prompt: fixGithubIssuePrompt(ISSUE_VERB_PLACEHOLDER),
    },
    'tag-github-issue': {
      category: 'agent',
      badges: ['agent'],
      lanes: 'same lane',
      prompt: tagGithubIssuePrompt(ISSUE_VERB_PLACEHOLDER),
    },
    'post-github-comment': {
      category: 'agent',
      badges: ['agent'],
      lanes: 'same lane',
      prompt: postGithubCommentPrompt(ISSUE_VERB_PLACEHOLDER),
    },
    'handle-github-issue': {
      category: 'agent',
      badges: ['workflow'],
      anatomy: 'analyze → fix (in lane) → comment',
      lanes: 'same lane',
      // Render the composed verb the way the lane receives it: tokens resolved.
      prompt: resolveVerbTokens(handleGithubIssuePrompt(ISSUE_VERB_PLACEHOLDER), injectableVerbPrompt),
    },
  };
}

/** Placeholder ref for rendering the issue verbs in the /commands manifest. */
const ISSUE_VERB_PLACEHOLDER = {
  issueKey: '<owner/repo#123>',
  repo: '<owner/repo>',
  number: '<123>',
  url: '<issue-url>',
} as const;

/**
 * The full built-in command manifest served at GET /commands.json. Built from
 * the SAME roster (`HASH_COMMANDS`) and the SAME prompt builders the dispatch
 * uses, so the reference page cannot drift.
 */
export function buildCommandManifest(): CommandManifestEntry[] {
  const meta = commandMeta();
  return HASH_COMMANDS.map((c) => {
    const m = meta[c.name] ?? { category: 'session' as const, badges: [] };
    return { name: c.name, args: c.args, description: c.description, ...m };
  });
}
