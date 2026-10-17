import { describe, expect, it, vi } from 'vitest';

import { AssistEngine } from './assist/engine';
import type { AssistAction, AssistContext, AssistTaskConfig, RegisteredAssistTask } from './assist/types';
import { HarnessAssistController } from './harness-assist-controller';
import type { HarnessAssistHost } from './harness-view-host';
import type { HarnessLane, HarnessTranscriptItem } from './harness-view-types';

vi.mock('../config', () => ({ loadConfig: async (): Promise<unknown> => ({}) }));

const ASSISTANT_TEXT = 'patched the controller and the two tests are green now';

function item(kind: HarnessTranscriptItem['kind'], text: string): HarnessTranscriptItem {
  return { id: `${kind}-${text.length}`, kind, text } as unknown as HarnessTranscriptItem;
}

function makeLane(over: Partial<HarnessLane> = {}): HarnessLane {
  return {
    id: 'lane-1',
    displayName: 'OMP-1',
    backendId: 'omp',
    modelName: 'claude-opus-5',
    currentModelId: null,
    accent: '#8effb0',
    draft: '',
    cursor: 0,
    turnSeq: 7,
    spawnEpoch: 1,
    plan: null,
    queuedPrompts: [],
    pendingPermissions: [],
    pendingQuestions: [],
    activeSystemLabel: null,
    transcript: [item('user', 'fix the breaker'), item('assistant', ASSISTANT_TEXT)],
    ...over,
  } as unknown as HarnessLane;
}

interface Harness {
  readonly ctl: HarnessAssistController;
  readonly chips: string[];
  readonly drafts: { text: string; cursor: number }[];
  readonly regions: string[];
  readonly calls: { system: string; user: string }[];
  readonly lane: HarnessLane;
  flush(): Promise<void>;
}

function setup(options: {
  lane?: HarnessLane;
  reply?: string;
  fail?: Error;
  eligible?: (ctx: AssistContext, cfg: AssistTaskConfig) => boolean;
} = {}): Harness {
  const lane = options.lane ?? makeLane();
  const chips: string[] = [];
  const drafts: { text: string; cursor: number }[] = [];
  const regions: string[] = [];
  const calls: { system: string; user: string }[] = [];

  const host: HarnessAssistHost = {
    element: {} as HTMLElement,
    lanes: [lane],
    activeLaneId: lane.id,
    projectDir: '/repo',
    remoteRuntimeId: null,
    flashChip: (text) => chips.push(text),
    invalidate: (region) => regions.push(region),
    setDraft: (_lane, text, cursor) => drafts.push({ text, cursor }),
  };

  const task: RegisteredAssistTask = {
    id: 'fake',
    summary: 'fake task',
    surface: 'strip',
    onTurnEnd: true,
    defaults: { mode: 'auto', options: {} },
    eligible: options.eligible,
    system: () => 'SYSTEM',
    payload: (ctx) => ctx.turn.map((row) => `${row.kind}:${row.text}`).join('\n'),
    parse: (raw): readonly AssistAction[] | null => {
      const parsed = JSON.parse(raw) as { suggestions?: AssistAction[] };
      return parsed.suggestions?.length ? parsed.suggestions : null;
    },
  };

  const engine = new AssistEngine(async (call) => {
    calls.push({ system: call.system, user: call.user });
    if (options.fail) throw options.fail;
    return options.reply ?? '{"suggestions":[{"label":"run tests","prompt":"Run the full suite and fix what fails."}]}';
  });

  const ctl = new HarnessAssistController(host, [task], engine);
  ctl.setMode(null, 'auto');
  return {
    ctl,
    chips,
    drafts,
    regions,
    calls,
    lane,
    flush: () => ctl.whenIdle(),
  };
}

