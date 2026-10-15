import { afterEach, describe, expect, it } from 'vitest';

import { TriageOverlay } from '../triage-overlay';
import {
  OrchestratorConsole,
  type OrchestratorConsoleProps,
  type OrchestratorInputLine,
  type OrchestratorSeatCard,
} from './index';

const consoles: { dispose(): void }[] = [];

const card = (over: Partial<OrchestratorSeatCard> & { id: string }): OrchestratorSeatCard => ({
  displayName: over.id,
  status: 'idle',
  statusLabel: 'idle',
  meta: 'Claude Code · sonnet-4-6',
  isSeat: false,
  isSelected: false,
  tags: [],
  ...over,
});

const line = (over: Partial<OrchestratorInputLine> = {}): OrchestratorInputLine => ({
  label: 'dispatch → codex-1',
  active: false,
  draft: '',
  placeholder: 'type a task · Enter send · Esc cancel',
  disabledReason: null,
  hint: 'press d to dispatch to codex-1',
  ...over,
});

const props = (over: Partial<OrchestratorConsoleProps> = {}): OrchestratorConsoleProps => ({
  open: true,
  seatName: 'claude-1',
  summary: '2 lanes · 1 busy · 0 awaiting · 0 flags',
  cards: [card({ id: 'claude-1', isSeat: true }), card({ id: 'codex-1', isSelected: true })],
  permissions: [],
  permStepHint: '',
  feed: [{ who: '→ codex-1', text: 'check the deps tuple' }],
  feedEmpty: null,
  dispatch: line(),
  seatPrompt: line({ label: 'prompt → claude-1', hint: 'press i to prompt claude-1' }),
  keyLegend: 'j/k select · Enter jump · d dispatch · Esc close',
  ...over,
});

const mount = (over: Partial<OrchestratorConsoleProps> = {}): OrchestratorConsole => {
  const node = new OrchestratorConsole();
  consoles.push(node);
  node.update(props(over));
  return node;
};

afterEach(() => {
  for (const node of consoles.splice(0)) node.dispose();
});

