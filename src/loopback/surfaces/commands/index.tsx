// Spec 185 (+ spec 341) — the built-in `#` command reference. One fetch of
// `/commands.json`, no polling: the manifest only changes with a new build,
// pushed by the frontend at harness register. Master/detail: pick a command on
// the left, read its full injected system prompt on the right.
// Spec 361: a React page; the filter's `/` is bound by the page so it stays
// first in `?` help even though the box mounts after the fetch.

import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import type { CommandCategory, CommandManifestEntry } from '../../../acp/hash-commands';
import {
  Banner,
  Button,
  copyText,
  EmptyState,
  fetchJson,
  HttpError,
  KbdHints,
  matchesQuery,
  Pill,
  RosterList,
  SearchFilter,
  StatBar,
  useBanner,
  useKeymap,
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

const HINTS: readonly (readonly [string, string])[] = [
  ['↑ ↓ / j k', 'navigate'],
  ['/', 'search'],
  ['c', 'copy prompt'],
];

type Load = { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ok'; readonly commands: readonly CommandManifestEntry[] };

/** The prompt as text with each `<placeholder>` in an accent span. */
export function promptNodes(prompt: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of prompt.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at > last) out.push(prompt.slice(last, at));
    out.push(
      <span key={at} className="lb-commands__ph">
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < prompt.length) out.push(prompt.slice(last));
  return out;
}

function CommandRow({ c }: { readonly c: CommandManifestEntry }): JSX.Element {
  return (
    <>
      <span
        className={c.prompt ? 'lb-commands__pdot lb-commands__pdot--on' : 'lb-commands__pdot'}
        title={c.prompt ? 'has an injected system prompt' : undefined}
        aria-hidden="true"
      />
      <span className="lb-commands__name" title={c.description}>{`#${c.name}`}</span>
    </>
  );
}

function Detail({ c, onCopy }: { readonly c: CommandManifestEntry | null; readonly onCopy: () => void }): JSX.Element {
  if (!c) return <p className="lb-commands__no-prompt">select a command on the left</p>;
  const badges = [
    ...c.badges.map((b) => <Pill key={`b:${b}`} label={BADGES[b]?.label ?? b} tone={BADGES[b]?.tone ?? 'muted'} />),
    c.alias ? <Pill key="alias" label={`alias #${c.alias}`} tone="muted" /> : null,
    c.lanes ? <Pill key="lanes" label={c.lanes} tone="muted" /> : null,
  ].filter((node) => node !== null);
  return (
    <>
      <header className="lb-commands__head">
        <h2 className="lb-commands__title">
          {`#${c.name}`}
          {c.args ? <span className="lb-commands__args">{` ${c.args}`}</span> : null}
        </h2>
        <p className="lb-commands__desc">{c.description}</p>
        {badges.length > 0 ? <div className="lb-commands__badges">{badges}</div> : null}
        {c.anatomy ? (
          <p className="lb-commands__anatomy">
            {c.anatomy.split('→').flatMap((part, i) =>
              i === 0
                ? [part]
                : [
                    <span key={`s${i}`} className="lb-commands__sep">
                      →
                    </span>,
                    part,
                  ],
            )}
          </p>
        ) : null}
      </header>
      {c.prompt ? (
        <>
          <div className="lb-commands__prompt-label">
            <span>injected system prompt</span>
            <Button label="copy" variant="ghost" kbd="c" onClick={onCopy} />
          </div>
          <pre className="lb-code lb-code--wrap lb-commands__prompt">{promptNodes(c.prompt)}</pre>
        </>
      ) : (
        <p className="lb-commands__no-prompt">
          no injected system prompt —
          <br />
          the composer dispatches this command directly
        </p>
      )}
      <KbdHints entries={HINTS} note="<token> = placeholder arg" />
    </>
  );
}

export function CommandsPage(): JSX.Element {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const banner = useBanner();

  useEffect(() => {
    let live = true;
    const apply = (commands: readonly CommandManifestEntry[]): void => {
      if (!live) return;
      setLoad({ kind: 'ok', commands });
      // Default to the first command that carries a prompt (the review target).
      if (commands.length > 0) setSelected((commands.find((c) => c.prompt) ?? commands[0]).name);
    };
    fetchJson<{ commands?: CommandManifestEntry[] }>('/commands.json').then(
      (data) => apply(data.commands ?? []),
      (error: unknown) => {
        // A non-2xx answer reads as "no manifest", as the old page did.
        if (error instanceof HttpError) apply([]);
        else if (live) setLoad({ kind: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const commands = load.kind === 'ok' ? load.commands : [];
  const trimmed = query.trim();
  const groups = SECTIONS.map((section) => ({
    ...section,
    items: commands.filter(
      (c) => c.category === section.id && matchesQuery(`${c.name} ${c.args} ${c.description} ${c.alias ?? ''}`, trimmed),
    ),
  }));
  /** Flat filtered names in section order — what `j`/`k` walk. */
  const visible = groups.flatMap((g) => g.items.map((c) => c.name));
  const current = commands.find((c) => c.name === selected) ?? null;

  const copyPrompt = async (): Promise<void> => {
    const prompt = current?.prompt;
    if (!prompt) return;
    if (await copyText(prompt)) banner.show('system prompt copied', 'ok', 1200);
    else banner.show('copy failed — select the prompt and copy it by hand', 'error', 2400);
  };

  const step = (delta: number): void => {
    if (visible.length === 0) return;
    const index = selected === null ? -1 : visible.indexOf(selected);
    const next = index === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, index + delta));
    setSelected(visible[next]);
  };

  useKeymap([
    {
      key: '/',
      label: 'Focus the filter',
      group: 'Page',
      run: () => {
        input.current?.focus();
        input.current?.select();
      },
    },
    { key: ['j', 'ArrowDown'], label: 'Next command', run: () => step(1) },
    { key: ['k', 'ArrowUp'], label: 'Previous command', run: () => step(-1) },
    {
      key: 'c',
      label: 'Copy the selected system prompt',
      run: () => {
        if (!current?.prompt) return false;
        void copyPrompt();
      },
    },
  ]);

  let body: ReactNode;
  if (load.kind === 'loading') body = <EmptyState text="loading…" />;
  else if (load.kind === 'error') body = <EmptyState text="could not load /commands.json — is the harness running?" />;
  else if (commands.length === 0) {
    body = (
      <EmptyState text={NO_MANIFEST}>
        <p className="lb-empty__text">{NO_MANIFEST_HINT}</p>
      </EmptyState>
    );
  } else {
    body = (
      <div className="lb-split lb-commands__split">
        <nav className="lb-panel lb-commands__list" aria-label="Commands">
          <div className="lb-commands__search">
            <SearchFilter
              placeholder="filter commands…"
              escape="leave"
              slashKey={false}
              value={query}
              onChange={setQuery}
              inputRef={input}
              count={trimmed ? `${visible.length} shown` : ''}
            />
          </div>
          <div className="lb-commands__items">
            {groups.map((group) => (
              <section key={group.id} className="lb-commands__group" hidden={group.items.length === 0}>
                <h2 className="lb-h3">{group.title}</h2>
                <RosterList<CommandManifestEntry>
                  label={group.title}
                  items={group.items}
                  selected={selected}
                  itemKey={(c) => c.name}
                  keys={false}
                  render={(c) => <CommandRow c={c} />}
                  onSelect={(c) => setSelected(c.name)}
                />
              </section>
            ))}
            <p className="lb-commands__no-hits" hidden={visible.length > 0}>{`no command matches “${trimmed}”`}</p>
          </div>
        </nav>
        <section className="lb-panel lb-commands__detail" aria-live="polite">
          <Detail c={current} onCopy={() => void copyPrompt()} />
        </section>
      </div>
    );
  }

  return (
    <div className="lb-page lb-page--split lb-page--fill lb-commands">
      <div className="lb-commands__bar">
        <p className="lb-commands__sub">krypton acp harness · composer palette reference</p>
        <StatBar
          align="end"
          stats={
            commands.length > 0
              ? [
                  { key: 'commands', label: 'commands', value: commands.length },
                  { key: 'workflows', label: 'workflows', value: commands.filter((c) => c.badges.includes('workflow')).length },
                  { key: 'prompts', label: 'system prompts', value: commands.filter((c) => c.prompt).length },
                ]
              : []
          }
        />
      </div>
      <Banner {...banner.props} />
      <div className="lb-commands__body">{body}</div>
    </div>
  );
}
