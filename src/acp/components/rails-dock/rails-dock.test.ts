import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { railsDockActions, type RailsDockActionsInput } from '../../rails/actions';
import { localHhMm } from '../../rails/format';
import { railsDockRows } from '../../rails/rows';
import type {
  RailsCheckResult,
  RailsDockModel,
  RailsRunRecord,
  RailsSnapshot,
  TrackedFinding,
} from '../../rails/types';
import { RailsDock, type RailsDockProps } from './index';

const snapshot: RailsSnapshot = {
  present: true,
  manifestPath: '/repo/.krypton/rails.toml',
  trust: 'trusted',
  checks: [
    { name: 'typecheck', argv: ['npx', 'tsc', '--noEmit'], timeoutS: 120 },
    { name: 'arch', argv: ['npx', 'vitest', 'run', 'arch'], timeoutS: 60 },
  ],
  rules: [
    { id: 'docs/adr/0008-lanes.md#1', source: 'docs/adr/0008-lanes.md', appliesTo: [], check: 'arch', text: 'Lanes never import views.' },
    { id: 'docs/adr/0008-lanes.md#2', source: 'docs/adr/0008-lanes.md', appliesTo: ['src/acp/**'], check: null, text: 'Bus payloads stay plain data.' },
  ],
  glossary: [],
  uncoveredSources: ['docs/adr/0009-x.md'],
  warnings: ['check `lint` is never referenced'],
  error: null,
};

function check(name: string, outcome: RailsCheckResult['outcome'], outputTail = ''): RailsCheckResult {
  return { name, outcome, exitCode: outcome === 'pass' ? 0 : 1, durationMs: 1234, outputTail };
}

const finding: TrackedFinding = {
  rule: 'docs/adr/0008-lanes.md#2',
  severity: 'violation',
  file: 'src/acp/bus.ts',
  line: 12,
  note: 'payload carries a class instance',
  key: 'docs/adr/0008-lanes.md#2\u0000src/acp/bus.ts',
  status: 'new',
  firstSeenRunId: '20261027T140200Z-ab12',
  firstSeenAt: '2026-10-27T14:02:00Z',
};

function run(over: Partial<RailsRunRecord> = {}): RailsRunRecord {
  return {
    version: 1,
    runId: '20261027T140200Z-ab12',
    startedAt: '2026-10-27T14:01:00Z',
    finishedAt: '2026-10-27T14:02:00Z',
    trigger: { kind: 'auto', laneId: 'l1', laneName: 'codex-1' },
    fingerprint: 'f',
    verdict: 'check_failed',
    stale: false,
    checks: [check('typecheck', 'pass'), check('arch', 'fail', 'arch.test.ts:4 expected no import')],
    checksSkipped: false,
    judge: 'ran',
    judgeFailure: null,
    open: [finding],
    resolved: [],
    dropped: 0,
    rulesTruncated: null,
    ruleStatus: {},
    error: null,
    ...over,
  };
}

const history: readonly RailsRunRecord[] = [run(), run({ runId: '20261027T130000Z-0000', verdict: 'clean', open: [], stale: true })];

function model(over: Partial<RailsDockModel> = {}): RailsDockModel {
  return {
    snapshot,
    mode: 'auto',
    progress: { kind: 'idle' },
    history,
    selectedKey: null,
    expanded: new Set<string>(),
    ...over,
  };
}

function mount(): RailsDock {
  return new RailsDock(document.createElement('aside'));
}

const IDLE_LANE = { displayName: 'codex-1', status: 'idle', hasClient: true };

function actions(over: Partial<RailsDockActionsInput> = {}): RailsDockProps['actions'] {
  return railsDockActions({
    snapshot,
    mode: 'auto',
    progress: { kind: 'idle' },
    running: false,
    latest: history[0],
    lastSend: null,
    activeLane: IDLE_LANE,
    updateLane: null,
    now: Date.parse('2026-10-27T15:00:00Z'),
    ...over,
  });
}

function props(m: RailsDockModel, over: Partial<RailsDockProps> = {}): RailsDockProps {
  return { model: m, actions: actions(), ...over };
}

