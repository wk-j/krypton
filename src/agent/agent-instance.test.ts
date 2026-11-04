// @vitest-environment happy-dom
import { Agent } from '@mariozechner/pi-agent-core';
import { EventStream, getModel, type AssistantMessage, type AssistantMessageEvent } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentController } from './agent';
import type { SessionEntry, SessionMessageEntry } from './session';
import { AssistantInstanceStore, assistantInstanceStore, type AssistantInventoryState, type EmbeddedInstanceRole } from '../assistant-instance-store';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../profiler/ipc', () => ({ invoke: invokeMock }));

interface AgentFactoryBoundary {
  buildAgent(apiKey: string | null, preset: unknown): Promise<Agent>;
}

function message(error?: string): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: error ?? 'Done' }],
    api: 'openai-completions', provider: 'openai', model: 'gpt-4o-mini',
    usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: error ? 'error' : 'stop', ...(error ? { errorMessage: error } : {}), timestamp: Date.now(),
  };
}

/** A real Pi Agent whose provider stream settles only when the test says so. */
function controlledAgent(modelId: 'gpt-4o-mini' | 'gpt-4o' = 'gpt-4o-mini') {
  let stream: EventStream<AssistantMessageEvent, AssistantMessage> | null = null;
  const agent = new Agent({
    initialState: { model: getModel('openai', modelId) },
    streamFn: () => {
      stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (event) => event.type === 'done' || event.type === 'error',
        (event) => {
          if (event.type === 'done') return event.message;
          if (event.type === 'error') return event.error;
          throw new Error('Expected a completed assistant message');
        },
      );
      return stream;
    },
  });
  return {
    agent,
    finish(error?: string) {
      if (!stream) throw new Error('Provider stream has not started');
      const result = message(error);
      if (error) stream.push({ type: 'error', reason: 'error', error: result });
      else stream.push({ type: 'done', reason: 'stop', message: result });
    },
  };
}

const subscriptions: Array<() => void> = [];
const controllers: AgentController[] = [];

function inventory(store = new AssistantInstanceStore({ listInstances: async () => [], getMetrics: async () => [] })) {
  let state: AssistantInventoryState = { instances: [], loading: false, error: null, refreshed_at_ms: null, sampled_at_ms: null };
  subscriptions.push(store.subscribeInventory((value) => { state = value; }));
  return { store, rows: () => state.instances };
}

