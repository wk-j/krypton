// Krypton — ACP Harness View: `#e2e` (specs 328, 329).
//
// Krypton-run subcommands (status, run, rerun, cancel) call `src-tauri/src/e2e.rs`
// and answer in one `shell` row filled once when the work ends. `open` opens the
// read-only browser explorer (spec 329). `init`, `case` and `report` are prompt
// verbs for the current lane.

import { invoke } from '@tauri-apps/api/core';

import { loopbackPath, openLoopback } from '../loopback-open';
import {
  E2E_USAGE,
  type E2eCaseInfo,
  type E2eFoundRun,
  type E2eRunInfo,
  type E2eStatus,
  formatE2eCaseDetail,
  formatE2ePending,
  formatE2eRunSummary,
  formatE2eStatus,
  githubRepoUrl,
  parseE2eCommand,
  renderE2ePrompt,
} from './e2e-command';
import { e2eInitPrompt } from './harness-prompts';
import { errorText } from './harness-permission-scan';
import type { HarnessE2eHost } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';

const LANE_BUSY = 'lane busy - #cancel first';

export class HarnessE2eController {
  /** Set by `#e2e cancel`; `run all` checks it between cases. */
  private runAllAborted = false;

  constructor(private readonly host: HarnessE2eHost) {}

  async runCommand(lane: HarnessLane, text: string): Promise<void> {
    const command = parseE2eCommand(text);
    if (command.kind === 'usage') {
      this.host.flashChip(`${command.error} · ${E2E_USAGE}`);
      return;
    }
    const root = this.host.projectDir;
    if (!root) {
      this.host.flashChip('e2e unavailable - no project directory');
      return;
    }
    const echo = text.trim();
    switch (command.kind) {
      case 'status':
        await this.status(lane, root, echo, command.caseId);
        return;
      case 'run':
        await this.runOne(lane, root, echo, command.caseId, command.params, command.fresh);
        return;
      case 'run-all':
        await this.runAll(lane, root, command.fresh);
        return;
      case 'rerun':
        await this.rerun(lane, root, echo);
        return;
      case 'cancel':
        await this.cancel(root);
        return;
      case 'init':
        await this.init(lane, root, command.hint);
        return;
      case 'case':
        await this.writeCase(lane, root, command.issue);
        return;
      case 'report':
        await this.report(lane, root, command.target);
        return;
      case 'open':
        await this.openBrowser(root, command.caseId);
        return;
    }
  }

  /** Spec 329: the project's read-only explorer page, at `#case=<id>` when given. */
  private async openBrowser(root: string, caseId: string | null): Promise<void> {
    try {
      const base = loopbackPath(await invoke<string>('get_e2e_web_url', { root }));
      const path = caseId ? `${base}#${new URLSearchParams({ case: caseId }).toString()}` : base;
      this.host.flashChip(await openLoopback(path));
    } catch (e) {
      this.host.flashChip(`e2e open failed: ${errorText(e)}`);
    }
  }

  private async status(lane: HarnessLane, root: string, echo: string, caseId: string | null): Promise<void> {
    const item = this.host.appendShellRow(lane, `${echo}\n…`);
    try {
      const status = await invoke<E2eStatus>('e2e_status', { root, includeIssues: true });
      const text = caseId === null ? formatE2eStatus(echo, status) : formatE2eCaseDetail(echo, status, caseId);
      this.host.finishShellRow(item, text, 'completed');
    } catch (e) {
      this.host.finishShellRow(item, `${echo}\n${errorText(e)}`, 'failed');
    }
  }

  private async runOne(
    lane: HarnessLane,
    root: string,
    echo: string,
    caseId: string,
    params: Record<string, string>,
    fresh: boolean,
    c?: E2eCaseInfo,
  ): Promise<E2eRunInfo | null> {
    const item = this.host.appendShellRow(lane, formatE2ePending(echo, caseId, Date.now()));
    try {
      const run = await invoke<E2eRunInfo>('e2e_run', { root, caseId, params, fresh });
      this.host.finishShellRow(item, formatE2eRunSummary(echo, run, c), run.verdict === 'PASS' ? 'completed' : 'failed');
      return run;
    } catch (e) {
      this.host.finishShellRow(item, `${echo}\n${runErrorText(e)}`, 'failed');
      return null;
    }
  }

  private async runAll(lane: HarnessLane, root: string, fresh: boolean): Promise<void> {
    this.runAllAborted = false;
    let status: E2eStatus;
    try {
      status = await invoke<E2eStatus>('e2e_status', { root, includeIssues: false });
    } catch (e) {
      this.host.flashChip(`e2e status failed: ${errorText(e)}`);
      return;
    }
    if (!status.initialized || status.cases.length === 0) {
      const echo = `#e2e run all${fresh ? ' --fresh' : ''}`;
      this.host.finishShellRow(this.host.appendShellRow(lane, echo), formatE2eStatus(echo, status), 'failed');
      return;
    }
    for (const c of status.cases) {
      if (this.runAllAborted) return;
      const echo = `#e2e run ${c.id}${fresh ? ' --fresh' : ''}`;
      const run = await this.runOne(lane, root, echo, c.id, {}, fresh, c);
      // A failed invoke (busy, broken manifest) or a cancel ends the queue;
      // a FAIL/BLOCKED verdict does not.
      if (!run || run.verdict === 'CANCELLED') return;
    }
  }