const actionButton = (dock: RailsDock, verb: string): HTMLButtonElement => {
  const button = dock.el.querySelector<HTMLButtonElement>(`[data-rails-action="${verb}"]`);
  if (!button) throw new Error(`no ${verb} button`);
  return button;
};

const rowEls = (dock: RailsDock): HTMLElement[] => [
  ...dock.el.querySelectorAll<HTMLElement>('.acp-rails-dock__row'),
];

// Finding keys hold U+0000, which a CSS selector cannot match; compare the data.
const rowEl = (dock: RailsDock, key: string): HTMLElement | null =>
  rowEls(dock).find((node) => node.dataset.railsKey === key) ?? null;

describe('RailsDock', () => {
  const scrollIntoView = vi.fn();
  const originalScroll = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScroll;
  });

  it('paints every row in railsDockRows order inside the content block', () => {
    const dock = mount();
    const m = model();
    dock.update(props(m));

    expect(dock.el.querySelector('.acp-rails-dock')).not.toBeNull();
    expect(rowEls(dock).map((node) => node.dataset.railsKey)).toEqual(railsDockRows(m).map((row) => row.key));
    expect([...dock.el.querySelectorAll('.acp-rails-dock__section-label')].map((node) => node.textContent))
      .toEqual(['checks', 'findings', 'rules', 'runs']);
    expect(dock.el.querySelector('.acp-rails-dock__keys')?.textContent)
      .toBe('j/k · ↵ · 1–5 · s send · r run · [ ] tab · esc');
  });

  it('paints the head, check, finding, rules and run rows from their data', () => {
    const dock = mount();
    dock.update(props(model()));

    const head = rowEl(dock, 'head');
    expect(head?.querySelector('.acp-rails-dock__eyebrow')?.textContent).toBe('RAILS');
    expect(head?.querySelector('.acp-rails-dock__pill--check_failed')?.textContent).toBe('CHECK FAILED');
    expect(head?.querySelector('.acp-rails-dock__time')?.textContent).toBe(localHhMm('2026-10-27T14:02:00Z'));
    expect(head?.querySelector('.acp-rails-dock__meta')?.textContent).toBe('auto · codex-1 · mode auto');
    // Spec 345: the warnings wait behind Enter; the state line only counts them.
    expect(head?.querySelector('.acp-rails-dock__state')?.textContent).toBe('1 manifest warning');
    expect(head?.querySelector('.acp-rails-dock__disclosure')?.textContent).toBe('▸');
    expect(head?.querySelector('.acp-rails-dock__warnings')).toBeNull();

    expect(rowEl(dock, 'check:arch')?.querySelector('.acp-rails-dock__outcome--fail')?.textContent).toBe('FAIL');
    expect(rowEl(dock, 'check:typecheck')?.textContent).toBe('typecheckPASS1.2s');

    const row = rowEl(dock, `finding:${finding.key}`);
    expect(row?.querySelector('.acp-rails-dock__rule')?.textContent).toBe('0008#2');
    expect(row?.querySelector('.acp-rails-dock__loc')?.textContent).toBe('src/acp/bus.ts:12');
    expect(row?.querySelector('.acp-rails-dock__tag')?.textContent).toBe('new');
    expect(row?.querySelector('.acp-rails-dock__note')?.textContent).toBe('payload carries a class instance');

    expect(rowEl(dock, 'rules')?.textContent).toBe('2 rules · 1 enforced▸');
    expect(rowEl(dock, 'uncovered')?.textContent).toBe('1 source without rails');

    const stale = rowEl(dock, 'run:20261027T130000Z-0000');
    expect(stale?.querySelector('.acp-rails-dock__glyph')?.textContent).toBe('✓');
    expect(stale?.querySelector('.acp-rails-dock__tag--stale')?.textContent).toBe('stale');
    expect(rowEl(dock, 'run:20261027T140200Z-ab12')?.querySelector('.acp-rails-dock__glyph')?.textContent).toBe('✗');
  });

  it('tags carried and earlier findings with their time or not re-checked', () => {
    const dock = mount();
    const open: TrackedFinding = { ...finding, status: 'open' };
    const carried: TrackedFinding = { ...finding, key: 'x\u0000y', file: 'y', line: null, status: 'not-rechecked' };
    dock.update(props(model({ history: [run({ open: [open, carried] })] })));

    expect(rowEl(dock, `finding:${finding.key}`)?.querySelector('.acp-rails-dock__tag')?.textContent)
      .toBe(`since ${localHhMm('2026-10-27T14:02:00Z')}`);
    const carriedRow = rowEl(dock, 'finding:x\u0000y');
    expect(carriedRow?.querySelector('.acp-rails-dock__tag')?.textContent).toBe('not re-checked');
    expect(carriedRow?.querySelector('.acp-rails-dock__loc')?.textContent).toBe('y');
  });

  it('moves the selected class without re-creating rows, scrolling only when the selection moves', () => {
    const dock = mount();
    dock.update(props(model({ selectedKey: 'head' })));
    const before = new Map(rowEls(dock).map((node) => [node.dataset.railsKey, node]));
    expect(rowEl(dock, 'head')?.classList.contains('acp-rails-dock__row--selected')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    dock.update(props(model({ selectedKey: 'check:arch' })));
    const after = rowEls(dock);
    expect(after.every((node) => before.get(node.dataset.railsKey) === node)).toBe(true);
    expect(after.filter((node) => node.classList.contains('acp-rails-dock__row--selected')).map((node) => node.dataset.railsKey))
      .toEqual(['check:arch']);
    expect(rowEl(dock, 'check:arch')?.getAttribute('aria-selected')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(rowEl(dock, 'check:arch'));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

    dock.update(props(model({ selectedKey: 'check:arch', mode: 'manual' })));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('shows expanded detail for keys in model.expanded and removes it on collapse', () => {
    const dock = mount();
    dock.update(props(model()));
    expect(rowEl(dock, 'check:arch')?.querySelector('pre')).toBeNull();

    dock.update(props(model({ expanded: new Set(['check:arch', 'run:20261027T140200Z-ab12']) })));
    const arch = rowEl(dock, 'check:arch');
    expect(arch?.classList.contains('acp-rails-dock__row--expanded')).toBe(true);
    expect(arch?.querySelector('pre')?.textContent).toBe('arch.test.ts:4 expected no import');
    expect(rowEl(dock, 'run:20261027T140200Z-ab12')?.querySelector('.acp-rails-dock__detail')?.textContent)
      .toContain('typecheck PASS 1.2s · arch FAIL 1.2s');

    dock.update(props(model({ expanded: new Set(['run:20261027T140200Z-ab12']) })));
    expect(rowEl(dock, 'check:arch')?.querySelector('pre')).toBeNull();
    expect(rowEl(dock, 'check:arch')?.classList.contains('acp-rails-dock__row--expanded')).toBe(false);
  });

  it('lists every rule when the rules row is expanded', () => {
    const dock = mount();
    dock.update(props(model({ expanded: new Set(['rules']) })));
    const rules = rowEls(dock).filter((node) => node.classList.contains('acp-rails-dock__row--rule'));
    expect(rules.map((node) => node.querySelector('.acp-rails-dock__rule')?.textContent)).toEqual(['0008#1', '0008#2']);
    expect(rules[0].querySelector('.acp-rails-dock__status')?.textContent).toBe('—');
  });

  it('lists each check command on its own row while the manifest is not trusted, and states why', () => {
    const dock = mount();
    dock.update(props(model({ progress: { kind: 'paused' }, snapshot: { ...snapshot, trust: 'changed' } })));
    const head = rowEl(dock, 'head');
    expect(head?.querySelector('.acp-rails-dock__state')?.textContent).toBe('changed since trust · 2 checks wait');
    expect(head?.querySelectorAll('p').length).toBe(1);
    const command = (key: string): string | null | undefined =>
      rowEl(dock, key)?.querySelector('.acp-rails-dock__cmd')?.textContent;
    expect(command('check:typecheck')).toBe('npx tsc --noEmit');
    expect(command('check:arch')).toBe('npx vitest run arch');

    // Expanded, the row shows the whole command in its detail instead.
    dock.update(props(model({ snapshot: { ...snapshot, trust: 'untrusted' }, expanded: new Set(['check:arch']) })));
    expect(head?.querySelector('.acp-rails-dock__state')?.textContent).toBe('not trusted · 2 checks wait');
    expect(command('check:arch')).toBeUndefined();
    expect(rowEl(dock, 'check:arch')?.querySelector('.acp-rails-dock__detail')?.textContent).toContain('npx vitest run arch');

    // Trusted: no command lines; a run in progress takes the state line.
    dock.update(props(model({ progress: { kind: 'checking', index: 2, total: 2, name: 'arch' } })));
    expect(command('check:typecheck')).toBeUndefined();
    expect(head?.querySelector('.acp-rails-dock__state')?.textContent).toBe('check 2/2 arch');
    expect(head?.querySelector('.acp-rails-dock__state')?.classList.contains('acp-rails-dock__progress')).toBe(true);
  });

  it('shows no rails with the #rails init hint for a manifest with no rules and no checks', () => {
    const dock = mount();
    const empty: RailsSnapshot = { ...snapshot, checks: [], rules: [], trust: 'untrusted', warnings: [] };
    dock.update(props(model({ snapshot: empty, history: [] })));
    const head = rowEl(dock, 'head');
    expect(head?.querySelector('.acp-rails-dock__pill')?.textContent).toBe('no rails');
    expect(head?.querySelector('.acp-rails-dock__hint')?.textContent).toBe('no rails yet · #rails init');

    dock.update(props(model({ snapshot: { ...empty, rules: snapshot.rules }, history: [] })));
    expect(head?.querySelector('.acp-rails-dock__pill')?.textContent).toBe('no runs');
    expect(head?.querySelector('.acp-rails-dock__state')?.textContent).toBe('not trusted · auto runs wait');
  });

  it('puts the manifest error on the state line and the whole of it behind Enter', () => {
    const dock = mount();
    const broken = { ...snapshot, error: 'rails.toml: version must be 1' };
    const history = [run({ checks: [], checksSkipped: true, verdict: 'findings' })];
    dock.update(props(model({ snapshot: broken, history })));
    const head = rowEl(dock, 'head');
    expect(head?.querySelector('.acp-rails-dock__state')?.textContent).toBe('rails.toml: version must be 1');
    expect(head?.querySelector('.acp-rails-dock__detail')).toBeNull();
    expect(head?.querySelector('.acp-rails-dock__pill')?.textContent).toBe('1 finding');
    expect(rowEl(dock, 'check:arch')?.querySelector('.acp-rails-dock__outcome')?.textContent).toBe('skipped');

    dock.update(props(model({ snapshot: broken, history, expanded: new Set(['head']) })));
    const detailEl = head?.querySelector('.acp-rails-dock__detail');
    expect(head?.querySelector('.acp-rails-dock__disclosure')?.textContent).toBe('▾');
    expect(detailEl?.querySelector('.acp-rails-dock__error')?.textContent).toBe('rails.toml: version must be 1');
    expect(detailEl?.textContent).toContain('manifest/repo/.krypton/rails.toml');
    expect(detailEl?.querySelector('.acp-rails-dock__warnings')?.textContent).toBe('check `lint` is never referenced');
    // The error is not repeated as a `state` line.
    expect(detailEl?.textContent).not.toContain('state');
  });

  it('shows a never-run check as not run and folds runs past the newest five', () => {
    const dock = mount();
    const runs = Array.from({ length: 7 }, (_unused, i) => run({ runId: `20261027T14000${i}Z-ab12`, checks: [] }));
    dock.update(props(model({ history: runs })));
    expect(rowEl(dock, 'check:arch')?.querySelector('.acp-rails-dock__outcome')?.textContent).toBe('not run');
    expect(rowEls(dock).filter((node) => node.classList.contains('acp-rails-dock__row--run'))).toHaveLength(5);
    expect(rowEl(dock, 'older')?.textContent).toBe('2 older runs▸');

    dock.update(props(model({ history: runs, expanded: new Set(['older']) })));
    expect(rowEls(dock).filter((node) => node.classList.contains('acp-rails-dock__row--run'))).toHaveLength(7);
    expect(rowEl(dock, 'older')?.textContent).toBe('2 older runs▾');
  });

  it('does not repaint when the model is unchanged, even as fresh equal objects', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dock = mount();
    dock.update(props(model({ selectedKey: 'head', expanded: new Set(['check:arch']) })));
    const children = rowEls(dock).map((node) => node.firstChild);

    dock.update(props(model({ selectedKey: 'head', expanded: new Set(['check:arch']), progress: { kind: 'idle' } })));
    expect(rowEls(dock).map((node) => node.firstChild)).toEqual(children);

    // A change that touches one row repaints that row only.
    dock.update(props(model({ selectedKey: 'check:typecheck', expanded: new Set(['check:arch']) })));
    const repainted = rowEls(dock)
      .filter((node, i) => node.firstChild !== children[i])
      .map((node) => node.dataset.railsKey);
    expect(repainted).toEqual(['head', 'check:typecheck']);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('reports a clicked row through onSelectRow', () => {
    const onSelectRow = vi.fn();
    const dock = mount();
    dock.update(props(model(), { onSelectRow }));
    rowEl(dock, `finding:${finding.key}`)?.querySelector('.acp-rails-dock__note')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(onSelectRow).toHaveBeenCalledWith(`finding:${finding.key}`);
  });

  it('removes its content from the root on dispose', () => {
    const root = document.createElement('aside');
    const dock = new RailsDock(root);
    dock.update(props(model()));
    dock.dispose();
    expect(root.childElementCount).toBe(0);
  });

  // Spec 344 — the Actions bar.

  it('puts the Actions bar between the listbox and the key hints, outside the rows', () => {
    const dock = mount();
    dock.update(props(model()));

    const content = dock.el.querySelector('.acp-rails-dock');
    expect([...(content?.children ?? [])].map((node) => node.className))
      .toEqual(['acp-rails-dock__rows', 'acp-rails-dock__actions', 'acp-rails-dock__keys']);
    const bar = dock.el.querySelector('.acp-rails-dock__actions');
    expect(bar?.getAttribute('role')).toBe('group');
    expect(bar?.querySelector('.acp-rails-dock__lane-line')?.textContent).toBe('lane codex-1 · idle');
    expect([...(bar?.querySelectorAll('button') ?? [])].map((node) => node.textContent))
      .toEqual(['Run', 'Send', 'Trust✓ trusted', 'Update']);
    expect(actionButton(dock, 'trust').className).toBe('acp-dock-action acp-dock-action--done');
  });

  it('reports a clicked action, but not a disabled one or the second click of a double click', () => {
    const onAction = vi.fn();
    const onSelectRow = vi.fn();
    const dock = mount();
    dock.update(props(model(), { onAction, onSelectRow }));

    actionButton(dock, 'send').querySelector('.acp-dock-action__label')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 }),
    );
    actionButton(dock, 'send').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    expect(onAction.mock.calls).toEqual([['send']]);
    expect(onSelectRow).not.toHaveBeenCalled();

    dock.update(props(model(), { onAction, actions: actions({ activeLane: { ...IDLE_LANE, status: 'busy' } }) }));
    expect(actionButton(dock, 'update').disabled).toBe(true);
    expect(actionButton(dock, 'update').title).toBe('codex-1 is busy');
    actionButton(dock, 'update').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(onAction.mock.calls).toEqual([['send']]);
  });

  it('repaints the buttons, not the rows, when only the lane changes', () => {
    const dock = mount();
    const m = model();
    dock.update(props(m));
    const children = rowEls(dock).map((node) => node.firstChild);

    dock.update(props(m, { actions: actions({ activeLane: { ...IDLE_LANE, status: 'busy' }, updateLane: 'codex-1' }) }));

    expect(rowEls(dock).map((node) => node.firstChild)).toEqual(children);
    expect(dock.el.querySelector('.acp-rails-dock__lane-line')?.textContent).toBe('lane codex-1 · busy');
    expect(actionButton(dock, 'update').className).toBe('acp-dock-action acp-dock-action--running');
    expect(actionButton(dock, 'update').textContent).toBe('Updaterunning · codex-1');
  });
});
