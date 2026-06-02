import { describe, expect, it } from 'vitest';

import { classifyBashCommand } from './tools';

describe('classifyBashCommand', () => {
  // [command, needsApproval, risk, highRisk]
  const cases: Array<[string, boolean, string, boolean]> = [
    // Read-only allowlist — no approval, not high-risk
    ['ls -la', false, 'unknown', false],
    ['git status', false, 'unknown', false], // safe git falls through to the read-only default
    ['cat file.txt | grep foo', false, 'unknown', false],
    ['', false, 'unknown', false],

    // Low-risk writes — approval, but blanket-able (not high-risk)
    ['touch newfile', true, 'write', false],
    ['mkdir -p src/foo', true, 'write', false],

    // Destructive writes — high-risk
    ['rm -rf build', true, 'write', true],
    ['rmdir dir', true, 'write', true],
    ['dd if=/dev/zero of=disk', true, 'write', true],
    ['mv a b', true, 'write', true],
    ['cp -r a b', true, 'write', true],
    ['chmod 777 file', true, 'write', true],
    ['truncate -s 0 log', true, 'write', true],
    ['sed -i s/a/b/ file', true, 'write', true],

    // Dangerous git — high-risk; recoverable git — not
    ['git push --force', true, 'git', true],
    ['git reset --hard HEAD', true, 'git', true],
    ['git clean -fd', true, 'git', true],
    ['git checkout .', true, 'git', true],
    ['git commit -m wip', true, 'git', false],

    // Scripts / network / unknown — always high-risk (conservative)
    ['bash deploy.sh', true, 'script', true],
    ['node script.js', true, 'script', true],
    ['npm install', true, 'network', true],
    ['curl https://example.com', true, 'network', true],
    ['npm test', false, 'unknown', false],
    ['somerandomtool --go', true, 'unknown', true],

    // Redirection / heredoc — overwrites files, high-risk
    ['echo hi > file', true, 'write', true],
    ['cat <<EOF', true, 'write', true],

    // Compound: a dangerous segment after a read-only one still taints the command
    ['cat x && rm bar', true, 'write', true],
  ];

  for (const [command, needsApproval, risk, highRisk] of cases) {
    it(`classifies \`${command || '(empty)'}\``, () => {
      const r = classifyBashCommand(command);
      expect(r.needsApproval).toBe(needsApproval);
      expect(r.risk).toBe(risk);
      expect(r.highRisk).toBe(highRisk);
    });
  }

  it('never marks a no-approval command as high-risk', () => {
    for (const [command] of cases) {
      const r = classifyBashCommand(command);
      if (!r.needsApproval) expect(r.highRisk).toBe(false);
    }
  });
});