  private async rerun(lane: HarnessLane, root: string, echo: string): Promise<void> {
    const item = this.host.appendShellRow(lane, formatE2ePending(echo, 'last launch', Date.now()));
    try {
      const run = await invoke<E2eRunInfo>('e2e_rerun', { root });
      this.host.finishShellRow(item, formatE2eRunSummary(echo, run), run.verdict === 'PASS' ? 'completed' : 'failed');
    } catch (e) {
      this.host.finishShellRow(item, `${echo}\n${runErrorText(e)}`, 'failed');
    }
  }

  private async cancel(root: string): Promise<void> {
    this.runAllAborted = true;
    try {
      const signalled = await invoke<boolean>('e2e_cancel', { root });
      this.host.flashChip(signalled ? 'cancelling e2e run' : 'no e2e run is active');
    } catch (e) {
      this.host.flashChip(`e2e cancel failed: ${errorText(e)}`);
    }
  }

  private async init(lane: HarnessLane, root: string, hint: string): Promise<void> {
    if (!laneIdle(lane)) {
      this.host.flashChip(LANE_BUSY);
      return;
    }
    let manifest: string | null;
    try {
      manifest = await invoke<string | null>('e2e_write_guides', { root });
    } catch (e) {
      this.host.flashChip(`e2e init failed: ${errorText(e)}`);
      return;
    }
    await this.enqueue(lane, e2eInitPrompt(hint, manifest), 'กำลังตั้งค่า e2e');
  }

  private async writeCase(lane: HarnessLane, root: string, issue: number): Promise<void> {
    if (!laneIdle(lane)) {
      this.host.flashChip(LANE_BUSY);
      return;
    }
    const status = await this.statusForPrompt(root);
    if (!status) return;
    const template = status.manifest?.createPrompt;
    if (!template) {
      this.host.flashChip('create_prompt is not set in .krypton/e2e/project.toml');
      return;
    }
    const issueUrl = await this.issueUrl(root, status, issue);
    await this.enqueue(lane, renderE2ePrompt(template, { issue, issueUrl }), 'กำลังเขียน e2e case');
  }

  private async report(lane: HarnessLane, root: string, target: string): Promise<void> {
    if (!laneIdle(lane)) {
      this.host.flashChip(LANE_BUSY);
      return;
    }
    const status = await this.statusForPrompt(root);
    if (!status) return;
    const template = status.manifest?.reportPrompt;
    if (!template) {
      this.host.flashChip('report_prompt is not set in .krypton/e2e/project.toml');
      return;
    }
    let found: E2eFoundRun;
    try {
      found = await invoke<E2eFoundRun>('e2e_find_run', { root, target });
    } catch (e) {
      this.host.flashChip(`e2e report: ${errorText(e)}`);
      return;
    }
    if (found.issue === null) {
      this.host.flashChip(`e2e report: case ${found.caseId} has no linked issue`);
      return;
    }
    const issueUrl = await this.issueUrl(root, status, found.issue);
    const prompt = renderE2ePrompt(template, {
      issue: found.issue,
      issueUrl,
      runId: found.runId,
      resultPath: found.resultPath,
    });
    await this.enqueue(lane, prompt, 'กำลังรายงานผล e2e');
  }

  /** Manifest and issues for a prompt verb; reports why the verb cannot run. */
  private async statusForPrompt(root: string): Promise<E2eStatus | null> {
    try {
      const status = await invoke<E2eStatus>('e2e_status', { root, includeIssues: true });
      if (!status.initialized || !status.manifest) {
        this.host.flashChip('e2e not initialized - #e2e init');
        return null;
      }
      return status;
    } catch (e) {
      this.host.flashChip(`e2e status failed: ${errorText(e)}`);
      return null;
    }
  }

  /** The labelled issue's URL, else one built from the GitHub `origin`, else `#N`. */
  private async issueUrl(root: string, status: E2eStatus, issue: number): Promise<string> {
    const listed = status.issues?.find((entry) => entry.number === issue);
    if (listed) return listed.url;
    try {
      const remote = await invoke<string>('run_command', {
        program: 'git',
        args: ['remote', 'get-url', 'origin'],
        cwd: root,
      });
      const repo = githubRepoUrl(remote);
      if (repo) return `${repo}/issues/${issue}`;
    } catch {
      // No origin: the lane still gets the number.
    }
    return `#${issue}`;
  }

  private async enqueue(lane: HarnessLane, prompt: string, label: string): Promise<void> {
    const sent = await this.host.enqueueSystemPrompt(lane, prompt, undefined, label);
    if (!sent) this.host.flashChip(LANE_BUSY);
  }
}

function laneIdle(lane: HarnessLane): boolean {
  return lane.status === 'idle' || lane.status === 'awaiting_peer';
}

function runErrorText(e: unknown): string {
  const text = errorText(e);
  return text === 'busy' ? 'busy — another #e2e run is active in this project; #e2e cancel stops it' : text;
}
