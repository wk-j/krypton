// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { AssistCompletion } from './assist/engine';
import { commitMessageCall } from './git-commit-message';
import {
  HarnessGitController,
  type GitPanelApi,
  type GitPanelStatusPayload,
} from './harness-git-controller';

const HASH = 'a'.repeat(40);

const STATUS: GitPanelStatusPayload = {
  repoRoot: '/repo',
  status: [
    `# branch.oid ${HASH}`,
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    `1 M. N... 100644 100644 100644 ${HASH} ${HASH} src/a.ts`,
    `1 .M N... 100644 100644 100644 ${HASH} ${HASH} src/b.ts`,
    `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} src/c.ts`,
    '? new.txt',
    '',
  ].join('\0'),
  stagedNumstat: '1\t0\tsrc/a.ts\0',
  unstagedNumstat: '1\t0\tsrc/b.ts\0',
};

const originalScroll = Element.prototype.scrollIntoView;
const live: HarnessGitController[] = [];

function setup(options?: {
  remote?: boolean;
  projectDir?: string | null;
  complete?: AssistCompletion;
  config?: unknown;
}) {
  let shown = false;
  let hidden = true;
  let remote = options?.remote ?? false;
  let projectDir = options?.projectDir === undefined ? '/repo' : options.projectDir;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => 'visible');
  Element.prototype.scrollIntoView = vi.fn();
  const status = vi.fn(async () => STATUS);
  const stage = vi.fn(async () => {});
  const unstage = vi.fn(async () => {});
  const discard = vi.fn(async () => {});
  const commit = vi.fn(async () => ({ sha: 'abc1234' }));
  const commitContext = vi.fn(async () => ({ repoRoot: '/repo', diff: '+staged change', fingerprint: 'index-a' }));
  const complete = vi.fn<AssistCompletion>(options?.complete ?? (async () => 'Describe staged change'));
  const loadConfig = vi.fn(async () => options?.config ?? {});
  const api: GitPanelApi = { status, stage, unstage, discard, commit, commitContext };
  const invalidate = vi.fn();
  const focusComposer = vi.fn();
  const flash = vi.fn();
  const setBadge = vi.fn();
  const openDiff = vi.fn(async () => true);
  const controller = new HarnessGitController({
    projectDir: () => projectDir,
    assistOwner: () => ({ role: 'assist', label: 'Git commit message', harness_id: 'harness', lane_id: null }),
    remote: () => remote,
    isPanelHidden: () => hidden,
    setDockTabAvailable: () => {},
    dockTabShown: () => shown,
    invalidate,
    focusComposer,
    flash,
    setBadge,
    openDiff,
  }, api, { complete, loadConfig });
  document.body.append(controller.dockEl);
  live.push(controller);
  return {
    controller, status, stage, unstage, discard, commit, invalidate, focusComposer, flash, openDiff,
    commitContext, complete, loadConfig,
    show(): void {
      hidden = false;
      shown = true;
      controller.renderDock();
    },
    hide(): void {
      shown = false;
      controller.renderDock();
    },
    setRemote(value: boolean): void {
      remote = value;
    },
    setProjectDir(value: string | null): void {
      projectDir = value;
    },
  };
}

function press(controller: HarnessGitController, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  controller.dockEl.dispatchEvent(event);
  controller.handleDockKey(event);
  return event;
}

function selectedName(controller: HarnessGitController): string | null {
  return controller.dockEl.querySelector('[aria-selected="true"] .acp-git-dock__name')?.textContent ?? null;
}

async function shownStatus(harness: ReturnType<typeof setup>): Promise<void> {
  harness.show();
  await vi.waitFor(() => {
    expect(harness.controller.dockEl.textContent).toContain('src/c.ts');
  });
}

beforeEach(() => { vi.useFakeTimers(); });

