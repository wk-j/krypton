// Krypton — built-in `#` command palette for the ACP harness composer.
//
// Unlike the slash palette (agent-provided `/` commands) and the mention palette
// (`@lane` peers), `#` commands are handled entirely by the harness itself in
// `AcpHarnessView.runHashCommand`. This module is the single source of truth for
// what those commands are, so the composer can offer discoverable autocomplete
// without the user having to memorise them. Keep this list in sync with the
// dispatch in `runHashCommand`.

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
  { name: 'handoff', args: '', description: 'write a resume-ready handoff doc to memory' },
  { name: 'resume', args: '', description: 'resume from the last handoff doc' },
  { name: 'wiki', args: '[<hint>]', description: 'ingest this conversation into the repo wiki' },
  { name: 'recall', args: '<question>', description: 'answer a question from the repo wiki' },
  { name: 'directive', args: '<what to create/change>', description: 'author a reusable harness directive' },
  { name: 'review', args: '[<lane>…] [-- <doc | note>]', description: 'run a multi-reviewer design/diff review' },
  { name: 'polly', args: '<task>', description: 'Polly orchestration — spawns Cursor + Claude + Codex workers' },
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
