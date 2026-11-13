// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

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

function setup(options?: { remote?: boolean; projectDir?: string | null }) {
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
  const api: GitPanelApi = { status, stage, unstage, discard, commit };
  const invalidate = vi.fn();
  const focusComposer = vi.fn();
  const flash = vi.fn();
  const setBadge = vi.fn();
  const openDiff = vi.fn(async () => true);
  const controller = new HarnessGitController({
    projectDir: () => projectDir,
    remote: () => remote,
    isPanelHidden: () => hidden,
    setDockTabAvailable: () => {},
    dockTabShown: () => shown,
    invalidate,
    focusComposer,
    flash,
    setBadge,
    openDiff,
  }, api);
  document.body.append(controller.dockEl);
  live.push(controller);
  return {
    controller, status, stage, unstage, discard, commit, invalidate, focusComposer, flash, openDiff,
    show(): void {
      hidden = false;
      shown = true;
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

afterEach(() => {
  for (const controller of live.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = originalScroll;
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
