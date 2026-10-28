import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { railsDockRows } from '../../rails/rows';
import type {
  RailsCheckResult,
  RailsDockModel,
  RailsRunRecord,
  RailsSnapshot,
  TrackedFinding,
} from '../../rails/types';
import { RailsDock, localHhMm } from './index';

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
    dock.update({ model: m });

    expect(dock.el.querySelector('.acp-rails-dock')).not.toBeNull();
    expect(rowEls(dock).map((node) => node.dataset.railsKey)).toEqual(railsDockRows(m).map((row) => row.key));
    expect([...dock.el.querySelectorAll('.acp-rails-dock__section-label')].map((node) => node.textContent))
      .toEqual(['checks', 'findings', 'rules', 'runs']);
    expect(dock.el.querySelector('.acp-rails-dock__keys')?.textContent)
      .toBe('j/k · ↵ · 1–5 · s send · r run · [ ] tab · esc');
  });

  it('paints the head, check, finding, rules and run rows from their data', () => {
    const dock = mount();
    dock.update({ model: model() });

    const head = rowEl(dock, 'head');
    expect(head?.querySelector('.acp-rails-dock__eyebrow')?.textContent).toBe('RAILS');
    expect(head?.querySelector('.acp-rails-dock__pill--check_failed')?.textContent).toBe('CHECK FAILED');
    expect(head?.querySelector('.acp-rails-dock__time')?.textContent).toBe(localHhMm('2026-10-27T14:02:00Z'));
    expect(head?.querySelector('.acp-rails-dock__meta')?.textContent).toBe('auto run · codex-1 · trusted · mode auto');
    expect(head?.querySelector('.acp-rails-dock__warnings')?.textContent).toBe('check `lint` is never referenced');
    expect(head?.querySelector('.acp-rails-dock__progress')).toBeNull();

    expect(rowEl(dock, 'check:arch')?.querySelector('.acp-rails-dock__outcome--fail')?.textContent).toBe('FAIL');
    expect(rowEl(dock, 'check:typecheck')?.textContent).toBe('typecheckPASS1.2s');

    const row = rowEl(dock, `finding:${finding.key}`);
    expect(row?.querySelector('.acp-rails-dock__rule')?.textContent).toBe('0008#2');
    expect(row?.querySelector('.acp-rails-dock__loc')?.textContent).toBe('src/acp/bus.ts:12');
    expect(row?.querySelector('.acp-rails-dock__tag')?.textContent).toBe('new');
    expect(row?.querySelector('.acp-rails-dock__note')?.textContent).toBe('payload carries a class instance');

    expect(rowEl(dock, 'rules')?.textContent).toContain('2 rules · 1 enforced · 1 judge-only');
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
    dock.update({ model: model({ history: [run({ open: [open, carried] })] }) });

    expect(rowEl(dock, `finding:${finding.key}`)?.querySelector('.acp-rails-dock__tag')?.textContent)
      .toBe(`since ${localHhMm('2026-10-27T14:02:00Z')}`);
    const carriedRow = rowEl(dock, 'finding:x\u0000y');
    expect(carriedRow?.querySelector('.acp-rails-dock__tag')?.textContent).toBe('not re-checked');
    expect(carriedRow?.querySelector('.acp-rails-dock__loc')?.textContent).toBe('y');
  });

  it('moves the selected class without re-creating rows, scrolling only when the selection moves', () => {
    const dock = mount();
    dock.update({ model: model({ selectedKey: 'head' }) });
    const before = new Map(rowEls(dock).map((node) => [node.dataset.railsKey, node]));
    expect(rowEl(dock, 'head')?.classList.contains('acp-rails-dock__row--selected')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    dock.update({ model: model({ selectedKey: 'check:arch' }) });
    const after = rowEls(dock);
    expect(after.every((node) => before.get(node.dataset.railsKey) === node)).toBe(true);
    expect(after.filter((node) => node.classList.contains('acp-rails-dock__row--selected')).map((node) => node.dataset.railsKey))
      .toEqual(['check:arch']);
    expect(rowEl(dock, 'check:arch')?.getAttribute('aria-selected')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.contexts[1]).toBe(rowEl(dock, 'check:arch'));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

    dock.update({ model: model({ selectedKey: 'check:arch', mode: 'manual' }) });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('shows expanded detail for keys in model.expanded and removes it on collapse', () => {
    const dock = mount();
    dock.update({ model: model() });
    expect(rowEl(dock, 'check:arch')?.querySelector('pre')).toBeNull();

    dock.update({ model: model({ expanded: new Set(['check:arch', 'run:20261027T140200Z-ab12']) }) });
    const arch = rowEl(dock, 'check:arch');
    expect(arch?.classList.contains('acp-rails-dock__row--expanded')).toBe(true);
    expect(arch?.querySelector('pre')?.textContent).toBe('arch.test.ts:4 expected no import');
    expect(rowEl(dock, 'run:20261027T140200Z-ab12')?.querySelector('.acp-rails-dock__detail')?.textContent)
      .toContain('typecheck PASS 1.2s · arch FAIL 1.2s');

    dock.update({ model: model({ expanded: new Set(['run:20261027T140200Z-ab12']) }) });
    expect(rowEl(dock, 'check:arch')?.querySelector('pre')).toBeNull();
    expect(rowEl(dock, 'check:arch')?.classList.contains('acp-rails-dock__row--expanded')).toBe(false);
  });

  it('lists every rule when the rules row is expanded', () => {
    const dock = mount();
    dock.update({ model: model({ expanded: new Set(['rules']) }) });
    const rules = rowEls(dock).filter((node) => node.classList.contains('acp-rails-dock__row--rule'));
    expect(rules.map((node) => node.querySelector('.acp-rails-dock__rule')?.textContent)).toEqual(['0008#1', '0008#2']);
    expect(rules[0].querySelector('.acp-rails-dock__status')?.textContent).toBe('—');
  });

  it('lists every check argv whenever the manifest is not trusted, naming changed vs untrusted', () => {
    const dock = mount();
    dock.update({ model: model({ progress: { kind: 'paused' }, snapshot: { ...snapshot, trust: 'changed' } }) });
    const head = rowEl(dock, 'head');
    expect(head?.querySelector('.acp-rails-dock__progress')?.textContent).toBe('auto run paused at trust');
    expect(head?.querySelector('.acp-rails-dock__trust')?.textContent)
      .toBe('rails.toml changed since trust — checks wait for #rails trust');
    expect([...(head?.querySelectorAll('.acp-rails-dock__argv li') ?? [])].map((node) => node.textContent))
      .toEqual(['typechecknpx tsc --noEmit', 'archnpx vitest run arch']);

    // Not paused, manual mode: still listed while untrusted.
    dock.update({ model: model({ mode: 'manual', snapshot: { ...snapshot, trust: 'untrusted' } }) });
    expect(head?.querySelector('.acp-rails-dock__progress')).toBeNull();
    expect(head?.querySelector('.acp-rails-dock__trust')?.textContent)
      .toBe('rails.toml not trusted — checks wait for #rails trust');
    expect(head?.querySelectorAll('.acp-rails-dock__argv li').length).toBe(2);

    dock.update({ model: model({ progress: { kind: 'checking', index: 2, total: 2, name: 'arch' } }) });
    expect(head?.querySelector('.acp-rails-dock__argv')).toBeNull();
    expect(head?.querySelector('.acp-rails-dock__trust')).toBeNull();
    expect(head?.querySelector('.acp-rails-dock__progress')?.textContent).toBe('check 2/2 arch');
  });

  it('shows no rails with the #rails init hint for a manifest with no rules and no checks', () => {
    const dock = mount();
    const empty: RailsSnapshot = { ...snapshot, checks: [], rules: [], trust: 'untrusted', warnings: [] };
    dock.update({ model: model({ snapshot: empty, history: [] }) });
    const head = rowEl(dock, 'head');
    expect(head?.querySelector('.acp-rails-dock__pill')?.textContent).toBe('no rails');
    expect(head?.querySelector('.acp-rails-dock__hint')?.textContent).toContain('#rails init');
    expect(head?.querySelector('.acp-rails-dock__trust')).toBeNull();

    dock.update({ model: model({ snapshot: { ...empty, rules: snapshot.rules }, history: [] }) });
    expect(head?.querySelector('.acp-rails-dock__pill')?.textContent).toBe('no runs');
    expect(head?.querySelector('.acp-rails-dock__hint')).toBeNull();
  });

  it('shows the manifest error and marks skipped checks', () => {
    const dock = mount();
    dock.update({
      model: model({
        snapshot: { ...snapshot, error: 'rails.toml: version must be 1' },
        history: [run({ checks: [], checksSkipped: true, verdict: 'findings' })],
      }),
    });
    expect(rowEl(dock, 'head')?.querySelector('.acp-rails-dock__error')?.textContent).toBe('rails.toml: version must be 1');
    expect(rowEl(dock, 'head')?.querySelector('.acp-rails-dock__pill')?.textContent).toBe('1 finding');
    expect(rowEl(dock, 'check:arch')?.querySelector('.acp-rails-dock__outcome')?.textContent).toBe('skipped');
  });

  it('does not repaint when the model is unchanged, even as fresh equal objects', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dock = mount();
    dock.update({ model: model({ selectedKey: 'head', expanded: new Set(['check:arch']) }) });
    const children = rowEls(dock).map((node) => node.firstChild);

    dock.update({ model: model({ selectedKey: 'head', expanded: new Set(['check:arch']), progress: { kind: 'idle' } }) });
    expect(rowEls(dock).map((node) => node.firstChild)).toEqual(children);

    // A change that touches one row repaints that row only.
    dock.update({ model: model({ selectedKey: 'check:typecheck', expanded: new Set(['check:arch']) }) });
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
    dock.update({ model: model(), onSelectRow });
    rowEl(dock, `finding:${finding.key}`)?.querySelector('.acp-rails-dock__note')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(onSelectRow).toHaveBeenCalledWith(`finding:${finding.key}`);
  });

  it('removes its content from the root on dispose', () => {
    const root = document.createElement('aside');
    const dock = new RailsDock(root);
    dock.update({ model: model() });
    dock.dispose();
    expect(root.childElementCount).toBe(0);
  });
});
