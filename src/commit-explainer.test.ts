import { describe, expect, it, vi } from 'vitest';

import type { AcpClient } from './acp/client';
import type { AcpEvent, AcpInstanceOwner, StopReason } from './acp/types';
import {
  CommitExplainer,
  DECLINED_CONTINUE_PROMPT,
  EXPLAIN_MAX_CONTINUATIONS,
  jobSubject,
  resolveExplainConfig,
  type ExplainChange,
  type KnowledgeJob,
} from './commit-explainer';
import type { KnowledgeConfig } from './config';

const ROOT = '/repo';

class FakeClient {
  readonly listeners: ((e: AcpEvent) => void)[] = [];
  readonly prompts: string[] = [];
  readonly permissionAnswers: [number, string | null][] = [];
  readonly fsAnswers: [number, boolean][] = [];
  mode: string | null = null;
  model: string | null = null;
  cancelled = 0;
  disposed = false;
  rejectMode = false;
  private finish: ((stop: StopReason) => void) | null = null;

  constructor(readonly cwd: string, readonly owner: AcpInstanceOwner) {}

  async initializeOnly(): Promise<object> { return {}; }
  onEvent(cb: (e: AcpEvent) => void): () => void {
    this.listeners.push(cb);
    return () => undefined;
  }
  async sessionNew(): Promise<object> {
    return { session_id: 's', available_models: [{ model_id: 'gpt-6.1-sol[low]', name: 'low' }] };
  }
  async setLaneModel(model: string): Promise<'ok'> {
    this.model = model;
    return 'ok';
  }
  async setSessionMode(mode: string): Promise<void> {
    if (this.rejectMode) throw new Error('invalid params');
    this.mode = mode;
  }
  prompt(blocks: { text: string }[]): Promise<StopReason> {
    this.prompts.push(blocks[0].text);
    // Executor form: tsconfig's ES2021 lib has no `Promise.withResolvers`.
    return new Promise<StopReason>((resolve) => { this.finish = resolve; });
  }
  async cancel(): Promise<void> { this.cancelled += 1; }
  async dispose(): Promise<void> { this.disposed = true; }
  async respondPermission(id: number, option: string | null): Promise<void> { this.permissionAnswers.push([id, option]); }
  async respondFsWrite(id: number, accept: boolean): Promise<void> { this.fsAnswers.push([id, accept]); }

  emit(event: AcpEvent): void {
    for (const cb of this.listeners) cb(event);
  }
  end(stop: StopReason = 'end_turn'): void {
    this.finish?.(stop);
  }
}

function rig(knowledge: Partial<KnowledgeConfig> = {}, opts: { rejectMode?: boolean } = {}) {
  const clients: FakeClient[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const changes: ExplainChange[] = [];
  const explainer = new CommitExplainer({
    config: async () => ({ parallel: 2, ...knowledge }),
    invoke: (async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      const sha = String(args.sha).slice(0, 7);
      if (cmd === 'knowledge_job_prepare') {
        const scratch = `/tmp/krypton-learn/repo-${sha}`;
        return { scratch, draft: `${scratch}/explainer.md`, path: `/k/repo-${sha}.md`, repo: 'repo' } satisfies KnowledgeJob;
      }
      if (cmd === 'knowledge_store') return `/k/repo-${sha}.md`;
      throw new Error(`unexpected ${cmd}`);
    }) as <T>(cmd: string, args: Record<string, unknown>) => Promise<T>,
    spawn: async (_backend, cwd, owner) => {
      const client = new FakeClient(cwd, owner);
      client.rejectMode = opts.rejectMode ?? false;
      clients.push(client);
      return client as unknown as AcpClient;
    },
    home: async () => '/Users/me',
    graceMs: 0,
  });
  explainer.subscribe((change) => changes.push(change));
  const settled = (): ExplainChange[] => changes.filter((c) => c.kind !== 'update');
  return { explainer, clients, calls, changes, settled };
}

