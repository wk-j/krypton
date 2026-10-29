// Spec 185 (+ spec 341) — the built-in `#` command reference. One fetch of
// `/commands.json`, no polling: the manifest only changes with a new build,
// pushed by the frontend at harness register. Master/detail: pick a command on
// the left, read its full injected system prompt on the right.

import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { CommandCategory, CommandManifestEntry } from '../../../acp/hash-commands';
import {
  Banner,
  button,
  copyText,
  emptyState,
  fetchJson,
  HttpError,
  kbdHints,
  keymap,
  matchesQuery,
  pill,
  RosterList,
  SearchFilter,
  StatBar,
} from '../../kit';
import type { Tone } from '../../kit';

import './commands.css';

const SECTIONS: readonly { readonly id: CommandCategory; readonly title: string }[] = [
  { id: 'session', title: 'Session & lane control' },
  { id: 'surface', title: 'Browser surfaces' },
  { id: 'agent', title: 'Orchestration & agent-driven' },
];

const BADGES: Readonly<Record<string, { readonly label: string; readonly tone: Tone }>> = {
  workflow: { label: 'workflow', tone: 'accent' },
  agent: { label: 'agent', tone: 'add' },
  hidden: { label: 'not in palette', tone: 'muted' },
};

/** `<placeholder>` tokens inside a prompt template (spec 185 accent tint). */
const PLACEHOLDER = /<[^<>&"\n]{1,48}?>/g;

const NO_MANIFEST = 'no command manifest yet — open an ACP harness in Krypton, then reload';
const NO_MANIFEST_HINT = '(if a harness is already open, its manifest push failed — check the app log)';

interface Group {
  readonly id: CommandCategory;
  readonly section: HTMLElement;
  readonly list: RosterList<CommandManifestEntry>;
}

/** The prompt as text nodes with each `<placeholder>` in an accent span. */
export function promptNodes(prompt: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let last = 0;
  for (const match of prompt.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at > last) out.push(prompt.slice(last, at));
    out.push(el('span', { class: 'lb-commands__ph', text: match[0] }));
    last = at + match[0].length;
  }
  if (last < prompt.length) out.push(prompt.slice(last));
  return out;
}

export class CommandsView {
  readonly el: HTMLElement;
  private readonly stats = new StatBar([], { align: 'end' });
  private readonly banner = new Banner();
  private readonly body = el('div', { class: 'lb-commands__body' }, emptyState('loading…'));
  private readonly detail = el('section', { class: ['lb-panel', 'lb-commands__detail'], attrs: { 'aria-live': 'polite' } });
  private readonly noHits = el('p', { class: 'lb-commands__no-hits', attrs: { hidden: true } });
  private readonly filter: SearchFilter;
  private readonly groups: Group[];
  private readonly bag = new DisposableBag();
  private commands: readonly CommandManifestEntry[] = [];
  /** Flat filtered names in section order — what `j`/`k` walk. */
  private visible: string[] = [];
  private selectedName: string | null = null;

  constructor() {
    this.filter = new SearchFilter({ placeholder: 'filter commands…', escape: 'leave', onInput: () => this.renderList() });
    this.groups = SECTIONS.map((section) => {
      const list = new RosterList<CommandManifestEntry>({
        label: section.title,
        key: (c) => c.name,
        keys: false,
        render: (c) => this.row(c),
        onSelect: (c) => this.select(c.name),
      });
      return {
        id: section.id,
        list,
        section: el('section', { class: 'lb-commands__group' }, el('h2', { class: 'lb-h3', text: section.title }), list.el),
      };
    });
    this.el = el(
      'div',
      { class: ['lb-page', 'lb-page--split', 'lb-page--fill', 'lb-commands'] },
      el(
        'div',
        { class: 'lb-commands__bar' },
        el('p', { class: 'lb-commands__sub', text: 'krypton acp harness · composer palette reference' }),
        this.stats.el,
      ),
      this.banner.el,
      this.body,
    );
    this.bag.add(
      keymap().bindAll([
        { key: ['j', 'ArrowDown'], label: 'Next command', run: () => this.step(1) },
        { key: ['k', 'ArrowUp'], label: 'Previous command', run: () => this.step(-1) },
        {
          key: 'c',
          label: 'Copy the selected system prompt',
          run: () => {
            if (!this.current()?.prompt) return false;
            void this.copyPrompt();
          },
        },
      ]),
    );
  }

  async load(): Promise<void> {
    try {
      const data = await fetchJson<{ commands?: CommandManifestEntry[] }>('/commands.json');
      this.render(data.commands ?? []);
    } catch (error) {
      // A non-2xx answer reads as "no manifest", as the old page did.
      if (error instanceof HttpError) this.render([]);
      else this.body.replaceChildren(emptyState('could not load /commands.json — is the harness running?'));
    }
  }

  selected(): string | null {
    return this.selectedName;
  }

  dispose(): void {
    this.bag.dispose();
    this.filter.dispose();
    this.banner.dispose();
    for (const group of this.groups) group.list.dispose();
  }