function controllerFor(store: AssistantInstanceStore, role: EmbeddedInstanceRole = 'agent_view') {
  const controller = new AgentController({ role, label: role }, store);
  controllers.push(controller);
  controller.setInlineSystemPrompt('test');
  // Keep construction deterministic while exercising real Pi runs and subscriptions.
  const factory = vi.spyOn(controller as unknown as AgentFactoryBoundary, 'buildAgent');
  return { controller, factory };
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'get_config') return { agent: { active: 'first', models: [
      { name: 'first', provider: 'openai', model: 'configured-alias', base_url: '', api_key_env: '', context_window: 128000, max_tokens: 8192 },
      { name: 'second', provider: 'openai', model: 'other-alias', base_url: '', api_key_env: '', context_window: 128000, max_tokens: 8192 },
    ] } };
    if (command === 'session_create') return { session_id: 'test-session', file_path: '/test/session.jsonl' };
    if (command === 'session_load' || command === 'acp_list_instances' || command === 'acp_get_lane_metrics') return [];
    return null;
  });
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('embedded assistant identity and lifecycle', () => {
  it.each<EmbeddedInstanceRole>(['agent_view', 'file_manager_ai', 'markdown_ai'])('counts %s only after its Pi Agent exists and publishes actual model, cwd, activity and errors', async (role) => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store, role);
    controller.setProjectDir('/project');
    let resolveBuild!: (agent: Agent) => void;
    factory.mockReturnValue(new Promise<Agent>((resolve) => { resolveBuild = resolve; }));
    expect(view.rows()).toEqual([]);
    const events = vi.fn();
    const run = controller.prompt('hello', events);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.rows()).toEqual([]);
    const controlled = controlledAgent();
    resolveBuild(controlled.agent);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.rows()).toMatchObject([{
      owner: { role }, cwd: '/project', confirmed_model_id: 'openai/gpt-4o-mini',
      activity: 'running', lifecycle: 'ready', liveness: 'alive', pid: null, metrics: null, cpu_ready: false,
    }]);
    controller.setProjectDir('/changed');
    expect(view.rows()[0].cwd).toBe('/changed');
    controlled.finish('provider failed');
    await run;
    expect(view.rows()).toMatchObject([{ activity: 'idle', has_error: true }]);
    expect(events).toHaveBeenCalledWith({ type: 'error', message: 'Agent error: provider failed' });
    controller.dispose();
    expect(view.rows()).toEqual([]);
  });

  it('does not register initialization failures or duplicate concurrent preparation', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    factory.mockRejectedValue(new Error('cannot construct'));
    const events = vi.fn();
    const first = controller.prompt('first', events);
    await controller.prompt('second', events);
    await first;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(view.rows()).toEqual([]);
    expect(events).toHaveBeenCalledWith({ type: 'error', message: 'Failed to initialize agent: Error: cannot construct' });
  });

  it('keeps abort warm and reuses one identity across subsequent turns', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    const controlled = controlledAgent();
    factory.mockResolvedValue(controlled.agent);
    const first = controller.prompt('first', () => {});
    await vi.advanceTimersByTimeAsync(0);
    const id = view.rows()[0].id;
    controller.abort();
    expect(view.rows()).toMatchObject([{ id, lifecycle: 'ready' }]);
    controlled.finish();
    await first;
    expect(view.rows()).toMatchObject([{ id, activity: 'idle' }]);
    controller.setInlineSystemPrompt('test');
    const second = controller.prompt('second', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(view.rows()).toMatchObject([{ id, activity: 'running' }]);
    controlled.finish();
    await second;
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each(['reset', 'model'] as const)('retires an idle Agent on %s and waits for real initialization before its replacement appears', async (operation) => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    const oldAgent = controlledAgent();
    const nextAgent = controlledAgent('gpt-4o');
    factory.mockResolvedValueOnce(oldAgent.agent).mockResolvedValueOnce(nextAgent.agent);
    const first = controller.prompt('first', () => {});
    await vi.advanceTimersByTimeAsync(0);
    const oldId = view.rows()[0].id;
    oldAgent.finish();
    await first;
    if (operation === 'reset') await controller.reset();
    else expect(await controller.switchModel('second')).toEqual({ ok: true });
    expect(view.rows()).toEqual([]);
    controller.setInlineSystemPrompt('next');
    const next = controller.prompt('next', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(view.rows()).toHaveLength(1);
    expect(view.rows()[0].id).not.toBe(oldId);
    nextAgent.finish();
    await next;
  });

  it('keeps an existing identity when model resolution fails rather than destroying a warm Agent', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    const controlled = controlledAgent();
    factory.mockResolvedValue(controlled.agent);
    const run = controller.prompt('first', () => {});
    await vi.advanceTimersByTimeAsync(0);
    controlled.finish();
    await run;
    const id = view.rows()[0].id;
    expect(await controller.switchModel('missing')).toMatchObject({ ok: false });
    expect(view.rows()).toMatchObject([{ id, lifecycle: 'ready', confirmed_model_id: 'openai/gpt-4o-mini' }]);
  });

  it('retires a reset run only after settlement and isolates its late events and cleanup from the replacement', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    const oldAgent = controlledAgent();
    const replacement = controlledAgent('gpt-4o');
    factory.mockResolvedValueOnce(oldAgent.agent).mockResolvedValueOnce(replacement.agent);
    const oldEvents = vi.fn();
    const first = controller.prompt('old', oldEvents);
    await vi.advanceTimersByTimeAsync(0);
    const oldId = view.rows()[0].id;
    await controller.reset();
    expect(view.rows()).toMatchObject([{ id: oldId, lifecycle: 'terminating' }]);
    controller.setInlineSystemPrompt('replacement prompt');
    const second = controller.prompt('new', () => {});
    await vi.advanceTimersByTimeAsync(0);
    replacement.agent.state.systemPrompt = 'replacement-owned-prompt';
    const newId = view.rows()[1].id;
    expect(newId).not.toBe(oldId);
    expect(view.rows()[1]).toMatchObject({ activity: 'running', confirmed_model_id: 'openai/gpt-4o' });
    const oldEventCount = oldEvents.mock.calls.length;
    oldAgent.finish('late failure');
    await first;
    expect(oldEvents).toHaveBeenCalledTimes(oldEventCount);
    expect(controller.isRunning).toBe(true);
    expect(view.rows()).toMatchObject([{ id: newId, activity: 'running', has_error: false, confirmed_model_id: 'openai/gpt-4o' }]);
    expect(replacement.agent.state.systemPrompt).toBe('replacement-owned-prompt');
    replacement.finish();
    await second;
    expect(view.rows()).toMatchObject([{ id: newId, activity: 'idle' }]);
  });

  it('keeps a model-replaced run stopping and reports the next real Agent model under a new identity', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    const oldAgent = controlledAgent();
    const nextAgent = controlledAgent('gpt-4o');
    factory.mockResolvedValueOnce(oldAgent.agent).mockResolvedValueOnce(nextAgent.agent);
    const first = controller.prompt('first', () => {});
    await vi.advanceTimersByTimeAsync(0);
    const oldId = view.rows()[0].id;
    expect(await controller.switchModel('second')).toEqual({ ok: true });
    expect(view.rows()).toMatchObject([{ id: oldId, lifecycle: 'terminating', confirmed_model_id: 'openai/gpt-4o-mini' }]);
    controller.setInlineSystemPrompt('test');
    const second = controller.prompt('second', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(view.rows()).toHaveLength(2);
    expect(view.rows()[1]).toMatchObject({ confirmed_model_id: 'openai/gpt-4o', activity: 'running' });
    expect(view.rows()[1].id).not.toBe(oldId);
    oldAgent.finish();
    await first;
    nextAgent.finish();
    await second;
    expect(view.rows()).toHaveLength(1);
  });

  it('retains a disposed run until the real prompt settles, ignores repeated disposal and prevents reopening', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    const controlled = controlledAgent();
    factory.mockResolvedValue(controlled.agent);
    const events = vi.fn();
    const run = controller.prompt('first', events);
    await vi.advanceTimersByTimeAsync(0);
    const id = view.rows()[0].id;
    controller.dispose();
    controller.dispose();
    expect(view.rows()).toMatchObject([{ id, lifecycle: 'terminating' }]);
    await controller.prompt('cannot restart', events);
    controlled.finish();
    await run;
    expect(view.rows()).toEqual([]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(['agent_start']);
  });

  it('does not let a build that resolves after reset or disposal install an abandoned Agent', async () => {
    for (const retire of ['reset', 'dispose'] as const) {
      const view = inventory();
      const { controller, factory } = controllerFor(view.store);
      let resolveBuild!: (agent: Agent) => void;
      factory.mockReturnValue(new Promise<Agent>((resolve) => { resolveBuild = resolve; }));
      const events = vi.fn();
      const run = controller.prompt('first', events);
      await vi.advanceTimersByTimeAsync(0);
      await controller[retire]();
      resolveBuild(controlledAgent().agent);
      await run;
      expect(view.rows()).toEqual([]);
      expect(controller.getContext()).toBeNull();
      expect(events).not.toHaveBeenCalled();
    }
  });

  it('does not let a pre-reset build replace an already-running new identity', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    let resolveOldBuild!: (agent: Agent) => void;
    factory.mockReturnValueOnce(new Promise<Agent>((resolve) => { resolveOldBuild = resolve; }));
    const oldRun = controller.prompt('old', () => {});
    await vi.advanceTimersByTimeAsync(0);
    await controller.reset();
    const replacement = controlledAgent('gpt-4o');
    factory.mockResolvedValueOnce(replacement.agent);
    controller.setInlineSystemPrompt('replacement');
    const newRun = controller.prompt('new', () => {});
    await vi.advanceTimersByTimeAsync(0);
    const id = view.rows()[0].id;
    resolveOldBuild(controlledAgent().agent);
    await oldRun;
    expect(controller.isRunning).toBe(true);
    expect(controller.getContext()?.model).toBe(replacement.agent.state.model?.name);
    expect(view.rows()).toMatchObject([{ id, activity: 'running', confirmed_model_id: 'openai/gpt-4o' }]);
    replacement.finish();
    await newRun;
  });

  it.each([
    { operation: 'reset', content: 'late skill instructions' },
    { operation: 'reset', content: '' },
    { operation: 'model', content: 'late skill instructions' },
    { operation: 'model', content: '' },
  ])('isolates deferred skill loading after $operation, including empty content', async ({ operation, content }) => {
    const baseInvoke = invokeMock.getMockImplementation()!;
    let resolveSkill!: (content: string) => void;
    const skillLoad = new Promise<string>((resolve) => { resolveSkill = resolve; });
    let holdSkill = false;
    const skillPath = '/old/.claude/skills/held/SKILL.md';
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'run_command' && Array.isArray(args?.args) && args.args[1] === '/old/.claude/skills') {
        return Promise.resolve('held');
      }
      if (command === 'read_file' && args?.path === skillPath) {
        return holdSkill ? skillLoad : Promise.resolve('---\nname: held\ndescription: test skill\n---\nSkill instructions');
      }
      return baseInvoke(command, args);
    });
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    controller.setProjectDir('/old');
    controller.setInlineSystemPrompt(null);
    await controller.initSession();
    expect(controller.setForcedSkill('held')).toBe(true);
    holdSkill = true;
    const oldAgent = controlledAgent();
    const replacement = controlledAgent('gpt-4o');
    factory.mockResolvedValueOnce(oldAgent.agent).mockResolvedValueOnce(replacement.agent);
    const oldEvents = vi.fn();
    const oldRun = controller.prompt('old', oldEvents);
    await vi.advanceTimersByTimeAsync(0);
    const oldId = view.rows()[0].id;
    if (operation === 'reset') await controller.reset();
    else expect(await controller.switchModel('second')).toEqual({ ok: true });
    expect(view.rows()).toMatchObject([{ id: oldId, lifecycle: 'terminating' }]);
    controller.setProjectDir('/new');
    controller.setInlineSystemPrompt('replacement');
    const newRun = controller.prompt('new', () => {});
    await vi.advanceTimersByTimeAsync(0);
    replacement.agent.state.systemPrompt = 'replacement-owned-prompt';
    const newId = view.rows()[1].id;
    resolveSkill(content);
    await oldRun;
    expect(oldEvents).not.toHaveBeenCalled();
    expect(replacement.agent.state.systemPrompt).toBe('replacement-owned-prompt');
    expect(controller.getLastActiveSkills()).toEqual([]);
    expect(controller.isRunning).toBe(true);
    expect(view.rows()).toMatchObject([{ id: newId, activity: 'running', confirmed_model_id: 'openai/gpt-4o' }]);
    replacement.finish();
    await newRun;
  });

  it.each(['restore', 'persist'] as const)('keeps the replacement session chain isolated from delayed old %s completion', async (operation) => {
    const baseInvoke = invokeMock.getMockImplementation()!;
    let resolveRestore!: (entries: SessionEntry[]) => void;
    let resolveAppend!: () => void;
    const restore = new Promise<SessionEntry[]>((resolve) => { resolveRestore = resolve; });
    const append = new Promise<void>((resolve) => { resolveAppend = resolve; });
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'session_load' && operation === 'restore') return restore;
      if (command === 'session_append' && operation === 'persist') {
        // These are entries generated by the controller under test, not external input.
        const entry = args?.entry as SessionMessageEntry;
        if (entry.message.content === 'old') return append;
      }
      return baseInvoke(command, args);
    });
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    controller.setProjectDir('/old');
    await controller.initSession();
    if (operation === 'restore') controller.setInlineSystemPrompt(null);
    const oldAgent = controlledAgent();
    const replacement = controlledAgent('gpt-4o');
    factory.mockResolvedValueOnce(oldAgent.agent).mockResolvedValueOnce(replacement.agent);
    const oldEvents = vi.fn();
    const oldRun = controller.prompt('old', oldEvents);
    await vi.advanceTimersByTimeAsync(0);
    await controller.reset();
    controller.setInlineSystemPrompt('replacement');
    const newRun = controller.prompt('new', () => {});
    await vi.advanceTimersByTimeAsync(0);
    const newId = view.rows()[1].id;
    // Read only records generated by this test's real session persistence path.
    const entriesBefore = invokeMock.mock.calls
      .filter(([command]) => command === 'session_append')
      .map(([, args]) => args.entry as SessionMessageEntry);
    const newUserEntry = entriesBefore.find((entry) => entry.message.content === 'new')!;
    if (operation === 'restore') {
      resolveRestore([{ type: 'message', id: 'retired-session-entry', parentId: null, message: { role: 'assistant', content: 'old history' } }]);
    } else {
      resolveAppend();
    }
    await oldRun;
    expect(oldEvents).not.toHaveBeenCalled();
    expect(controller.isRunning).toBe(true);
    expect(view.rows()).toMatchObject([{ id: newId, activity: 'running' }]);
    replacement.finish();
    await newRun;
    await vi.advanceTimersByTimeAsync(0);
    const entriesAfter = invokeMock.mock.calls
      .filter(([command]) => command === 'session_append')
      .map(([, args]) => args.entry as SessionMessageEntry);
    const assistantEntry = entriesAfter.find((entry) => entry.message.role === 'assistant')!;
    expect(assistantEntry.parentId).toBe(newUserEntry.id);
  });

  it('does not retire on agent_end until awaited Pi listeners have settled', async () => {
    const view = inventory();
    const { controller, factory } = controllerFor(view.store);
    const controlled = controlledAgent();
    let releaseEnd!: () => void;
    const settling = new Promise<void>((resolve) => { releaseEnd = resolve; });
    controlled.agent.subscribe((event) => event.type === 'agent_end' ? settling : undefined);
    factory.mockResolvedValue(controlled.agent);
    const run = controller.prompt('first', () => {});
    await vi.advanceTimersByTimeAsync(0);
    controlled.finish();
    await vi.advanceTimersByTimeAsync(0);
    controller.dispose();
    expect(view.rows()).toMatchObject([{ lifecycle: 'terminating' }]);
    releaseEnd();
    await run;
    expect(view.rows()).toEqual([]);
  });
});

