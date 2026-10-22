import { describe, expect, it, vi } from 'vitest';

import { AssistEngine } from './assist/engine';
import { followUp } from './assist/tasks/follow-up';
import type { AssistAction, AssistContext, AssistTaskConfig, RegisteredAssistTask } from './assist/types';
import { ASSIST_PANEL_OK_HIDE_MS, HarnessAssistController } from './harness-assist-controller';
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
    patchFollowUps: () => undefined,
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

describe('HarnessAssistController — user-prompt trigger (grammar)', () => {
  async function grammarRun(reply: string, prompt: string, lane = makeLane({ transcript: [item('user', prompt)] })) {
    const { grammar } = await import('./assist/tasks/grammar');
    const chips: string[] = [];
    const calls: string[] = [];
    const drafts: string[] = [];
    const regions: string[] = [];
    const host: HarnessAssistHost = {
      element: {} as HTMLElement,
      lanes: [lane],
      activeLaneId: lane.id,
      projectDir: '/repo',
      remoteRuntimeId: null,
      flashChip: (text) => chips.push(text),
      invalidate: (region) => regions.push(region),
      setDraft: (_lane, text) => drafts.push(text),
      patchFollowUps: () => undefined,
    };
    const engine = new AssistEngine(async (call) => {
      calls.push(call.user);
      return reply;
    });
    const ctl = new HarnessAssistController(host, [grammar], engine);
    return { ctl, lane, chips, calls, drafts, regions };
  }

  it('checks the sent prompt with no assistant reply yet, and only in auto', async () => {
    const h = await grammarRun(
      '{"ok":false,"corrected":"What are the current changes?","fixes":["curent → current"]}',
      'What curent changes in git?',
    );
    h.ctl.onUserPrompt(h.lane);
    await h.ctl.whenIdle();
    expect(h.calls).toHaveLength(0);

    h.ctl.setMode('grammar', 'auto');
    h.ctl.onUserPrompt(h.lane);
    await h.ctl.whenIdle();
    expect(h.calls).toEqual(['What curent changes in git?']);
    expect(h.ctl.stripProps(h.lane).state.kind).toBe('idle');
    const state = h.ctl.panelState(h.lane.id);
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.original).toBe('What curent changes in git?');
      expect(state.check).toEqual({ corrected: 'What are the current changes?', fixes: ['curent → current'] });
    }
    expect(h.regions).toContain('rightRail');
  });

  it('Cmd+G loads the correction into an empty draft and closes the panel', async () => {
    const h = await grammarRun(
      '{"ok":false,"corrected":"What are the current changes?","fixes":["curent → current"]}',
      'What curent changes in git?',
    );
    h.ctl.setMode('grammar', 'auto');
    h.ctl.onUserPrompt(h.lane);
    await h.ctl.whenIdle();
    expect(h.ctl.acceptCorrection(h.lane)).toBe(true);
    expect(h.drafts).toEqual(['What are the current changes?']);
    expect(h.ctl.panelState(h.lane.id).kind).toBe('idle');
    expect(h.ctl.acceptCorrection(h.lane)).toBe(false);
  });

  it('confirms a clean prompt in the panel, then hides it', async () => {
    vi.useFakeTimers();
    try {
      const h = await grammarRun('{"ok":true}', 'Please run the full test suite.');
      h.ctl.setMode('grammar', 'auto');
      h.ctl.onUserPrompt(h.lane);
      await h.ctl.whenIdle();
      const state = h.ctl.panelState(h.lane.id);
      expect(state.kind === 'ready' && state.check.corrected).toBeNull();
      expect(h.chips).toEqual([]);
      vi.advanceTimersByTime(ASSIST_PANEL_OK_HIDE_MS);
      expect(h.ctl.panelState(h.lane.id).kind).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Cmd+0 closes the panel', async () => {
    const h = await grammarRun('{"ok":false,"corrected":"Fix it now.","fixes":["fix → Fix"]}', 'fix it now please');
    h.ctl.setMode('grammar', 'auto');
    h.ctl.onUserPrompt(h.lane);
    await h.ctl.whenIdle();
    expect(h.ctl.dismissPanel(h.lane)).toBe(true);
    expect(h.ctl.panelState(h.lane.id).kind).toBe('idle');
    expect(h.ctl.dismissPanel(h.lane)).toBe(false);
  });

  it('skips non-English prompts without a model call', async () => {
    const h = await grammarRun('{"ok":true}', 'ช่วยดูการเปลี่ยนแปลงใน git หน่อย');
    h.ctl.setMode('grammar', 'auto');
    h.ctl.onUserPrompt(h.lane);
    await h.ctl.whenIdle();
    expect(h.calls).toHaveLength(0);
  });
});