describe('CommitExplainer (spec 0376)', () => {
  it('runs a job in a sandboxed scratch session and stores the draft after end_turn', async () => {
    const r = rig();
    r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    const client = r.clients[0];

    expect(client.cwd).toBe('/tmp/krypton-learn/repo-abcdef1');
    expect(client.owner).toMatchObject({ role: 'commit_explainer', label: 'explain repo@abcdef1' });
    expect(client.mode).toBe('workspace-write');
    expect(client.model).toBe('gpt-6.1-sol[high]');
    expect(client.prompts[0]).toContain(`Repository path (data): ${JSON.stringify(ROOT)}`);
    expect(client.prompts[0]).toContain(JSON.stringify('/tmp/krypton-learn/repo-abcdef1/explainer.md'));
    expect(r.calls.map(([cmd]) => cmd)).toEqual(['knowledge_job_prepare']);

    client.end('end_turn');
    await vi.waitFor(() => expect(r.settled()).toHaveLength(1));
    expect(r.settled()[0]).toMatchObject({ kind: 'ready', path: '/k/repo-abcdef1.md' });
    expect(r.calls.map(([cmd]) => cmd)).toEqual(['knowledge_job_prepare', 'knowledge_store']);
    expect(client.disposed).toBe(true);
    expect(r.explainer.job(ROOT, 'abcdef1234')).toBeNull();
  });

  it('declines approvals with the reject_once option so the turn goes on, and refuses fs writes', async () => {
    const r = rig();
    r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    const client = r.clients[0];

    client.emit({
      type: 'permission_request',
      requestId: 7,
      toolCall: { toolCallId: 't', title: 'git commit' } as never,
      options: [
        { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
        { optionId: 'approved-for-session', name: 'Always', kind: 'allow_always' },
        { optionId: 'decline', name: 'No, continue', kind: 'reject_once' },
        { optionId: 'cancel', name: 'No, stop', kind: 'reject_once' },
      ],
    });
    client.emit({ type: 'fs_write_pending', requestId: 8, path: '/repo/x', oldText: '', newText: 'y' });
    await vi.waitFor(() => expect(client.fsAnswers).toEqual([[8, false]]));
    expect(client.permissionAnswers).toEqual([[7, 'decline']]);
    expect(client.cancelled).toBe(0);
  });

  it('continues after a declined escalation ended the turn, and gives up after the cap', async () => {
    const r = rig();
    r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    const client = r.clients[0];
    // A sandbox escalation offers only `cancel`, which ends codex's turn.
    const escalate = (requestId: number): void => client.emit({
      type: 'permission_request',
      requestId,
      toolCall: { toolCallId: 't', title: 'Run command' } as never,
      options: [
        { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'cancel', name: 'No', kind: 'reject_once' },
      ],
    });
    for (let turn = 1; turn <= EXPLAIN_MAX_CONTINUATIONS; turn += 1) {
      escalate(turn);
      client.end('cancelled');
      await vi.waitFor(() => expect(client.prompts).toHaveLength(turn + 1));
      expect(client.prompts[turn]).toBe(DECLINED_CONTINUE_PROMPT);
    }
    expect(client.permissionAnswers.every(([, option]) => option === 'cancel')).toBe(true);
    escalate(99);
    client.end('cancelled');
    await vi.waitFor(() => expect(r.settled()).toHaveLength(1));
    expect(r.settled()[0]).toMatchObject({ kind: 'failed', message: '"codex" kept asking for approval — a background job declines every request' });
    expect(r.calls.map(([cmd]) => cmd)).not.toContain('knowledge_store');
  });

  it('stores the draft when a continuation turn ends the job normally', async () => {
    const r = rig();
    r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    const client = r.clients[0];
    client.emit({
      type: 'permission_request',
      requestId: 1,
      toolCall: { toolCallId: 't', title: 'Run command' } as never,
      options: [{ optionId: 'cancel', name: 'No', kind: 'reject_once' }],
    });
    client.end('cancelled');
    await vi.waitFor(() => expect(client.prompts).toHaveLength(2));
    expect(r.explainer.job(ROOT, 'abcdef1234')).toMatchObject({ phase: 'continuing', continuations: 1 });
    client.end('end_turn');
    await vi.waitFor(() => expect(r.settled()).toHaveLength(1));
    expect(r.settled()[0]).toMatchObject({ kind: 'ready', path: '/k/repo-abcdef1.md' });
  });

  it('runs at most `parallel` jobs and starts the next queued one when a slot frees', async () => {
    const r = rig({ parallel: 2 });
    r.explainer.start(ROOT, 'repo', 'aaaaaaa1');
    r.explainer.start(ROOT, 'repo', 'bbbbbbb2');
    const third = r.explainer.start(ROOT, 'repo', 'ccccccc3');
    await vi.waitFor(() => expect(r.clients.map((c) => c.prompts.length)).toEqual([1, 1]));
    expect(third.state).toBe('queued');
    expect(r.explainer.queuedAhead(third)).toBe(0);

    r.clients[1].end('end_turn');
    await vi.waitFor(() => expect(r.clients).toHaveLength(3));
    expect(r.clients[2].cwd).toBe('/tmp/krypton-learn/repo-ccccccc');
  });

  it('returns the live job for a commit that is already queued or running', () => {
    const r = rig();
    const first = r.explainer.start(ROOT, 'repo', 'abcdef1234');
    expect(r.explainer.start(ROOT, 'repo', 'abcdef1234')).toBe(first);
  });

  it('fails without prompting when the backend rejects the mode', async () => {
    const r = rig({}, { rejectMode: true });
    r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.settled()).toHaveLength(1));
    expect(r.settled()[0]).toMatchObject({
      kind: 'failed',
      message: '"codex" rejected mode "workspace-write" — set [knowledge] mode',
    });
    expect(r.clients[0].prompts).toEqual([]);
    expect(r.clients[0].disposed).toBe(true);
  });

  it('fails a turn that stops short of end_turn and never stores', async () => {
    const r = rig();
    r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    r.clients[0].end('max_tokens');
    await vi.waitFor(() => expect(r.settled()).toHaveLength(1));
    expect(r.settled()[0]).toMatchObject({ kind: 'failed', message: 'turn stopped (max_tokens)' });
    expect(r.calls.map(([cmd]) => cmd)).not.toContain('knowledge_store');
  });

  it('fails a job whose agent asked a question, after cancelling the turn', async () => {
    const r = rig();
    r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    const client = r.clients[0];
    client.emit({ type: 'elicitation_request', requestId: 3, message: 'Which file?', requestedSchema: {} });
    expect(client.cancelled).toBe(1);
    client.end('cancelled');
    await vi.waitFor(() => expect(r.settled()).toHaveLength(1));
    expect(r.settled()[0]).toMatchObject({ kind: 'failed', message: '"codex" asked a question — a background job cannot answer' });
  });

  it('cancels a queued job without spawning and a running job once, freeing its slot when the turn ends', async () => {
    const r = rig({ parallel: 1 });
    r.explainer.start(ROOT, 'repo', 'aaaaaaa1');
    r.explainer.start(ROOT, 'repo', 'bbbbbbb2');
    r.explainer.start(ROOT, 'repo', 'ccccccc3');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));

    expect(r.explainer.cancel(ROOT, 'bbbbbbb2')).toBe(true);
    expect(r.explainer.cancel(ROOT, 'aaaaaaa1')).toBe(true);
    expect(r.clients[0].cancelled).toBe(1);
    expect(r.settled().map((c) => [c.kind, c.job.sha])).toEqual([
      ['cancelled', 'bbbbbbb2'],
      ['cancelled', 'aaaaaaa1'],
    ]);
    expect(r.clients).toHaveLength(1);

    r.clients[0].end('cancelled');
    await vi.waitFor(() => expect(r.clients).toHaveLength(2));
    expect(r.clients[1].cwd).toBe('/tmp/krypton-learn/repo-ccccccc');
    expect(r.clients[0].disposed).toBe(true);
    expect(r.settled()).toHaveLength(2);
    expect(r.calls.filter(([cmd]) => cmd === 'knowledge_store')).toEqual([]);
  });

  it('disposes a running job that ignores cancel once the grace period ends', async () => {
    const r = rig({ parallel: 1 });
    r.explainer.start(ROOT, 'repo', 'aaaaaaa1');
    r.explainer.start(ROOT, 'repo', 'bbbbbbb2');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    r.explainer.cancel(ROOT, 'aaaaaaa1');
    await vi.waitFor(() => expect(r.clients).toHaveLength(2));
    expect(r.clients[0].disposed).toBe(true);
  });

  it('keeps the last four tool calls as steps, counts every call, and merges updates by id', async () => {
    const r = rig();
    const job = r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    const client = r.clients[0];
    for (let n = 1; n <= 5; n += 1) {
      client.emit({
        type: 'tool_call',
        call: { toolCallId: `t${n}`, kind: 'read', status: 'in_progress', locations: [{ path: `${ROOT}/src/F${n}.ts` }] },
      });
    }
    client.emit({ type: 'tool_call_update', update: { toolCallId: 't4', status: 'failed' } });
    client.emit({ type: 'tool_call_update', update: { toolCallId: 't5', status: 'completed' } });
    const before = r.changes.length;
    // t1 fell out of the kept steps: its update changes nothing.
    client.emit({ type: 'tool_call_update', update: { toolCallId: 't1', status: 'completed' } });

    expect(r.changes).toHaveLength(before);
    expect(job.stepCount).toBe(5);
    expect(job.steps.map((s) => [s.id, s.kind, s.subject, s.state])).toEqual([
      ['t2', 'read', 'src/F2.ts', 'running'],
      ['t3', 'read', 'src/F3.ts', 'running'],
      ['t4', 'read', 'src/F4.ts', 'failed'],
      ['t5', 'read', 'src/F5.ts', 'done'],
    ]);
  });

  it('follows the agent between tools: chunks set the phase once per change, subagent chunks never', async () => {
    const r = rig();
    const job = r.explainer.start(ROOT, 'repo', 'abcdef1234');
    await vi.waitFor(() => expect(r.clients[0]?.prompts).toHaveLength(1));
    const client = r.clients[0];
    expect(job.phase).toBe('thinking');
    const before = r.changes.length;

    client.emit({ type: 'message_chunk', text: 'a', content: { type: 'text', text: 'a' } });
    client.emit({ type: 'message_chunk', text: 'b', content: { type: 'text', text: 'b' } });
    expect(job.phase).toBe('replying');
    expect(r.changes).toHaveLength(before + 1);

    client.emit({ type: 'thought_chunk', text: 'sub', parentToolUseId: 'task-1' });
    expect(job.phase).toBe('replying');
    client.emit({ type: 'thought_chunk', text: 'hm' });
    expect(job.phase).toBe('thinking');
  });
});

