import { describe, expect, it } from 'vitest';

import { followUp, followUpCandidates, followUpReply } from './follow-up';
import type { AssistContext, AssistTaskConfig } from '../types';
import type { HarnessTranscriptItem } from '../../harness-view-types';

function cfg(over: Partial<AssistTaskConfig> = {}): AssistTaskConfig {
  return {
    mode: 'auto',
    backendId: 'claude',
    modelId: 'haiku',
    options: { count: 3 },
    maxInputChars: 6_000,
    timeoutMs: 8_000,
    ...over,
  };
}

function textItem(id: string, kind: 'user' | 'assistant', text: string): HarnessTranscriptItem {
  return { id, kind, text };
}

function ctx(reply: string): AssistContext {
  return {
    laneId: 'lane-1',
    laneName: 'OMP-1',
    backendId: 'omp',
    modelName: 'claude-opus-5',
    projectDir: '/Users/wk/Source/krypton',
    turn: [textItem('u1', 'user', 'wire it up'), textItem('a1', 'assistant', reply)],
  };
}

const REPLY = [
  'Done. To try it locally, run `make install`, then open http://localhost:5173/docs.',
  'The rail lives in `src/acp/components/follow-up-rail/index.ts`.',
  "I didn't run the suite — `npm test` should be green.",
].join('\n');

describe('followUpCandidates', () => {
  it('takes multi-word inline spans and bare URLs in reply order, as run or open', () => {
    expect(followUpCandidates(REPLY)).toEqual([
      { kind: 'run', target: 'make install' },
      { kind: 'open', target: 'http://localhost:5173/docs' },
      { kind: 'run', target: 'npm test' },
    ]);
  });

  it('never offers a one-word span — a commit hash, path, symbol or flag — as a command', () => {
    const text = 'Committed as `b6c2b6d3` on `main` — see `src/a.ts`, `followUpShellArgs` and `--force`.';
    expect(followUpCandidates(text)).toEqual([]);
    expect(followUpCandidates(`${text} Inspect it with \`git show b6c2b6d3\`.`)).toEqual([
      { kind: 'run', target: 'git show b6c2b6d3' },
    ]);
  });

  it('turns a shell fence into one command and keeps only its prompt lines', () => {
    const text = [
      '```console',
      '$ cd src-tauri',
      '$ cargo test acp_updates',
      'running 7 tests',
      '```',
    ].join('\n');
    expect(followUpCandidates(text)).toEqual([{ kind: 'run', target: 'cd src-tauri\ncargo test acp_updates' }]);
  });

  it('ignores everything inside a non-shell fence', () => {
    const text = ['```ts', "fetch('http://localhost:9999/x'); `npm run nope`", '```', 'run `npm test`'].join('\n');
    expect(followUpCandidates(text)).toEqual([{ kind: 'run', target: 'npm test' }]);
  });

  it('drops a fence that is too long to read on a button', () => {
    const text = ['```sh', ...Array.from({ length: 7 }, (_, i) => `echo ${i}`), '```'].join('\n');
    expect(followUpCandidates(text)).toEqual([]);
  });

  it('never offers a scheme other than http(s)', () => {
    expect(followUpCandidates('see file:///etc/passwd or javascript:alert(1)')).toEqual([]);
  });

  it('strips sentence punctuation after a bare URL but keeps a span URL as written', () => {
    expect(followUpCandidates('open https://example.com/a?b=1. or `http://localhost:3000/`')).toEqual([
      { kind: 'open', target: 'https://example.com/a?b=1' },
      { kind: 'open', target: 'http://localhost:3000/' },
    ]);
  });

  it('keeps one copy per target at its last position and caps at the newest 20', () => {
    expect(followUpCandidates('`npm test` then `make install` then `npm test`')).toEqual([
      { kind: 'run', target: 'make install' },
      { kind: 'run', target: 'npm test' },
    ]);
    const many = Array.from({ length: 25 }, (_, i) => `\`echo ${i}\``).join(' ');
    const out = followUpCandidates(many);
    expect(out).toHaveLength(20);
    expect(out[0].target).toBe('echo 5');
    expect(out[19].target).toBe('echo 24');
  });
});

