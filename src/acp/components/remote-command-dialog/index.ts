import './remote-command-dialog.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { keyCap } from '../../../ui/kbd';
import { CellGridText } from '../../cell-grid';
import { remoteCommandLimitNotes, remoteCommandState, remoteCommandStatus } from '../../harness-remote-command';
import type { RemoteCommandPayload } from '../../harness-view-types';
import type { KeyHintBarProps } from '../key-hint-bar';
import { OverlayShell } from '../overlay-shell';
import { paintRemoteCommandTiming } from '../remote-command-card';
import { TabStrip } from '../tab-strip';
import type { ComponentDef } from '../types';

export interface RemoteCommandDialogProps {
  readonly open: boolean;
  readonly targetId: string | null;
  readonly payload: RemoteCommandPayload | null;
  readonly status: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly takeFocus: boolean;
  readonly diagnostics?: readonly { readonly label: string; readonly text: string }[];
  onClose(restoreFocus: boolean): void;
}

type Section = 'command' | 'output' | 'result';
const SECTIONS: readonly Section[] = ['command', 'output', 'result'];
const TABS = [{ id: 'command', label: 'Command' }, { id: 'output', label: 'Output' }, { id: 'result', label: 'Result' }] as const;
const FOOT: KeyHintBarProps = {
  hints: [
    { keys: ['Tab'], label: 'next section' },
    { keys: ['⇧Tab'], label: 'previous section' },
    { keys: ['←', '↑', '↓', '→'], label: 'scroll' },
    { keys: ['PageUp', 'PageDown'], label: 'page' },
    { keys: ['Home', 'End'], label: 'top/bottom' },
    { keys: ['Esc'], label: 'close' },
  ],
  layout: 'spans', block: 'acp-remote-command-dialog__foot',
};
let instances = 0;

function text(node: Node, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}
function field(label: string, value: HTMLElement): HTMLElement {
  return el('div', { class: 'acp-remote-command-dialog__field' }, el('dt', { text: label }), el('dd', {}, value));
}
function block(): { el: HTMLElement; writer: CellGridText } {
  const node = el('pre', { class: 'acp-remote-command-dialog__text' });
  return { el: node, writer: new CellGridText(node, '') };
}