describe('resolveExplainConfig', () => {
  it('clamps parallel to 1–4 and keeps an empty model as the backend default', () => {
    expect(resolveExplainConfig({ parallel: 0 }).parallel).toBe(1);
    expect(resolveExplainConfig({ parallel: 9 }).parallel).toBe(4);
    expect(resolveExplainConfig(undefined)).toEqual({
      backend: 'codex', model: 'gpt-6.1-sol[high]', mode: 'workspace-write', language: 'English', parallel: 2,
    });
    expect(resolveExplainConfig({ model: '' }).model).toBe('');
  });
});

describe('jobSubject', () => {
  const places = { root: '/Users/me/src/Repo', scratch: '/var/folders/x/T/krypton-learn/repo-abc', home: '/Users/me' };

  it('makes scratch and repo paths relative and HOME `~`, keeping case', () => {
    expect(jobSubject('/var/folders/x/T/krypton-learn/repo-abc/explainer.md', places)).toBe('explainer.md');
    expect(jobSubject('/private/var/folders/x/T/krypton-learn/repo-abc/explainer.md', places)).toBe('explainer.md');
    expect(jobSubject('/Users/me/src/Repo/src/App.ts', places)).toBe('src/App.ts');
    expect(jobSubject("Read file '/Users/me/.agents/skills/X/SKILL.md'", places))
      .toBe("Read file '~/.agents/skills/X/SKILL.md'");
    expect(jobSubject('git -C /Users/me/src/Repo show HEAD', places)).toBe('git -C ~/src/Repo show HEAD');
  });

  it('keeps the first line and caps it at 200 characters', () => {
    expect(jobSubject("cat <<'EOF' > x\nsecond line", places)).toBe("cat <<'EOF' > x");
    const long = jobSubject(`echo ${'x'.repeat(300)}`, places);
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
