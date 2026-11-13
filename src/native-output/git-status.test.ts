import { describe, expect, it } from 'vitest';

import { branchLine, gitStatusText, isGitStatusCmdline, parseGitStatus } from './git-status';

const HASH = 'a'.repeat(40);
const ordinary = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} ${path}`;

const RAW = {
  status: [
    `# branch.oid ${HASH}`,
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +2 -1',
    ordinary('M.', 'src/staged.ts'),
    ordinary('.M', 'docs/a file.md'),
    ordinary('MM', 'src/both.ts'),
    `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 src/new name.ts`,
    'src/old name.ts',
    `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} src/conflict.ts`,
    '? src/native-output/',
    '',
  ].join('\0'),
  staged_numstat: ['3\t1\tsrc/staged.ts', '5\t0\tsrc/both.ts', '0\t0\t', 'src/old name.ts', 'src/new name.ts', ''].join('\0'),
  unstaged_numstat: ['2\t0\tdocs/a file.md', '1\t4\tsrc/both.ts', '-\t-\tsrc/conflict.ts', ''].join('\0'),
};

describe('parseGitStatus', () => {
  it('splits each path into its staged and unstaged side, with numstat counts', () => {
    const status = parseGitStatus(RAW);
    expect(status?.branch).toEqual({ head: 'feature/x', oid: HASH, upstream: 'origin/feature/x', ahead: 2, behind: 1 });
    const rows = status?.groups.map((g) => [g.kind, g.entries.map((e) => [e.code, e.path, e.oldPath, e.added, e.deleted])]);
    expect(rows).toEqual([
      ['conflicts', [['UU', 'src/conflict.ts', null, null, null]]],
      ['staged', [
        ['M', 'src/staged.ts', null, 3, 1],
        ['M', 'src/both.ts', null, 5, 0],
        ['R', 'src/new name.ts', 'src/old name.ts', 0, 0],
      ]],
      ['unstaged', [
        ['M', 'docs/a file.md', null, 2, 0],
        ['M', 'src/both.ts', null, 1, 4],
      ]],
      ['untracked', [['?', 'src/native-output/', null, null, null]]],
    ]);
  });

  it('reads a clean, detached, upstream-less, first-commit repo', () => {
    const status = parseGitStatus({ status: '# branch.oid (initial)\0# branch.head (detached)\0', staged_numstat: '', unstaged_numstat: '' });
    expect(status).toEqual({ branch: { head: null, oid: null, upstream: null, ahead: 0, behind: 0 }, groups: [] });
  });

  it('marks a gitlink when a porcelain mode is 160000', () => {
    const status = parseGitStatus({
      status: [
        `# branch.oid ${HASH}`,
        '# branch.head main',
        `1 M. N... 160000 160000 160000 ${HASH} ${HASH} vendor/lib`,
        '',
      ].join('\0'),
      staged_numstat: '',
      unstaged_numstat: '',
    });
    expect(status?.groups[0]?.entries[0]?.submodule).toBe(true);
    expect(status?.groups[0]?.entries[0]?.path).toBe('vendor/lib');
  });

  it('rejects output without the porcelain v2 branch header', () => {
    expect(parseGitStatus({ status: 'On branch master\nnothing to commit', staged_numstat: '', unstaged_numstat: '' })).toBeNull();
  });
});

describe('branchLine and gitStatusText', () => {
  it('describe the branch the way the card and Copy show it', () => {
    expect(branchLine({ head: 'master', oid: HASH, upstream: 'origin/master', ahead: 1, behind: 0 })).toBe('master → origin/master ↑1 ↓0');
    expect(branchLine({ head: 'topic', oid: HASH, upstream: null, ahead: 0, behind: 0 })).toBe('topic (no upstream)');
    expect(branchLine({ head: null, oid: HASH, upstream: null, ahead: 0, behind: 0 })).toBe('detached at aaaaaaa');
    const status = parseGitStatus(RAW);
    expect(status && gitStatusText(status).split('\n')).toContain('  R  src/old name.ts -> src/new name.ts');
  });
});

describe('isGitStatusCmdline', () => {
  it('matches git status with or without --no-pager, nothing else', () => {
    expect(isGitStatusCmdline('git status')).toBe(true);
    expect(isGitStatusCmdline('git --no-pager status -sb')).toBe(true);
    expect(isGitStatusCmdline('git stash')).toBe(false);
    expect(isGitStatusCmdline('git statusx')).toBe(false);
  });
});