describe('OrchestratorConsole', () => {
  it('emits the head, the three regions and the seat grid', () => {
    const node = mount();
    expect(node.el.className).toBe('acp-harness__orchestrator-overlay');
    expect(node.el.querySelector('.acp-orchestrator__title')?.textContent).toBe('Orchestrator console');
    expect(node.el.querySelector('.acp-orchestrator__seat')?.textContent).toBe('claude-1');
    expect(node.el.querySelector('.acp-orchestrator__sub')?.textContent)
      .toBe('2 lanes · 1 busy · 0 awaiting · 0 flags');
    expect([...node.el.querySelectorAll<HTMLElement>('.acp-orchestrator__region')]
      .map((region) => region.dataset.region)).toEqual(['lanes', 'feed', 'reserved']);
    const cards = [...node.el.querySelectorAll<HTMLElement>('.acp-orchestrator__card')];
    expect(cards.map((c) => c.dataset.orchLane)).toEqual(['claude-1', 'codex-1']);
    expect(cards[0].className).toBe('acp-orchestrator__card acp-orchestrator__card--seat');
    expect(cards[1].className).toBe('acp-orchestrator__card acp-orchestrator__card--selected');
    expect(cards[0].querySelector('.acp-orchestrator__card-status')?.className)
      .toBe('acp-orchestrator__card-status acp-orchestrator__card-status--idle');
    expect(cards[0].querySelector('.acp-orchestrator__card-meta')?.textContent)
      .toBe('Claude Code · sonnet-4-6');
  });

  it('renders the card tags with their own classes, and drops the row when empty', () => {
    const node = mount({
      cards: [card({
        id: 'claude-1',
        isSeat: true,
        tags: [
          { kind: 'badge', text: '◆ orchestrator' },
          { kind: 'tag', text: 'inbox 2' },
          { kind: 'attn', text: '⚑ 1' },
          { kind: 'perm', text: '⚠ perm' },
        ],
      })],
    });
    expect([...node.el.querySelectorAll('.acp-orchestrator__tags > span')].map((s) => s.className))
      .toEqual([
        'acp-orchestrator__badge',
        'acp-orchestrator__tag',
        'acp-orchestrator__tag acp-orchestrator__tag--attn',
        'acp-orchestrator__tag acp-orchestrator__tag--perm',
      ]);
    node.update(props({ cards: [card({ id: 'claude-1', isSeat: true })] }));
    expect(node.el.querySelector('.acp-orchestrator__tags')).toBeNull();
  });

  it('does not rebuild the seat grid when the dispatch draft changes', () => {
    const node = mount();
    const cards = [...node.el.querySelectorAll('.acp-orchestrator__card')];
    const grid = node.el.querySelector('.acp-orchestrator__grid');

    node.update(props({ dispatch: line({ active: true, draft: 'r' }) }));
    node.update(props({ dispatch: line({ active: true, draft: 'ru' }) }));
    node.update(props({ dispatch: line({ active: true, draft: 'run' }) }));

    expect(node.el.querySelector('.acp-orchestrator__grid')).toBe(grid);
    expect([...node.el.querySelectorAll('.acp-orchestrator__card')]).toEqual(cards);
    expect(node.el.querySelector('.acp-orchestrator__dispatch-input')?.textContent).toBe('run');
  });

  it('paints the dispatch line as a hint, a disabled reason, or an open input', () => {
    const node = mount();
    const dispatch = node.el.querySelector<HTMLElement>('[data-region="dispatch"]');
    expect(dispatch?.className).toBe('acp-orchestrator__dispatch');
    expect(dispatch?.querySelector('.acp-orchestrator__dispatch-label')?.textContent)
      .toBe('dispatch → codex-1');
    expect(dispatch?.querySelector('.acp-orchestrator__dispatch-hint')?.textContent)
      .toBe('press d to dispatch to codex-1');

    node.update(props({ dispatch: line({ disabledReason: 'cannot dispatch to the seat' }) }));
    expect(dispatch?.querySelector('.acp-orchestrator__dispatch-disabled')?.textContent)
      .toBe('cannot dispatch to the seat');
    expect(dispatch?.querySelector('.acp-orchestrator__dispatch-hint')).toBeNull();

    node.update(props({
      dispatch: line({ active: true, draft: '', purposes: ['task', 'review'], activePurpose: 'review' }),
    }));
    expect(dispatch?.className).toBe('acp-orchestrator__dispatch acp-orchestrator__dispatch--active');
    expect([...(dispatch?.querySelectorAll('.acp-orchestrator__purpose') ?? [])].map((p) => p.className))
      .toEqual([
        'acp-orchestrator__purpose',
        'acp-orchestrator__purpose acp-orchestrator__purpose--active',
      ]);
    const input = dispatch?.querySelector('.acp-orchestrator__dispatch-input');
    expect(input?.firstElementChild?.className).toBe('acp-orchestrator__caret');
    expect(input?.querySelector('.acp-orchestrator__dispatch-placeholder')?.textContent)
      .toBe('type a task · Enter send · Esc cancel');
  });

  it('keeps the seat-prompt line separate from the dispatch line', () => {
    const node = mount();
    const prompt = node.el.querySelector<HTMLElement>('[data-region="seat-prompt"]');
    expect(prompt?.querySelector('.acp-orchestrator__dispatch-label')?.textContent)
      .toBe('prompt → claude-1');
    expect(prompt?.querySelector('.acp-orchestrator__dispatch-hint')?.textContent)
      .toBe('press i to prompt claude-1');
  });

  it('shows the permission band only while a lane is paused, focus row ringed', () => {
    const node = mount();
    expect(node.el.querySelector('.acp-orchestrator__permq')).toBeNull();
    node.update(props({
      permStepHint: ' · Tab next',
      permissions: [
        {
          laneId: 'codex-1',
          laneName: 'codex-1',
          label: 'Bash git push',
          more: 1,
          highRisk: true,
          focus: true,
          command: 'git push --force origin main',
        },
        { laneId: 'grok-1', laneName: 'grok-1', label: 'Read src', more: 0, highRisk: false, focus: false, command: '' },
      ],
    }));
    const band = node.el.querySelector<HTMLElement>('.acp-orchestrator__permq');
    expect(band?.dataset.region).toBe('permissions');
    expect(band?.querySelector('.acp-orchestrator__region-title')?.textContent)
      .toBe('Pending permissions · Tab next');
    const rows = [...node.el.querySelectorAll<HTMLElement>('.acp-orchestrator__perm')];
    expect(rows[0].className)
      .toBe('acp-orchestrator__perm acp-orchestrator__perm--focus acp-orchestrator__perm--highrisk');
    expect(rows[0].querySelector('.acp-orchestrator__perm-more')?.textContent).toBe('(+1 more)');
    expect(rows[0].querySelector('.acp-orchestrator__perm-command')?.textContent)
      .toBe('git push --force origin main');
    expect(rows[0].querySelector('.acp-orchestrator__perm-hint')?.textContent)
      .toBe('⚠ high-risk · a accept · A all · r reject · R all');
    expect(rows[1].className).toBe('acp-orchestrator__perm');
    expect(rows[1].querySelector('.acp-orchestrator__perm-hint')).toBeNull();
  });

  it('replaces the feed rows with the empty note and back', () => {
    const node = mount();
    expect(node.el.querySelector('.acp-orchestrator__feed-who')?.textContent).toBe('→ codex-1');
    node.update(props({ feed: [], feedEmpty: 'no coordination activity yet' }));
    expect(node.el.querySelector('.acp-orchestrator__feed')).toBeNull();
    expect(node.el.querySelector('[data-region="feed"] .acp-orchestrator__empty')?.textContent)
      .toBe('no coordination activity yet');
  });

  it('falls back to the no-lanes note with an empty fleet', () => {
    const node = mount({ cards: [] });
    expect(node.el.querySelector('.acp-orchestrator__grid')?.textContent).toBe('no lanes');
  });

  it('hides while closed, and closing it reopens nothing', () => {
    const node = mount({ open: false });
    expect(node.el.hidden).toBe(true);
    expect(node.isOpen).toBe(false);
  });

  it('closes the triage overlay when it opens', () => {
    const triage = new TriageOverlay();
    consoles.push(triage);
    let autoClosed = 0;
    triage.update({
      open: true,
      items: [],
      selectedIndex: 0,
      laneName: (id) => id,
      laneStats: () => null,
      redirect: null,
      silentPileCount: 0,
      onAutoClose: () => {
        autoClosed += 1;
      },
    });
    expect(triage.isOpen).toBe(true);
    const node = mount();
    expect(node.isOpen).toBe(true);
    expect(triage.isOpen).toBe(false);
    expect(triage.el.hidden).toBe(true);
    expect(autoClosed).toBe(1);
  });

  it('writes nothing when the dependency tuple holds', () => {
    const base = props();
    const node = new OrchestratorConsole();
    consoles.push(node);
    node.update(base);
    const observer = new MutationObserver(() => undefined);
    observer.observe(node.el, { childList: true, subtree: true, attributes: true, characterData: true });
    node.update(base);
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