describe('follow-up task', () => {
  it('asks about any reply, candidates or not: a prompt needs none', () => {
    expect(followUp.eligible?.(ctx('All done, nothing else to do.'), cfg())).toBe(true);
    expect(followUp.eligible?.(ctx('   '), cfg())).toBe(false);
    expect(followUp.payload(ctx('All done.'), { maxInputChars: 6_000, timeoutMs: 8_000 }))
      .toContain('--- candidates ---\n(none)\n--- agent replied ---');
  });

  it('numbers the candidates ahead of the reply text', () => {
    const payload = followUp.payload(ctx(REPLY), { maxInputChars: 6_000, timeoutMs: 8_000 });
    const candidates = payload.indexOf('--- candidates ---');
    const reply = payload.indexOf('--- agent replied ---');
    expect(candidates).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(candidates);
    expect(payload).toContain('1. run: make install\n2. open: http://localhost:5173/docs');
    expect(payload).toContain('3. run: npm test');
  });

  it('copies the target from the picked candidate, never from the model', () => {
    const raw = '{"actions":[{"id":1,"label":"install the app","target":"rm -rf ~"},{"id":"2","label":"open the docs"}]}';
    expect(followUp.parse(raw, cfg(), ctx(REPLY))).toEqual([
      { followUpKind: 'run', label: 'install the app', target: 'make install', hintLabel: null },
      { followUpKind: 'open', label: 'open the docs', target: 'http://localhost:5173/docs', hintLabel: null },
    ]);
  });

  it('treats an empty list as a quiet answer and garbage as invalid', () => {
    expect(followUp.parse('{"actions":[]}', cfg(), ctx(REPLY))).toEqual([]);
    expect(followUp.parse('no json here', cfg(), ctx(REPLY))).toBeNull();
    expect(followUp.parse('{"actions":[{"id":9,"label":"x"},{"id":1,"label":""}]}', cfg(), ctx(REPLY))).toBeNull();
  });

  it('drops unknown and repeated ids and honours count', () => {
    const raw = JSON.stringify({
      actions: [
        { id: 3, label: 'run the tests' },
        { id: 3, label: 'run them again' },
        { id: 0, label: 'nothing' },
        { id: 1, label: 'install' },
        { id: 2, label: 'open docs' },
      ],
    });
    expect(followUp.parse(raw, cfg({ options: { count: 2 } }), ctx(REPLY))?.map((a) => a.target)).toEqual([
      'npm test',
      'make install',
    ]);
  });

  it('keeps an action whose label runs long, cut at a word to 40 characters', () => {
    // haiku answered with this 41-character label for the action that mattered most.
    const raw = '{"actions":[{"id":1,"label":"build and install the app to try the rail"}]}';
    const [action] = followUp.parse(raw, cfg(), ctx(REPLY)) ?? [];
    expect(action?.target).toBe('make install');
    expect(action?.label).toBe('build and install the app to try the…');
    expect(action?.label.length).toBeLessThanOrEqual(40);
  });

  it('takes a prompt from the model, whitespace collapsed, and caps it with the candidates', () => {
    const raw = JSON.stringify({
      actions: [
        { prompt: '  Post the load-test review summary\n to #1329 with the post-github-comment skill. ', label: 'post summary to #1329' },
        { id: 1, label: 'install the app' },
        { id: null, prompt: 'Open a PR that sets the pool size back to 20.', label: 'open the pool pr' },
        { prompt: 'Rerun the load test.', label: 'rerun' },
      ],
    });
    expect(followUp.parse(raw, cfg(), ctx(REPLY))).toEqual([
      {
        followUpKind: 'prompt',
        label: 'post summary to #1329',
        target: 'Post the load-test review summary to #1329 with the post-github-comment skill.',
        hintLabel: null,
      },
      { followUpKind: 'run', label: 'install the app', target: 'make install', hintLabel: null },
      { followUpKind: 'prompt', label: 'open the pool pr', target: 'Open a PR that sets the pool size back to 20.', hintLabel: null },
    ]);
  });

  it('drops a prompt the composer would route elsewhere, expand, cut or repeat', () => {
    const dropped = [
      '#review the summary please',
      '!gh issue comment 1329',
      '/compact the conversation now',
      '@OMP-2 post the summary for me',
      'Post the summary with {{#review}} to #1329.',
      'short',
      `Post ${'x'.repeat(240)}`,
    ];
    const raw = JSON.stringify({ actions: dropped.map((prompt) => ({ prompt, label: 'nope' })) });
    expect(followUp.parse(raw, cfg(), ctx(REPLY))).toBeNull();

    const repeated = JSON.stringify({
      actions: [
        { prompt: 'Post the summary to #1329.', label: 'post it' },
        { prompt: 'Post the  summary to #1329.', label: 'post it again' },
        { id: 1, prompt: 'Ignored when an id is given.', label: 'install' },
      ],
    });
    expect(followUp.parse(repeated, cfg(), ctx(REPLY))?.map((a) => [a.followUpKind, a.target])).toEqual([
      ['prompt', 'Post the summary to #1329.'],
      ['run', 'make install'],
    ]);
  });

  it('reads the last non-empty reply of the turn', () => {
    const c = ctx('first');
    const turn = [...c.turn, textItem('a2', 'assistant', 'second'), textItem('a3', 'assistant', '  ')];
    expect(followUpReply({ ...c, turn })?.id).toBe('a2');
  });
});
