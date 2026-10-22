import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { followUpShellArgs } from './follow-up-run';

/** Run the wrapper the way the terminal tab does, with `/bin/sh` as the user's
 *  shell and no stdin, so the final interactive shell reads EOF and exits. */
function run(command: string): { stdout: string; status: number | null } {
  const result = spawnSync('/bin/sh', followUpShellArgs(command), {
    env: { ...process.env, SHELL: '/bin/sh' },
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { stdout: result.stdout, status: result.status };
}

describe('followUpShellArgs', () => {
  it('echoes the command, runs it, reports its exit status, then hands over to a shell', () => {
    const { stdout, status } = run('echo hello-follow-up; exit 3');
    expect(stdout).toContain('$ echo hello-follow-up; exit 3');
    expect(stdout).toContain('hello-follow-up');
    expect(stdout).toContain('[krypton] exit 3');
    // The wrapper did not stop at the command's failure: the login shell ran and read EOF.
    expect(status).toBe(0);
  });

  it('passes the command as data, so quotes and substitutions mean what they say in it', () => {
    const { stdout } = run(`printf '%s\\n' "it's $((40 + 2))"`);
    expect(stdout).toContain("it's 42");
    expect(stdout).toContain('[krypton] exit 0');
  });
});
