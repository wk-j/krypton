// Spec 357 — `AssistantInstances`, the right dock's Assistants tab.
//
//   ⁂ All projects                            ◷ Updated 01:44:14
//   ▣ 3        ◈ 1        ∿ 1        ? 0
//   ACP        embedded   working    unknown
//   ◎ OMP-1                          ( ○ idle )   0.3%   318M
//     krypton · claude-opus-5-5                         ◷ 6m
//   ✳ Assist                         ( ● running )  5.0%   714M
//     krypton · haiku                                   ◷ 5m
//   Assist · /Users/wk/Source/krypton
//   Instance      acp:3
//   Conversation  fb1176f1-…      one label column for every group
//   j/k · Home/End · [ ] tab · Esc   each key a cap
//
// Compact by layout, not by type: every line is the dock's body size. Two
// lines per row, a third only while lifecycle or liveness is unsettled or an
// error is reported; the right-hand figures sit in fixed-width cells so they
// line up down the list, and the details share one label column.
//
// Props only: the controller owns selection and the store subscription, the
// dock owns `hidden`. Rows are keyed by instance ID and repaint only when one
// of their displayed values moves; the selected-instance details are their own
// component, so a tick that changes nothing they show leaves them alone.

import './assistant-instances.css';

import type { AssistantInstance, AssistantInventoryState } from '../../../assistant-instance-store';
import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { keyHintNodes, type KeyHint } from '../../../ui/kbd';
import { disposeList, reconcile } from '../../../ui/list';
import { formatCpu, formatRss } from '../../harness-format';
import { harnessIconEl, harnessSymbolEl } from '../../harness-icons';
import { backendLogoId } from '../../harness-lane-identity';
import { Chip } from '../chip';
import type { ComponentDef } from '../types';

export interface AssistantInstancesProps {
  readonly inventory: AssistantInventoryState;
  readonly selectedId: string | null;
  readonly now: number;
}

const B = 'acp-assistant-instances';
const STALE_AFTER_MS = 6000;
const KEY_HINTS: readonly KeyHint[] = [
  { keys: ['j', 'k'], label: '', keySeparator: '/' },
  { keys: ['Home', 'End'], label: '', keySeparator: '/' },
  { keys: ['[', ']'], label: 'tab' },
  { keys: ['Esc'], label: '' },
];
const LOGO_PREFIX = 'krypton-logo-';
const ROLE_LABELS: Record<AssistantInstance['owner']['role'], string> = {
  harness_lane: 'Harness lane', session_probe: 'Session probe', assist: 'Assist',
  rails_judge: 'Rails judge', inline_ai: 'Inline AI', agent_view: 'Agent view',
  file_manager_ai: 'File Manager AI', markdown_ai: 'Markdown AI',
};

/** State colour: ink for settled values, amber for work in progress, warning
 *  for a human wait or unconfirmed liveness, fault for an error. Each state
 *  chip is a lamp (DESIGN.md "Lamps"): its LED says the tone, its word the state. */
type Tone = 'neutral' | 'muted' | 'pending' | 'live' | 'warn' | 'fault';

const LIFECYCLE_TONE: Record<AssistantInstance['lifecycle'], Tone> = {
  initializing: 'pending', ready: 'neutral', terminating: 'pending', disconnected: 'muted',
};
const ACTIVITY_TONE: Record<AssistantInstance['activity'], Tone> = {
  idle: 'neutral', running: 'live', waiting: 'warn',
};
const LIVENESS_TONE: Record<AssistantInstance['liveness'], Tone> = {
  alive: 'neutral', exited: 'muted', unknown: 'warn',
};

/** `tone` tints a non-zero count: work in progress, or liveness nobody
 *  confirmed. `title` is the full name the short inline label stands for. */