describe('embedded owner disposal and ContextView boundary', () => {
  it('uses all three owning surfaces without registering wrappers or counting a ContextView twice', async () => {
    const [{ AgentView }, { ContextView }, { FileManagerAI }, { MarkdownViewAI }] = await Promise.all([
      import('./agent-view'), import('./context-view'), import('../file-manager-ai'), import('../markdown-view-ai'),
    ]);
    const view = inventory(assistantInstanceStore);
    const factory = vi.spyOn(AgentController.prototype as unknown as AgentFactoryBoundary, 'buildAgent');
    const agents = [controlledAgent(), controlledAgent(), controlledAgent()];
    for (const controlled of agents) factory.mockResolvedValueOnce(controlled.agent);
    const agentView = new AgentView();
    const fileParent = document.createElement('div');
    const markdownParent = document.createElement('div');
    const files = new FileManagerAI({ cwd: '/files', getContext: () => ({ cwd: '/files', cursorFile: null, markedFiles: [], totalEntries: 0 }), onDone: () => {}, onClose: () => {} });
    const markdown = new MarkdownViewAI({ cwd: '/docs', getContext: () => ({ cwd: '/docs', currentFile: null, selectedText: null }), onClose: () => {} });
    files.open(fileParent);
    markdown.open(markdownParent);
    expect(view.rows()).toEqual([]);
    const agentController = agentView.getController();
    agentController.setInlineSystemPrompt('test');
    const run = agentController.prompt('hello', () => {});
    fileParent.querySelector('input')!.value = 'hello';
    markdownParent.querySelector('input')!.value = 'hello';
    files.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
    markdown.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.rows().map((row) => row.owner.role).sort()).toEqual(['agent_view', 'file_manager_ai', 'markdown_ai']);
    const context = new ContextView(agentController);
    expect(view.rows()).toHaveLength(3);
    context.dispose();
    expect(view.rows()).toHaveLength(3);
    agentView.dispose();
    files.close();
    markdown.close();
    expect(view.rows().every((row) => row.lifecycle === 'terminating')).toBe(true);
    for (const controlled of agents) controlled.finish();
    await run;
    await vi.advanceTimersByTimeAsync(0);
    expect(view.rows()).toEqual([]);
  });
});