describe('HarnessAssistController — transcript surface (follow-up)', () => {
  const REPLY = 'Done. Run `make install`, then open http://localhost:5173/docs to check the page.';

  async function followUpRun(reply: string, options: { remote?: boolean; owner?: HarnessTranscriptItem } = {}) {
    const owner = options.owner ?? { id: 'a-1', kind: 'assistant', text: REPLY } as HarnessTranscriptItem;
    const lane = makeLane({ transcript: [item('user', 'wire the rail'), owner] });
    const chips: string[] = [];
    const calls: string[] = [];
    const patched: string[] = [];
    const host: HarnessAssistHost = {
      element: {} as HTMLElement,
      lanes: [lane],
      activeLaneId: lane.id,
      projectDir: '/repo',
      remoteRuntimeId: options.remote ? 'remote-1' : null,
      flashChip: (text) => chips.push(text),
      invalidate: () => undefined,
      setDraft: () => undefined,
      patchFollowUps: (_lane, itemId) => patched.push(itemId),
    };
    const engine = new AssistEngine(async (call) => {
      calls.push(call.user);
      return reply;
    });
    const ctl = new HarnessAssistController(host, [followUp], engine);
    ctl.setMode('follow-up', 'auto');
    return { ctl, lane, owner, chips, calls, patched };
  }

  it('writes the picked actions onto the reply that named them, even after the next prompt', async () => {
    const h = await followUpRun('{"actions":[{"id":1,"label":"install the app"},{"id":2,"label":"open the docs"}]}');
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    // The human sends the next prompt before the sidecar answers.
    const next = item('user', 'now update the docs');
    h.lane.transcript.push(next);
    await h.ctl.whenIdle();

    expect(h.owner.followUps?.map((a) => [a.followUpKind, a.target])).toEqual([
      ['run', 'make install'],
      ['open', 'http://localhost:5173/docs'],
    ]);
    expect(next.followUps).toBeUndefined();
    expect(h.patched).toEqual(['a-1']);
    expect(h.ctl.stripProps(h.lane).state.kind).toBe('idle');
  });

  it('makes no call on a remote harness', async () => {
    const h = await followUpRun('{"actions":[{"id":1,"label":"install the app"}]}', { remote: true });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.ctl.whenIdle();
    expect(h.calls).toHaveLength(0);
    expect(h.owner.followUps).toBeUndefined();
  });

  it('makes no call when the reply names nothing to run or open', async () => {
    const owner = { id: 'a-2', kind: 'assistant', text: 'All done — the controller and its tests are finished.' } as HarnessTranscriptItem;
    const h = await followUpRun('{"actions":[]}', { owner });
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    await h.ctl.whenIdle();
    expect(h.calls).toHaveLength(0);
    expect(h.patched).toEqual([]);
  });

  it('an empty answer to a re-ask clears that reply’s follow-ups', async () => {
    const h = await followUpRun('{"actions":[]}');
    h.owner.followUps = [{ followUpKind: 'run', label: 'install', target: 'make install', hintLabel: null }];
    h.ctl.request(h.lane, 'follow-up');
    await h.ctl.whenIdle();
    expect(h.owner.followUps).toBeUndefined();
    expect(h.patched).toEqual(['a-1']);
    expect(h.chips).toEqual([]);
  });

  it('drops the answer when the reply left the transcript', async () => {
    const h = await followUpRun('{"actions":[{"id":1,"label":"install the app"}]}');
    h.ctl.onTurnEnd(h.lane, 'end_turn');
    h.lane.transcript.length = 0;
    await h.ctl.whenIdle();
    expect(h.owner.followUps).toBeUndefined();
    expect(h.patched).toEqual([]);
  });
});