const STATS: readonly { readonly id: StatId; readonly label: string; readonly title: string; readonly icon: string; readonly tone?: 'live' | 'warn' }[] = [
  { id: 'acp', label: 'ACP', title: 'Known-live ACP processes', icon: 'process' },
  { id: 'embedded', label: 'embedded', title: 'Embedded agents', icon: 'embedded' },
  { id: 'working', label: 'working', title: 'Working assistants', icon: 'exec-activity', tone: 'live' },
  { id: 'unknown', label: 'unknown', title: 'Unknown liveness', icon: 'unknown', tone: 'warn' },
];
type StatId = 'acp' | 'embedded' | 'working' | 'unknown';

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local wall-clock time, the zone the user reads every other clock in. */
function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function age(started: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** `short` drops the provider prefix (`anthropic/claude-opus-5-5` →
 *  `claude-opus-5-5`) for a row; the details carry the full id. */
function modelLabel(instance: AssistantInstance, short = false): string {
  const id = (model: string): string => (short ? model.slice(model.lastIndexOf('/') + 1) : model);
  const confirmed = instance.confirmed_model_id === null ? null : id(instance.confirmed_model_id);
  const requested = instance.requested_model_id === null ? null : id(instance.requested_model_id);
  if (instance.model_uncertain) return `${confirmed ?? '—'} · uncertain${requested ? ` · requested ${requested}` : ''}`;
  if (confirmed) return `${confirmed}${requested && requested !== confirmed ? ` · requested ${requested}` : ''}`;
  return requested ? `— · requested ${requested} (unconfirmed)` : '— · model not reported';
}

/** Helpers are labelled by their role (`Assist · /repo`, `Inline AI · …`);
 *  say it once. */
function labelCarriesRole(instance: AssistantInstance): boolean {
  const role = ROLE_LABELS[instance.owner.role].toLowerCase();
  const label = instance.owner.label.toLowerCase();
  return label === role || label.startsWith(`${role} · `);
}

/** Row name: a helper label repeats its cwd (`Assist · /Users/…/krypton`),
 *  which the project fact under it already shows. */
function rowName(label: string): string {
  const parts = label.split(' · ').filter((part) => !/^(?:[/~]|[A-Za-z]:[\\/])/.test(part));
  return parts.length > 0 ? parts.join(' · ') : label;
}

/** Row host: only what differs from the usual local process. */
function hostFact(instance: AssistantInstance): string {
  const { kind, host } = instance.execution;
  if (kind === 'embedded') return 'embedded';
  if (kind === 'remote') return host ?? 'remote host unavailable';
  // Inline AI in an SSH pane still executes here; only its tools target SSH.
  return instance.owner.role === 'inline_ai' ? 'local execution' : '';
}

function hostDetail(instance: AssistantInstance): string {
  const { kind, host } = instance.execution;
  if (kind === 'embedded') return 'embedded · shared WebView process';
  if (kind === 'remote') return `remote · ${host ?? 'host unavailable'}`;
  const local = instance.owner.role === 'inline_ai' ? 'local execution' : 'local';
  return host && host !== 'local' ? `${local} · ${host}` : local;
}

/** Row resource cell. `cpu`/`mem` are empty when not measured; `note` then
 *  says why, briefly — the details carry the full reason. */
interface Usage {
  readonly cpu: string;
  readonly mem: string;
  readonly note: string;
  readonly stale: boolean;
}

function usage(instance: AssistantInstance, state: AssistantInventoryState, now: number): Usage {
  if (instance.kind === 'embedded') return { cpu: '', mem: '', note: 'shared WebView', stale: false };
  if (instance.execution.kind === 'remote') return { cpu: '', mem: '', note: 'unavailable', stale: false };
  const sample = instance.metrics;
  if (!sample || state.sampled_at_ms === null) return { cpu: '', mem: '', note: 'not sampled', stale: false };
  const stale = state.error !== null || state.loading || now - state.sampled_at_ms > STALE_AFTER_MS;
  if (!sample.root_alive) return { cpu: '', mem: '', note: 'not observed', stale };
  const cpu = instance.cpu_ready ? formatCpu(sample.total_cpu_percent) : 'warming up';
  return { cpu, mem: formatRss(sample.total_rss_mb), note: '', stale };
}

interface InstanceRowProps extends Usage {
  readonly id: string;
  readonly selected: boolean;
  readonly logo: string;
  readonly name: string;
  readonly role: string;
  readonly age: string;
  readonly lifecycle: AssistantInstance['lifecycle'];
  readonly activity: AssistantInstance['activity'];
  readonly liveness: AssistantInstance['liveness'];
  readonly error: boolean;
  readonly project: string;
  readonly host: string;
  readonly model: string;
}

function rowProps(instance: AssistantInstance, next: AssistantInstancesProps): InstanceRowProps {
  const project = instance.cwd.split(/[\\/]/).filter(Boolean).pop() ?? instance.cwd;
  return {
    id: instance.id, selected: instance.id === next.selectedId,
    // Embedded assistants are Pi Agents (`backend_id: 'pi'`), a name the
    // lane-backend map does not carry.
    logo: instance.kind === 'embedded' ? `${LOGO_PREFIX}pi` : backendLogoId(instance.backend_id),
    name: rowName(instance.owner.label),
    // A Harness lane is the usual row; say the role only when it differs.
    role: instance.owner.role === 'harness_lane' || labelCarriesRole(instance) ? '' : ROLE_LABELS[instance.owner.role],
    age: age(instance.started_at_ms, next.now),
    lifecycle: instance.lifecycle, activity: instance.activity, liveness: instance.liveness, error: instance.has_error,
    project: project || 'project unavailable',
    host: hostFact(instance),
    // The logo already names the backend.
    model: modelLabel(instance, true),
    ...usage(instance, next.inventory, next.now),
  };
}

function rowDeps(next: InstanceRowProps): readonly unknown[] {
  return [next.id, next.selected, next.logo, next.name, next.role, next.age, next.lifecycle, next.activity,
    next.liveness, next.error, next.project, next.host, next.model,
    next.cpu, next.mem, next.note, next.stale];
}

function chipClass(tone: Tone): readonly string[] {
  return tone === 'neutral' ? [] : [`${B}__chip--${tone}`];
}

/** `<span class="…"><svg/></span>` whose symbol can be swapped. */
class IconSlot {
  readonly el: HTMLElement;
  private id: string | null = null;

  constructor(cls: string) {
    this.el = el('span', { class: cls, attrs: { 'aria-hidden': 'true' } });
  }

  set(symbolId: string): void {
    if (symbolId === this.id) return;
    this.id = symbolId;
    this.el.replaceChildren(harnessSymbolEl(symbolId));
  }
}

/** Two lines beside the logo, a third only for an unsettled state:
 *    name · role                     ○ IDLE   0.3%   318M
 *    project · host · model                          ◷ 38s
 *    [● INITIALIZING] [● UNKNOWN] [● ERROR]
 *  Left text clips; the right cluster stays whole and its cells keep fixed
 *  widths, so figures and ages line up from row to row. */
class InstanceRow extends Component<InstanceRowProps> {
  private readonly logo = new IconSlot(`${B}__logo`);
  private readonly nameEl = el('strong', { class: `${B}__name` });
  private readonly roleEl = el('span', { class: `${B}__role` });
  private readonly activityChip = new Chip();
  private readonly liveEl = el('span', { class: `${B}__live` });
  private readonly cpuEl = el('span', { class: `${B}__metric`, data: { metric: 'cpu' }, attrs: { title: 'CPU' } });
  private readonly memEl = el('span', { class: `${B}__metric`, data: { metric: 'mem' }, attrs: { title: 'memory' } });
  private readonly noteEl = el('span', { class: `${B}__note` });
  private readonly projectEl = el('span', { class: `${B}__fact`, data: { fact: 'project' } });
  private readonly hostEl = el('span', { class: `${B}__fact`, data: { fact: 'host' } });
  private readonly modelEl = el('span', { class: `${B}__fact`, data: { fact: 'model' } });
  private readonly factsEl = el('span', { class: `${B}__facts` }, this.projectEl, this.hostEl, this.modelEl);
  private readonly ageEl = el('span', { class: `${B}__age` });
  private readonly lifecycleChip = new Chip();
  private readonly livenessChip = new Chip();
  private readonly errorChip = new Chip();
  private readonly alertsEl = el('div', { class: `${B}__alerts` },
    this.lifecycleChip.el, this.livenessChip.el, this.errorChip.el);

  constructor() {
    super(el('div', { attrs: { role: 'option' } }));
    this.liveEl.append(this.activityChip.el, this.cpuEl, this.memEl, this.noteEl);
    this.el.append(
      this.logo.el,
      el('div', { class: `${B}__line` },
        el('span', { class: `${B}__ident` }, this.nameEl, this.roleEl),
        this.liveEl),
      el('div', { class: `${B}__line` },
        this.factsEl,
        el('span', { class: `${B}__age-cell`, attrs: { title: 'age' } }, harnessIconEl('clock'), this.ageEl)),
      this.alertsEl,
    );
  }

  protected readDeps(next: InstanceRowProps): readonly unknown[] { return rowDeps(next); }

  protected syncClasses(next: InstanceRowProps): void {
    this.el.className = `${B}__row${next.selected ? ` ${B}__row--selected` : ''}`;
  }

  protected paint(next: InstanceRowProps): void {
    this.syncClasses(next);
    this.el.dataset.assistantId = next.id;
    this.el.setAttribute('aria-selected', String(next.selected));
    this.logo.set(next.logo);
    this.logo.el.className = `${B}__logo ${B}__logo--${next.logo.slice(LOGO_PREFIX.length)}`;
    setText(this.nameEl, next.name);
    this.nameEl.title = next.name;
    setText(this.roleEl, next.role);
    this.roleEl.hidden = next.role === '';
    const activityTone = ACTIVITY_TONE[next.activity];
    this.activityChip.update({ block: `${B}__chip`, text: next.activity, modifiers: chipClass(activityTone), title: `activity ${next.activity}` });
    // A stale sample dims its figures instead of adding a tag: the head
    // already says the inventory is stale, and the row keeps its width.
    this.liveEl.dataset.stale = String(next.stale);
    setAttr(this.liveEl, 'title', next.stale ? 'stale sample' : undefined);
    setText(this.cpuEl, next.cpu);
    this.cpuEl.hidden = next.cpu === '';
    setText(this.memEl, next.mem);
    this.memEl.hidden = next.mem === '';
    setText(this.noteEl, next.note);
    this.noteEl.hidden = next.note === '';
    setText(this.projectEl, next.project);
    setText(this.hostEl, next.host);
    this.hostEl.hidden = next.host === '';
    setText(this.modelEl, next.model);
    this.factsEl.title = [next.project, next.host, next.model].filter(Boolean).join(' · ');
    setText(this.ageEl, next.age);
    // Lifecycle and liveness show only once they leave their settled value;
    // the details always carry all three.
    this.lifecycleChip.update({ block: `${B}__chip`, text: next.lifecycle, modifiers: chipClass(LIFECYCLE_TONE[next.lifecycle]), title: `lifecycle ${next.lifecycle}` });
    this.lifecycleChip.el.hidden = next.lifecycle === 'ready';
    this.livenessChip.update({ block: `${B}__chip`, text: next.liveness, modifiers: chipClass(LIVENESS_TONE[next.liveness]), title: `liveness ${next.liveness}` });
    this.livenessChip.el.hidden = next.liveness === 'alive';
    this.errorChip.update({ block: `${B}__chip`, text: 'error', modifiers: chipClass('fault'), title: 'the agent reported an error' });
    this.errorChip.el.hidden = !next.error;
    this.alertsEl.hidden = next.lifecycle === 'ready' && next.liveness === 'alive' && !next.error;
  }

  protected onDispose(): void {
    for (const chip of [this.activityChip, this.lifecycleChip, this.livenessChip, this.errorChip]) chip.dispose();
  }
}

interface DetailField {
  readonly label: string;
  readonly value: string;
  /** Exact value behind a formatted one, e.g. the ISO instant of a local time. */
  readonly title?: string;
}

/** Identity, execution and timing, in that order; a group is a list of
 *  fields, separated from the next by a hairline rather than a heading. */
interface DetailsProps {
  readonly name: string;
  readonly groups: readonly (readonly DetailField[])[];
}

function timeField(label: string, ms: number | null): DetailField {
  if (ms === null) return { label, value: '—' };
  const date = new Date(ms);
  return { label, value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(ms)}`, title: date.toISOString() };
}

/** A field whose absence says nothing (no lane on a helper, no runtime on a
 *  local process) is left out rather than shown as `—`. */
function optionalField(label: string, value: string | null): readonly DetailField[] {
  return value === null ? [] : [{ label, value }];
}

function detailsProps(instance: AssistantInstance | undefined): DetailsProps | null {
  if (!instance) return null;
  const role = ROLE_LABELS[instance.owner.role];
  const resourceNote: DetailField | null = instance.kind === 'embedded' ? { label: 'Resources', value: 'unavailable · shared WebView process' }
    : instance.execution.kind === 'remote' ? { label: 'Resources', value: 'unavailable · not available from remote runtime' }
      : !instance.metrics ? { label: 'Resources', value: 'unavailable · not sampled' }
        : !instance.cpu_ready ? { label: 'CPU', value: 'warming up · awaiting fresh delta' } : null;
  const state = [instance.lifecycle, instance.activity, instance.liveness, ...(instance.has_error ? ['error'] : [])];
  return {
    name: labelCarriesRole(instance) ? instance.owner.label : `${instance.owner.label} · ${role}`,
    groups: [
      [
        { label: 'Instance', value: instance.id },
        { label: 'Conversation', value: instance.acp_session_id ?? '— · not established' },
        ...optionalField('Harness', instance.owner.harness_id),
        ...optionalField('Lane', instance.owner.lane_id),
      ],
      [
        { label: 'Cwd', value: instance.cwd || '— · unavailable' },
        { label: 'Host', value: hostDetail(instance) },
        ...optionalField('Runtime', instance.execution.runtime_id),
        { label: 'Model', value: `${instance.backend_id} · ${modelLabel(instance)}` },
        { label: 'State', value: state.join(' · ') },
        ...optionalField('PID', instance.pid === null ? null : String(instance.pid)),
        ...(resourceNote ? [resourceNote] : []),
      ],
      [
        timeField('Started', instance.started_at_ms),
        timeField('Last active', instance.last_activity_at_ms),
      ],
    ],
  };
}

function detailsDeps(next: DetailsProps | null): readonly unknown[] {
  if (!next) return [null];
  return [next.name, ...next.groups.flatMap((group) => [group.length,
    ...group.flatMap((field) => [field.label, field.value, field.title])])];
}

/** The selected instance's full identity: one label → value grid per group. */
class InstanceDetails extends Component<DetailsProps | null> {
  constructor() {
    super(el('section', { attrs: { 'aria-label': 'Selected assistant identity' } }));
  }

  protected readDeps(next: DetailsProps | null): readonly unknown[] { return detailsDeps(next); }

  protected syncClasses(): void {
    this.el.className = `${B}__details`;
  }

  protected paint(next: DetailsProps | null): void {
    this.syncClasses();
    this.el.hidden = next === null;
    if (!next) {
      this.el.replaceChildren();
      return;
    }
    this.el.replaceChildren(
      el('h3', { class: `${B}__details-name`, text: next.name }),
      // One grid, one label column: each group is a subgrid row band.
      el('dl', { class: `${B}__fields` }, ...next.groups.map((group) => el('div', { class: `${B}__group` },
        ...group.flatMap((field) => [
          el('dt', { text: field.label }),
          el('dd', { text: field.value, title: field.title }),
        ])))),
    );
  }
}

function counts(state: AssistantInventoryState): Record<StatId, number | null> {
  const known = state.refreshed_at_ms !== null;
  const count = (predicate: (instance: AssistantInstance) => boolean): number => state.instances.filter(predicate).length;
  return {
    acp: known ? count((instance) => instance.kind === 'acp' && instance.liveness === 'alive') : null,
    embedded: count((instance) => instance.kind === 'embedded'),
    working: count((instance) => instance.liveness !== 'exited' && instance.activity === 'running'),
    unknown: known ? count((instance) => instance.liveness === 'unknown') : null,
  };
}

function status(state: AssistantInventoryState, now: number): { readonly text: string; readonly stale: boolean } {
  const known = state.refreshed_at_ms !== null;
  const stale = state.error !== null || (known && (state.loading || now - state.refreshed_at_ms! > STALE_AFTER_MS));
  const since = `last success ${known ? clock(state.refreshed_at_ms!) : 'never'}`;
  // A failed refresh already says the rows are stale; name the cause once.
  const text = [state.loading ? 'Loading…' : '',
    state.error ? `Refresh failed: ${state.error} · ${since}` : stale ? `Stale inventory · ${since}` : '',
    !stale && !state.loading && known ? `Updated ${clock(state.refreshed_at_ms!)}` : '',
  ].filter(Boolean).join(' · ');
  return { text, stale };
}

function emptyText(state: AssistantInventoryState): string {
  if (state.loading) return 'Loading assistant instances…';
  if (state.error) return 'Assistant inventory unavailable';
  return state.refreshed_at_ms !== null ? 'No assistant instances started' : 'Assistant inventory not loaded';
}

export class AssistantInstances extends Component<AssistantInstancesProps> {
  private readonly hostClass: string;
  private readonly statusIcon = new IconSlot(`${B}__status-icon`);
  private readonly statusText = el('span');
  private readonly statusEl = el('p', { class: `${B}__status`, attrs: { role: 'status' } }, this.statusIcon.el, this.statusText);
  private readonly statTiles = new Map<StatId, { readonly tile: HTMLElement; readonly value: HTMLElement }>();
  private readonly emptyEl = el('p', { class: `${B}__empty` });
  private readonly rowsEl = el('div', { class: `${B}__list`, attrs: { role: 'listbox', 'aria-label': 'Assistant instances' } });
  private readonly details = new InstanceDetails();

  constructor(host?: HTMLElement) {
    super(host ?? el('aside'));
    this.hostClass = host?.className ?? '';
    this.el.tabIndex = -1;
    this.el.setAttribute('aria-label', 'Assistant instances');
    const summary = el('div', { class: `${B}__summary`, attrs: { role: 'group', 'aria-label': 'Instance counts' } });
    for (const stat of STATS) {
      const value = el('span', { class: `${B}__stat-value` });
      const tile = el('span', { class: `${B}__stat`, data: { stat: stat.id }, attrs: { title: stat.title } },
        harnessIconEl(stat.icon), value, el('span', { class: `${B}__stat-label`, text: stat.label }));
      this.statTiles.set(stat.id, { tile, value });
      summary.appendChild(tile);
    }
    this.el.append(
      el('header', { class: `${B}__head` },
        el('div', { class: `${B}__title` }, harnessIconEl('assistants'), el('h2', { text: 'All projects' })),
        this.statusEl),
      summary,
      el('div', { class: `${B}__body` }, this.emptyEl, this.rowsEl),
      this.details.el,
      el('footer', { class: `${B}__keys`, children: keyHintNodes(KEY_HINTS) }),
    );
  }

  protected readDeps(next: AssistantInstancesProps): readonly unknown[] {
    const state = next.inventory;
    const line = status(state, next.now);
    const count = counts(state);
    return [line.text, line.stale, count.acp, count.embedded, count.working, count.unknown,
      state.instances.length === 0, emptyText(state),
      ...state.instances.flatMap((instance) => rowDeps(rowProps(instance, next))),
      ...detailsDeps(detailsProps(state.instances.find((instance) => instance.id === next.selectedId)))];
  }

  protected syncClasses(): void {
    this.el.className = `${this.hostClass} ${B}`.trim();
  }

  protected paint(next: AssistantInstancesProps): void {
    this.syncClasses();
    const state = next.inventory;
    const line = status(state, next.now);
    this.statusEl.hidden = line.text === '';
    this.statusEl.dataset.stale = String(line.stale);
    this.statusIcon.set(`krypton-icon-${line.stale ? 'warn' : 'clock'}`);
    setText(this.statusText, line.text);
    const count = counts(state);
    for (const stat of STATS) {
      const { tile, value } = this.statTiles.get(stat.id)!;
      const n = count[stat.id];
      setText(value, n === null ? '—' : String(n));
      setAttr(tile, 'data-tone', n ? stat.tone : undefined);
    }
    this.emptyEl.hidden = state.instances.length !== 0;
    setText(this.emptyEl, emptyText(state));
    reconcile(this.rowsEl, state.instances.map((instance) => rowProps(instance, next)), {
      key: (row) => row.id,
      create: (row) => { const component = new InstanceRow(); component.update(row); return component; },
      update: (component, row) => component.update(row),
    });
    this.details.update(detailsProps(state.instances.find((instance) => instance.id === next.selectedId)));
  }

  protected onDispose(): void {
    disposeList(this.rowsEl);
    this.details.dispose();
  }
}

export const def: ComponentDef = { id: 'assistant-instances', blocks: ['acp-assistant-instances'] };