  private render(commands: readonly CommandManifestEntry[]): void {
    if (commands.length === 0) {
      this.body.replaceChildren(emptyState(NO_MANIFEST, el('p', { class: 'lb-empty__text', text: NO_MANIFEST_HINT })));
      return;
    }
    this.commands = commands;
    this.body.replaceChildren(
      el(
        'div',
        { class: ['lb-split', 'lb-commands__split'] },
        el(
          'nav',
          { class: ['lb-panel', 'lb-commands__list'], attrs: { 'aria-label': 'Commands' } },
          el('div', { class: 'lb-commands__search' }, this.filter.el),
          el('div', { class: 'lb-commands__items' }, ...this.groups.map((g) => g.section), this.noHits),
        ),
        this.detail,
      ),
    );
    // Default to the first command that carries a prompt (the review target).
    this.selectedName = (commands.find((c) => c.prompt) ?? commands[0]).name;
    this.renderList();
    this.renderDetail();
    this.stats.update([
      { key: 'commands', label: 'commands', value: commands.length },
      { key: 'workflows', label: 'workflows', value: commands.filter((c) => c.badges.includes('workflow')).length },
      { key: 'prompts', label: 'system prompts', value: commands.filter((c) => c.prompt).length },
    ]);
  }

  private row(c: CommandManifestEntry): DocumentFragment {
    const frag = document.createDocumentFragment();
    frag.append(
      el('span', {
        class: ['lb-commands__pdot', c.prompt && 'lb-commands__pdot--on'],
        title: c.prompt ? 'has an injected system prompt' : undefined,
        attrs: { 'aria-hidden': 'true' },
      }),
      el('span', { class: 'lb-commands__name', text: `#${c.name}`, title: c.description }),
    );
    return frag;
  }

  private renderList(): void {
    const query = this.filter.query.trim();
    this.visible = [];
    for (const group of this.groups) {
      const items = this.commands.filter(
        (c) => c.category === group.id && matchesQuery(`${c.name} ${c.args} ${c.description} ${c.alias ?? ''}`, query),
      );
      this.visible.push(...items.map((c) => c.name));
      group.list.setItems(items);
      group.list.select(this.selectedName, false);
      group.section.hidden = items.length === 0;
    }
    this.noHits.textContent = `no command matches “${query}”`;
    this.noHits.hidden = this.visible.length > 0;
    this.filter.setCount(query ? `${this.visible.length} shown` : '');
  }

  private current(): CommandManifestEntry | null {
    return this.commands.find((c) => c.name === this.selectedName) ?? null;
  }

  private select(name: string): void {
    if (name === this.selectedName) return;
    this.selectedName = name;
    for (const group of this.groups) group.list.select(name, false);
    this.renderDetail();
  }

  private step(delta: number): void {
    if (this.visible.length === 0) return;
    const index = this.selectedName === null ? -1 : this.visible.indexOf(this.selectedName);
    const next = index === -1 ? 0 : Math.min(this.visible.length - 1, Math.max(0, index + delta));
    this.select(this.visible[next]);
  }

  private async copyPrompt(): Promise<void> {
    const prompt = this.current()?.prompt;
    if (!prompt) return;
    if (await copyText(prompt)) this.banner.show('system prompt copied', 'ok', 1200);
    else this.banner.show('copy failed — select the prompt and copy it by hand', 'error', 2400);
  }

  private renderDetail(): void {
    const c = this.current();
    if (!c) {
      this.detail.replaceChildren(el('p', { class: 'lb-commands__no-prompt', text: 'select a command on the left' }));
      return;
    }
    const badges = [
      ...c.badges.map((b) => pill(BADGES[b]?.label ?? b, BADGES[b]?.tone ?? 'muted')),
      c.alias ? pill(`alias #${c.alias}`, 'muted') : null,
      c.lanes ? pill(c.lanes, 'muted') : null,
    ].filter((node): node is HTMLSpanElement => node !== null);

    const head = el(
      'header',
      { class: 'lb-commands__head' },
      el(
        'h2',
        { class: 'lb-commands__title' },
        `#${c.name}`,
        c.args ? el('span', { class: 'lb-commands__args', text: ` ${c.args}` }) : null,
      ),
      el('p', { class: 'lb-commands__desc', text: c.description }),
      badges.length > 0 ? el('div', { class: 'lb-commands__badges' }, ...badges) : null,
      c.anatomy
        ? el(
            'p',
            { class: 'lb-commands__anatomy' },
            ...c.anatomy
              .split('→')
              .flatMap((part, i) => (i === 0 ? [part] : [el('span', { class: 'lb-commands__sep', text: '→' }), part])),
          )
        : null,
    );

    const prompt = c.prompt
      ? [
          el(
            'div',
            { class: 'lb-commands__prompt-label' },
            el('span', { text: 'injected system prompt' }),
            button('copy', { variant: 'ghost', kbd: 'c', onClick: () => void this.copyPrompt() }),
          ),
          el('pre', { class: ['lb-code', 'lb-code--wrap', 'lb-commands__prompt'] }, ...promptNodes(c.prompt)),
        ]
      : [
          el(
            'p',
            { class: 'lb-commands__no-prompt' },
            'no injected system prompt —',
            el('br'),
            'the composer dispatches this command directly',
          ),
        ];

    this.detail.replaceChildren(
      head,
      ...prompt,
      kbdHints(
        [
          ['↑ ↓ / j k', 'navigate'],
          ['/', 'search'],
          ['c', 'copy prompt'],
        ],
        '<token> = placeholder arg',
      ),
    );
  }
}