afterEach(() => {
  for (const controller of live.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = originalScroll;
  vi.useRealTimers();
});

describe('HarnessGitController', () => {
  it('selects the conflict first, then moves and stages the staged row', async () => {
    const harness = setup();
    await shownStatus(harness);
    expect(selectedName(harness.controller)).toBe('c.ts');
    press(harness.controller, 's');
    expect(harness.flash).toHaveBeenCalledWith('Resolve the conflict before staging.');
    expect(harness.stage).not.toHaveBeenCalled();

    press(harness.controller, 'j');
    expect(selectedName(harness.controller)).toBe('a.ts');
    press(harness.controller, 's');
    await vi.waitFor(() => expect(harness.stage).toHaveBeenCalledWith('/repo', ['src/a.ts']));

    press(harness.controller, 'k');
    expect(selectedName(harness.controller)).toBe('c.ts');
    harness.controller.dispose();
  });

  it('discards an unstaged row only after y, and refuses a staged discard', async () => {
    const harness = setup();
    await shownStatus(harness);
    press(harness.controller, 'j');
    press(harness.controller, 'x');
    expect(harness.flash).toHaveBeenCalledWith('Press u to unstage. The worktree copy stays.');
    expect(harness.discard).not.toHaveBeenCalled();

    press(harness.controller, 'j');
    expect(selectedName(harness.controller)).toBe('b.ts');
    press(harness.controller, 'x');
    expect(harness.controller.dockEl.textContent).toContain('Discard unstaged changes in src/b.ts?');
    press(harness.controller, 'y');
    await vi.waitFor(() => {
      expect(harness.discard).toHaveBeenCalledWith('/repo', 'src/b.ts', 'unstaged');
    });
    harness.controller.dispose();
  });

  it('rejects an empty commit message from the field and lets a letter reach it', async () => {
    const harness = setup();
    await shownStatus(harness);
    const field = harness.controller.dockEl.querySelector('textarea');
    expect(field).toBeInstanceOf(HTMLTextAreaElement);
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.focus();
    const commitKey = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(commitKey);
    expect(harness.controller.handleDockKey(commitKey)).toBe(true);
    expect(harness.commit).not.toHaveBeenCalled();
    expect(harness.controller.dockEl.textContent).toContain('commit message is empty');
    expect(harness.controller.dockEl.textContent).toContain('FAILED');

    const letter = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    field.dispatchEvent(letter);
    expect(harness.controller.passesToField(letter)).toBe(true);
    harness.controller.dispose();
  });

  it('returns focus to the composer on Escape from the list', async () => {
    const harness = setup();
    await shownStatus(harness);
    harness.controller.focus();
    press(harness.controller, 'Escape');
    expect(harness.focusComposer).toHaveBeenCalledTimes(1);
    harness.controller.dispose();
  });

  it('does not query git for a remote harness', () => {
    const harness = setup({ remote: true });
    harness.show();
    expect(harness.status).not.toHaveBeenCalled();
    expect(harness.controller.dockEl.textContent).toContain('Git is local only');
    harness.controller.dispose();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  // The project's ES2021 lib has no Promise.withResolvers.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface GitPanelHarness {
  readonly controller: HarnessGitController;
  readonly status: Pick<Mock<() => Promise<GitPanelStatusPayload>>, 'mockResolvedValue'>;
  show(): void;
}

async function aiReady(harness: GitPanelHarness): Promise<HTMLTextAreaElement> {
  harness.status.mockResolvedValue({
    ...STATUS,
    status: STATUS.status.split('\0').filter((entry) => !entry.startsWith('u ')).join('\0'),
  });
  harness.show();
  await vi.waitFor(() => {
    expect(harness.controller.dockEl.querySelector<HTMLButtonElement>('[data-git-ai]')?.disabled).toBe(false);
  });
  return harness.controller.dockEl.querySelector('textarea') as HTMLTextAreaElement;
}

function typeDraft(field: HTMLTextAreaElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Git AI commit draft (spec 405)', () => {
  it('fills the same editor through the AI button without staging or committing', async () => {
    const t = setup();
    const field = await aiReady(t);
    typeDraft(field, 'My starting draft');
    t.controller.focus();
    t.controller.dockEl.querySelector<HTMLButtonElement>('[data-git-ai]')?.click();
    await vi.waitFor(() => expect(field.value).toBe('Describe staged change'));
    expect(t.controller.dockEl.querySelector('textarea')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(t.commitContext).toHaveBeenCalledTimes(2);
    expect(JSON.parse(t.complete.mock.calls[0][0].user)).toEqual({
      stagedPatch: '+staged change', currentDraft: 'My starting draft',
    });
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.commit).not.toHaveBeenCalled();
  });

  it('uses configured AI target even when automatic assist is off', async () => {
    const t = setup({ config: { acp_harness: { assist: {
      mode: 'off', backend: 'omp', model: 'global',
      tasks: { 'commit-message': { model: 'commit-model', timeout_ms: 1000 } },
    } } } });
    const field = await aiReady(t);
    press(t.controller, 'g');
    await vi.waitFor(() => expect(field.value).toBe('Describe staged change'));
    expect(t.complete.mock.calls[0][0]).toMatchObject({ backendId: 'omp', modelId: 'commit-model' });
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])('handles the field AI chord with %o without swallowing typed g, Enter or IME', async (modifier) => {
    const t = setup();
    const field = await aiReady(t);
    field.focus();
    for (const init of [
      { key: 'g' }, { key: 'Enter' }, { key: 'G', shiftKey: true, ...modifier, isComposing: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      expect(t.controller.passesToField(event)).toBe(true);
      expect(t.controller.handleDockKey(event)).toBe(false);
    }
    const chord = new KeyboardEvent('keydown', { key: 'G', shiftKey: true, ...modifier, bubbles: true, cancelable: true });
    field.dispatchEvent(chord);
    expect(t.controller.passesToField(chord)).toBe(false);
    expect(t.controller.handleDockKey(chord)).toBe(true);
    expect(chord.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(field.value).toBe('Describe staged change'));
  });

  it('cancels on a second AI action and rejects the late completion', async () => {
    const pending = deferred<string>();
    const t = setup({ complete: async () => pending.promise });
    const field = await aiReady(t);
    typeDraft(field, 'Keep this');
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.complete).toHaveBeenCalledOnce());
    const signal = t.complete.mock.calls[0][0].signal;
    expect(t.controller.dockEl.querySelector('[data-git-ai]')?.textContent).toBe('CANCEL AI');
    press(t.controller, 'g');
    expect(signal.aborted).toBe(true);
    pending.resolve('Late overwrite');
    await vi.advanceTimersByTimeAsync(0);
    expect(field.value).toBe('Keep this');
    expect(t.commitContext).toHaveBeenCalledTimes(1);
    expect(t.controller.dockEl.querySelector('[data-git-ai]')?.textContent).toBe('AI DRAFT');
  });

  it('protects a draft edited and restored while the AI is running', async () => {
    const pending = deferred<string>();
    const t = setup({ complete: async () => pending.promise });
    const field = await aiReady(t);
    typeDraft(field, 'Original');
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.complete).toHaveBeenCalledOnce());
    typeDraft(field, 'Changed');
    typeDraft(field, 'Original');
    pending.resolve('Wrong replacement');
    await vi.advanceTimersByTimeAsync(0);
    expect(field.value).toBe('Original');
    expect(t.complete.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it.each(['project', 'hide', 'dispose'] as const)('drops output after %s', async (change) => {
    const pending = deferred<string>();
    const t = setup({ complete: async () => pending.promise });
    const field = await aiReady(t);
    typeDraft(field, 'Keep me');
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.complete).toHaveBeenCalledOnce());
    if (change === 'project') {
      t.setProjectDir('/other');
      t.controller.renderDock();
    } else if (change === 'hide') t.hide();
    else t.controller.dispose();
    pending.resolve('Stale result');
    await vi.advanceTimersByTimeAsync(0);
    expect(field.value).toBe('Keep me');
    expect(t.complete.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('keeps the draft when the index changes before AI completion', async () => {
    const t = setup();
    const field = await aiReady(t);
    typeDraft(field, 'Keep this');
    t.commitContext.mockResolvedValueOnce({ repoRoot: '/repo', diff: '+old', fingerprint: 'old' });
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.flash).toHaveBeenCalledWith('Staged changes changed. Generate a new commit message.'));
    expect(field.value).toBe('Keep this');
  });

  it('blocks mutations while generating and never steals focus from outside the dock', async () => {
    const pending = deferred<string>();
    const t = setup({ complete: async () => pending.promise });
    const field = await aiReady(t);
    typeDraft(field, 'Existing draft');
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.complete).toHaveBeenCalledOnce());
    for (const key of ['s', 'u', 'S', 'U']) press(t.controller, key);
    const commitKey = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true });
    field.dispatchEvent(commitKey);
    t.controller.handleDockKey(commitKey);
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.unstage).not.toHaveBeenCalled();
    expect(t.commit).not.toHaveBeenCalled();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    pending.resolve('Safe result');
    await vi.waitFor(() => expect(field.value).toBe('Safe result'));
    expect(document.activeElement).toBe(outside);
  });

  it.each(['conflict', 'empty'] as const)('makes no AI call for %s index state', async (kind) => {
    const t = setup();
    if (kind === 'conflict') await shownStatus(t);
    else {
      t.status.mockResolvedValue({ ...STATUS, status: `# branch.oid ${HASH}\0# branch.head main\0` });
      t.show();
      await vi.waitFor(() => expect(t.controller.dockEl.textContent).toContain('Working tree clean'));
    }
    press(t.controller, 'g');
    expect(t.complete).not.toHaveBeenCalled();
    expect(t.commitContext).not.toHaveBeenCalled();
    expect(t.controller.dockEl.querySelector<HTMLButtonElement>('[data-git-ai]')?.disabled).toBe(true);
  });

  it('preserves discard confirmation priority over g', async () => {
    const t = setup();
    await aiReady(t);
    press(t.controller, 'j'); // unstaged file
    press(t.controller, 'x');
    press(t.controller, 'g');
    expect(t.complete).not.toHaveBeenCalled();
    expect(t.controller.dockEl.textContent).toContain('Discard unstaged changes');
  });

  it('refuses a payload over budget without sending a truncated patch', async () => {
    const t = setup({ config: { acp_harness: { assist: { max_input_chars: 500 } } } });
    const field = await aiReady(t);
    typeDraft(field, 'Keep this');
    t.commitContext.mockResolvedValue({ repoRoot: '/repo', diff: 'x'.repeat(501), fingerprint: 'large' });
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.flash).toHaveBeenCalledWith('Staged changes exceed the AI input limit; stage a smaller commit.'));
    expect(t.complete).not.toHaveBeenCalled();
    expect(field.value).toBe('Keep this');
  });

  it.each(['', '```text\nWrong format\n```', 'bad\0text'])('preserves the draft for invalid model output %j', async (output) => {
    const t = setup({ complete: async () => output });
    const field = await aiReady(t);
    typeDraft(field, 'Keep this');
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.flash).toHaveBeenCalledWith('AI returned an invalid commit message.'));
    expect(field.value).toBe('Keep this');
  });

  it('preserves the draft on a backend error', async () => {
    const t = setup({ complete: async () => { throw new Error('offline'); } });
    const field = await aiReady(t);
    typeDraft(field, 'Keep this');
    press(t.controller, 'g');
    await vi.waitFor(() => expect(t.flash).toHaveBeenCalledWith('AI commit message is unavailable.'));
    expect(field.value).toBe('Keep this');
  });

  it('rejects over-limit UTF-8 output rather than truncating a message', () => {
    const cfg = { mode: 'manual' as const, backendId: 'claude', modelId: undefined, timeoutMs: 1000, maxInputChars: 20000, options: {} };
    expect(commitMessageCall.parse('ก'.repeat(33_334), cfg, { diff: '+x', draft: '' })).toBeNull();
  });
});