/** View-owned modal, independent of the transcript row and with no remote I/O. */
export class RemoteCommandDialog extends Component<RemoteCommandDialogProps> {
  private readonly shell: OverlayShell;
  private readonly tabs = new TabStrip('button');
  private readonly ids = `acp-remote-command-dialog-${++instances}`;
  private readonly heading = el('h2', { class: 'acp-remote-command-dialog__heading', text: 'Remote command', attrs: { id: `${this.ids}-title` } });
  private readonly closeButton = el('button', { class: 'acp-remote-command-dialog__button', attrs: { type: 'button', 'aria-label': 'Close remote command details' } }, 'Close ', keyCap('Esc'));
  private readonly state = el('span', { class: 'acp-remote-command-dialog__state' });
  private readonly timer = el('span', { class: 'acp-remote-command-dialog__timer acp-harness__tool-timer', attrs: { title: 'Observed call elapsed time' } });
  private readonly timingLabel = el('span', { text: 'Call elapsed' });
  private readonly computer = block();
  private readonly command = block();
  private readonly cwd = block();
  private readonly stdout = block();
  private readonly stderr = block();
  private readonly exit = el('span');
  private readonly outcome = el('span');
  private readonly error = block();
  private readonly notes = el('p', { class: 'acp-remote-command-dialog__notes' });
  private readonly outputNotice = el('p', { class: 'acp-remote-command-dialog__notes' });
  private readonly panels: Readonly<Record<Section, HTMLElement>>;
  private readonly body: HTMLElement;
  private props: RemoteCommandDialogProps | null = null;
  private readonly diagnostics = block();
  private openState = false;
  private section: Section = 'command';
  private status: string | null = null;
  private visibilityObserver: MutationObserver | null = null;
  private readonly autoClosed = (): void => { this.close(false); };
  private readonly selectTab = (id: string): void => { this.select(id as Section, true); };

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    const content: Record<Section, HTMLElement[]> = {
      command: [el('dl', {}, field('Computer ID (requested)', this.computer.el), field('Requested command', this.command.el), field('Working directory (explicit request)', this.cwd.el))],
      output: [this.outputNotice, el('dl', {}, field('stdout', this.stdout.el), field('stderr', this.stderr.el))],
      result: [el('dl', {}, field('Remote exit code', this.exit), field('Remote outcome', this.outcome), field('Error / diagnostic', this.error.el), field('Tool diagnostics (not remote output)', this.diagnostics.el)), this.notes],
    };
    const panels = {} as Record<Section, HTMLElement>;
    for (const section of SECTIONS) {
      panels[section] = el('section', {
        class: 'acp-remote-command-dialog__section',
        attrs: { id: `${this.ids}-${section}`, role: 'tabpanel', tabindex: '0', 'aria-label': TABS.find((tab) => tab.id === section)!.label },
      }, ...content[section]);
    }
    this.panels = panels;
    this.body = el('div', { class: 'acp-remote-command-dialog__body' },
      el('header', { class: 'acp-remote-command-dialog__header' }, this.heading, this.closeButton),
      el('div', { class: 'acp-remote-command-dialog__summary' }, this.state, this.timingLabel, this.timer),
      this.tabs.el, ...SECTIONS.map((section) => panels[section]));
    this.bag.listen(this.closeButton, 'click', () => { this.close(); });
    this.bag.listen(this.el, 'click', (event: Event) => { if (event.target === this.el) this.close(); });
    this.bag.listen(this.el, 'pointerdown', (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
      if (target && this.el.contains(target)) {
        event.preventDefault();
        target.focus({ preventScroll: true });
      }
    });
    this.paintSection();
  }

  get isOpen(): boolean { return this.openState; }

  update(next: RemoteCommandDialogProps): void {
    const retarget = next.targetId !== this.props?.targetId;
    const focus = next.open && next.takeFocus && (!this.openState || retarget || this.props?.takeFocus !== true);
    if (retarget || !next.open) {
      this.status = null;
      for (const section of SECTIONS) this.panels[section].scrollTop = 0;
    }
    if (next.open) this.status = remoteCommandStatus(this.status, next.status);
    const normalized = next.open && next.status !== this.status ? { ...next, status: this.status! } : next;
    this.props = next.open ? normalized : null;
    super.update(normalized);
    if (focus && this.isOpen) this.activeTab()?.focus({ preventScroll: true });
  }

  close(restoreFocus = true): void {
    const props = this.props;
    if (!this.openState || !props) return;
    this.update({ ...props, open: false, payload: null, takeFocus: false });
    props.onClose(restoreFocus);
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.isOpen || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      this.select(SECTIONS[(SECTIONS.indexOf(this.section) + (event.shiftKey ? 2 : 1)) % 3], true);
      return true;
    }
    // Shift-arrows extend native selection; modifier chords (including copy)
    // already returned above. An existing selection keeps native arrow handling.
    if (event.shiftKey) return false;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && this.el.contains(selection.anchorNode)) return false;
    const panel = this.panels[this.section];
    const step = 40;
    const page = Math.max(step, panel.clientHeight - step);
    const maxTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
    const maxLeft = Math.max(0, panel.scrollWidth - panel.clientWidth);
    switch (event.key) {
      case 'ArrowUp': panel.scrollTop = Math.max(0, panel.scrollTop - step); break;
      case 'ArrowDown': panel.scrollTop = Math.min(maxTop, panel.scrollTop + step); break;
      case 'ArrowLeft': panel.scrollLeft = Math.max(0, panel.scrollLeft - step); break;
      case 'ArrowRight': panel.scrollLeft = Math.min(maxLeft, panel.scrollLeft + step); break;
      case 'PageUp': panel.scrollTop = Math.max(0, panel.scrollTop - page); break;
      case 'PageDown': panel.scrollTop = Math.min(maxTop, panel.scrollTop + page); break;
      case 'Home': panel.scrollTop = 0; break;
      case 'End': panel.scrollTop = maxTop; break;
      default: return false;
    }
    event.preventDefault();
    return true;
  }

  protected readDeps(next: RemoteCommandDialogProps): readonly unknown[] {
    return [next.open, next.targetId, next.payload, next.status, next.startedAt, next.endedAt, next.diagnostics];
  }

  protected syncClasses(next: RemoteCommandDialogProps): void {
    if (next.open && next.payload) this.el.dataset.state = remoteCommandState(next.payload, next.status).state;
    else delete this.el.dataset.state;
  }

  protected paint(next: RemoteCommandDialogProps): void {
    const payload = next.open ? next.payload : null;
    this.shell.update({
      open: payload !== null, name: 'remote-command', block: 'acp-remote-command-dialog', title: '', body: this.body,
      parts: { head: 'acp-remote-command-dialog__shell-head' }, hints: FOOT,
      panelAttrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': this.heading.id }, onAutoClose: this.autoClosed,
    });
    this.openState = payload !== null;
    if (!payload) {
      this.visibilityObserver?.disconnect();
      this.visibilityObserver = null;
      this.timer.removeAttribute('data-started-at');
      delete this.el.dataset.state;
      return;
    }
    const state = remoteCommandState(payload, next.status);
    this.el.dataset.state = state.state;
    text(this.state, state.label);
    this.computer.writer.set(payload.computerId);
    this.command.writer.set(payload.command);
    this.cwd.writer.set(payload.cwd ?? 'Not reported');
    this.stdout.writer.set(payload.result?.stdout ?? '');
    this.stderr.writer.set(payload.result?.stderr ?? '');
    text(this.outputNotice, payload.result ? (!payload.result.stdout && !payload.result.stderr ? 'No output.' : '') : 'No remote output reported.');
    text(this.exit, payload.result?.exitCode === null || !payload.result ? 'Not reported' : String(payload.result.exitCode));
    text(this.outcome, payload.outcomeUnknown || payload.result?.outcome === 'unknown' ? 'Unknown — remote process may still be running.' : payload.result?.outcome === 'completed' ? 'Completed' : 'Not reported');
    this.error.writer.set(payload.error ?? 'None reported');
    this.diagnostics.writer.set(next.diagnostics?.filter((section) => section.text).map((section) => `${section.label}\n${section.text}`).join('\n\n') || 'None reported');
    text(this.notes, remoteCommandLimitNotes(payload));
    paintRemoteCommandTiming(this.timer, this.timingLabel, { ...next, payload });
    if (!this.visibilityObserver) this.watchVisibility();
  }

  private activeTab(): HTMLButtonElement | null {
    return this.tabs.el.querySelector<HTMLButtonElement>(`[data-tab-id="${this.section}"]`);
  }

  private select(section: Section, focus: boolean): void {
    this.section = section;
    this.paintSection();
    if (focus) this.activeTab()?.focus({ preventScroll: true });
  }

  private paintSection(): void {
    this.tabs.update({ tabs: TABS, activeId: this.section, block: 'acp-remote-command-dialog', item: 'tab', activeClass: 'acp-remote-command-dialog__tab--active', role: 'tablist', ariaLabel: 'Remote command sections', onSelect: this.selectTab });
    for (const section of SECTIONS) {
      const tab = this.tabs.el.querySelector<HTMLButtonElement>(`[data-tab-id="${section}"]`)!;
      tab.id = `${this.ids}-tab-${section}`;
      tab.setAttribute('aria-controls', this.panels[section].id);
      this.panels[section].setAttribute('aria-labelledby', tab.id);
      this.panels[section].hidden = this.section !== section;
    }
  }

  private watchVisibility(): void {
    const tab = this.el.closest<HTMLElement>('.krypton-tab-wrapper');
    const windowEl = this.el.closest<HTMLElement>('.krypton-window');
    if (!tab && !windowEl) return;
    this.visibilityObserver = new MutationObserver(() => {
      if (tab?.classList.contains('krypton-tab-wrapper--hidden') || windowEl?.style.display === 'none') this.close(false);
    });
    if (tab) this.visibilityObserver.observe(tab, { attributes: true, attributeFilter: ['class'] });
    if (windowEl) this.visibilityObserver.observe(windowEl, { attributes: true, attributeFilter: ['style'] });
  }

  protected onDispose(): void {
    this.openState = false;
    this.props = null;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.tabs.dispose();
    this.timer.removeAttribute('data-started-at');
    this.shell.dispose();
    this.el.remove();
  }
}

export const def: ComponentDef = { id: 'remote-command-dialog', blocks: ['acp-harness__remote-command-overlay', 'acp-remote-command-dialog'] };
