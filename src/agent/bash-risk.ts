// Krypton — shell command risk classification (spec 140 / 143).
//
// Pure: no IPC and no Tauri imports, so the ACP lane decoder can use it to gate
// permissions (spec 380) and the spec 381 gallery can run that decoder in a
// browser. `agent/tools.ts` re-exports it for the agent's bash tool.

export type BashRisk = 'write' | 'git' | 'network' | 'script' | 'unknown';

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