describe('HarnessAssistController — trigger gates', () => {
  it('runs on a clean end_turn and publishes the suggestions', async () => {
    const h = setup();
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].user).toContain(ASSISTANT_TEXT);
    expect(h.ctl.stripProps(h.lane).state).toEqual({
      kind: 'ready',
      taskId: 'fake',
      actions: [{ label: 'run tests', prompt: 'Run the full suite and fix what fails.' }],
    });
    expect(h.regions).toContain('composer');
    expect(h.drafts).toHaveLength(0);
  });

  it.each(['cancelled', 'refusal', 'max_tokens'] as const)('skips stopReason %s', async (stopReason) => {
    const h = setup();
    h.ctl.onTurnEnd(h.lane, stopReason);
    await h.flush();
    expect(h.calls).toHaveLength(0);
  });

  it('runs once per lane turn', async () => {
    const h = setup();
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    expect(h.calls).toHaveLength(1);

    h.lane.turnSeq += 1;
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    expect(h.calls).toHaveLength(2);
  });

  it('skips a turn that is still waiting on the human', async () => {
    const h = setup({
      lane: makeLane({ pendingPermissions: [{}] as unknown as HarnessLane['pendingPermissions'] }),
    });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    expect(h.calls).toHaveLength(0);
  });

  it('skips a system-originated turn', async () => {
    const h = setup({ lane: makeLane({ activeSystemLabel: 'peer review' }) });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    expect(h.calls).toHaveLength(0);
  });

  it('skips a turn with almost no assistant text', async () => {
    const h = setup({ lane: makeLane({ transcript: [item('user', 'hi'), item('assistant', 'ok')] }) });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    expect(h.calls).toHaveLength(0);
  });

  it("honours the task's own gate", async () => {
    const h = setup({ eligible: (ctx) => ctx.queuedPrompts === 0, lane: makeLane({
      queuedPrompts: [{}] as unknown as HarnessLane['queuedPrompts'],
    }) });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    expect(h.calls).toHaveLength(0);
  });

  it('reports a failure once and keeps the strip empty', async () => {
    const h = setup({ fail: new Error('boom') });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    expect(h.ctl.stripProps(h.lane).state).toEqual({ kind: 'failed', taskId: 'fake', reason: 'unavailable' });
    expect(h.chips).toEqual(['assist: model unavailable']);
  });
});

describe('HarnessAssistController — accept, dismiss, manual', () => {
  async function ready(over: Partial<HarnessLane> = {}): Promise<Harness> {
    const h = setup({ lane: makeLane(over) });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.flush();
    return h;
  }

  it('loads the chosen suggestion into the draft and clears the strip', async () => {
    const h = await ready();
    expect(h.ctl.accept(h.lane, 0)).toBe(true);
    const prompt = 'Run the full suite and fix what fails.';
    expect(h.drafts).toEqual([{ text: prompt, cursor: prompt.length }]);
    expect(h.ctl.stripProps(h.lane).state).toEqual({ kind: 'idle' });
  });

  it('refuses to clobber a draft the human already typed', async () => {
    const h = await ready({ draft: 'half a thought' });
    expect(h.ctl.accept(h.lane, 0)).toBe(true);
    expect(h.drafts).toHaveLength(0);
    expect(h.chips).toEqual(['assist: clear the draft first']);
    expect(h.ctl.stripProps(h.lane).state).toMatchObject({ kind: 'ready' });
  });

  it('does not consume the key when there is no suggestion at that index', async () => {
    const h = await ready();
    expect(h.ctl.accept(h.lane, 2)).toBe(false);
  });

  it('dismiss hides the strip, and only when something is showing', async () => {
    const h = await ready();
    expect(h.ctl.dismiss(h.lane)).toBe(true);
    expect(h.ctl.stripProps(h.lane).state).toEqual({ kind: 'idle' });
    expect(h.ctl.dismiss(h.lane)).toBe(false);
  });

  it('manual request re-asks on the same turn, and refuses when the task is off', async () => {
    const h = await ready();
    h.ctl.request(h.lane);
    await h.flush();
    expect(h.calls).toHaveLength(2);

    h.ctl.setMode(null, 'off');
    h.ctl.request(h.lane);
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(h.chips).toEqual(['assist: fake is off — #assist fake manual']);
  });

  it('drops an answer that arrives after the lane changed', async () => {
    const h = setup();
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    h.ctl.cancel();
    await h.flush();
    expect(h.ctl.stripProps(h.lane).state).toEqual({ kind: 'idle' });
  });
});
