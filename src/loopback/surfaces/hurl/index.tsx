// Spec 227 / 237 — the Hurl web client: file roster, read-only highlighted
// source, run with live SSE output, Pretty / Raw / Headers response views,
// copy as curl / hurl command. Per-cwd state round-trips through `/state`.
// Spec 341 kit, spec 361 React: `HurlStore` runs the flows and paints a
// snapshot; this component renders it and binds the page keys.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';

import { highlightHurl } from '../../../hurl-highlight';
import { Banner, Button, Dot, KbdHints, RosterList, SearchFilter, StatBar, Tabs, useBanner, useKeymap } from '../../kit';
import type { RosterHandle, TabItem } from '../../kit';
import { ResponseBody } from './response';
import type { ResponseView } from './response';
import { useSplits } from './splits';
import { HurlStore, VIEWS } from './store';
import { renderRow, rowDeps, rowKey } from './tree';

import './hurl.css';

const MODES: readonly TabItem[] = [
  { id: 'files', label: 'Files' },
  { id: 'runs', label: 'History' },
];

const HINTS: readonly (readonly [string, string])[] = [
  ['j k', 'move'],
  ['h l Enter', 'fold'],
  ['r', 'run'],
  ['x', 'cancel'],
  ['1 2 3', 'pretty / raw / headers'],
  ['v', 'verbose'],
  ['E', 'env'],
  ['/', 'filter'],
  ['.', 'reload'],
  ['[ ]', 'files'],
  ['- =', 'source'],
  ['y', 'copy body'],
  ['c', 'curl'],
  ['H', 'hurl'],
];

/** `/hurl/<token>` → `<token>`. */
export function hurlToken(pathname: string): string {
  return pathname.split('/').filter(Boolean)[1] ?? '';
}

export function HurlPage(): JSX.Element {
  return <HurlView token={hurlToken(location.pathname)} />;
}

export function HurlView({ token }: { readonly token: string }): JSX.Element {
  const banner = useBanner();
  const [store] = useState(() => new HurlStore(token, { show: banner.show, hide: banner.hide }));
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const roster = useRef<RosterHandle>(null);
  const sourceEl = useRef<HTMLPreElement>(null);
  const viewportEl = useRef<HTMLDivElement>(null);
  const focusPane = useRef<'source' | 'response'>('source');

  useEffect(() => store.mount(), [store]);

  useEffect(() => {
    const flush = (): void => store.flushPersist();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [store]);

  useKeymap([
    { key: '.', label: 'Reload listing and source', run: () => void store.reloadFiles() },
    { key: ['j', 'ArrowDown'], label: 'Next row', when: () => store.hasRows(), run: () => roster.current?.move(1) },
    { key: ['k', 'ArrowUp'], label: 'Previous row', when: () => store.hasRows(), run: () => roster.current?.move(-1) },
    { key: 'h', label: 'Collapse folder', run: () => store.collapseAtCursor() },
    { key: 'l', label: 'Expand folder', run: () => store.expandAtCursor() },
    { key: 'Enter', label: 'Toggle folder / run file', run: () => store.enter() },
    { key: 'r', label: 'Run', run: () => void store.runSelected() },
    { key: 'x', label: 'Cancel the run', run: () => void store.cancelRun() },
    {
      key: ['1', '2', '3'],
      display: '1 / 2 / 3',
      label: 'Pretty / raw / headers',
      run: (event) => store.setView(VIEWS[Number(event.key) - 1].id),
    },
    {
      key: 'o',
      label: 'Switch focus source / response',
      run: () => {
        focusPane.current = focusPane.current === 'source' ? 'response' : 'source';
        (focusPane.current === 'source' ? sourceEl : viewportEl).current?.focus();
      },
    },
    { key: 'v', label: 'Toggle --verbose', run: () => store.toggleVerbose('v') },
    { key: 'V', label: 'Toggle --very-verbose', run: () => store.toggleVerbose('vv') },
    { key: 'E', label: 'Next variables file', run: () => store.cycleEnv() },
    { key: 'c', label: 'Copy as curl', run: () => void store.copyCurl() },
    { key: 'H', label: 'Copy hurl command', run: () => void store.copyHurlCli() },
    { key: 'y', label: 'Copy response body', run: () => void store.copyBody() },
  ]);
  // After the page keys: a focused separator's arrows must win over j/k/↑/↓.
  const splits = useSplits();
  const applySplits = splits.apply;
  useEffect(() => {
    if (s.ready) applySplits();
  }, [s.ready, applySplits]);

  const { source } = s;
  // highlightHurl escapes every source character it emits.
  const sourceHtml = useMemo(
    () => (source.kind === 'code' && source.text ? highlightHurl(source.text, source.vars, { substitute: source.substitute }) : ''),
    [source],
  );
  const running = s.runState === 'running';

  return (
    <div className="lb-page lb-page--fill lb-hurl">
      <div className="lb-hurl__toolbar">
        <div className="lb-hurl__where">
          <span className="lb-hurl__run-state">
            <Dot state={s.dot} />
          </span>
          <span className="lb-hurl__cwd" title={s.cwdTitle}>
            {s.cwdLabel}
          </span>
        </div>
        <div className="lb-hurl__actions">
          <select
            className="lb-input lb-hurl__env"
            aria-label="Variables file"
            value={s.envValue}
            onChange={(event): void => store.setEnv(event.currentTarget.value)}
          >
            <option value="">env: (none)</option>
            {s.envFiles.map((f) => (
              <option key={f.path} value={f.path}>{`env: ${f.rel_path || f.name}`}</option>
            ))}
          </select>
          <Button
            label="v"
            variant="toggle"
            pressed={s.verbose}
            title="Toggle --verbose"
            onClick={(): void => store.toggleVerbose('v')}
          />
          <Button
            label="VV"
            variant="toggle"
            pressed={s.veryVerbose}
            title="Toggle --very-verbose"
            onClick={(): void => store.toggleVerbose('vv')}
          />
          <Button label="curl" title="Copy as curl (c)" disabled={s.copyDisabled} onClick={(): void => void store.copyCurl()} />
          <Button
            label="hurl"
            title="Copy hurl command (H)"
            disabled={s.copyDisabled}
            onClick={(): void => void store.copyHurlCli()}
          />
          <Button
            label={running ? 'Cancel' : 'Run'}
            variant={running ? 'secondary' : 'primary'}
            disabled={s.runDisabled}
            data-state={s.runState}
            onClick={(): void => void store.runSelected()}
          />
        </div>
      </div>
      <Banner {...banner.props} />
      <StatBar stats={s.stats} />
      <section className="lb-hurl__workspace" ref={splits.workspaceRef}>
        <aside className="lb-hurl__roster" aria-label="Hurl files">
          <div className="lb-hurl__roster-head">
            <div className="lb-hurl__roster-title">
              <h2 className="lb-h2">{s.rosterTitle}</h2>
              <span className="lb-hurl__tools">
                <span className="lb-hurl__count">{s.count}</span>
                <Button
                  label="reload"
                  variant="ghost"
                  title="Reload listing and source"
                  disabled={s.reloading}
                  onClick={(): void => void store.reloadFiles()}
                />
              </span>
            </div>
            <Tabs label="Roster" tabs={MODES} active={s.mode} onSelect={(id): void => store.setMode(id === 'runs' ? 'runs' : 'files')} />
            <SearchFilter
              placeholder="/  filter .hurl"
              label="Filter files"
              escape="clear-and-leave"
              value={s.query}
              onChange={(query): void => store.setQuery(query)}
            />
          </div>
          <div className="lb-hurl__tree">
            <RosterList
              ref={roster}
              label="Hurl files"
              items={s.rows}
              selected={s.cursor}
              itemKey={rowKey}
              render={renderRow}
              deps={rowDeps}
              keys={false}
              onSelect={(row): void => store.selectRow(row)}
              onOpen={(row): void => store.openRow(row)}
            />
            <div className="lb-hurl__tree-empty" hidden={!s.treeEmpty}>
              {s.treeEmpty}
            </div>
          </div>
        </aside>
        {splits.rosterSplit}
        <div className="lb-hurl__panes" ref={splits.panesRef}>
          <section className="lb-hurl__pane">
            <div className="lb-hurl__pane-head">
              <div className="lb-hurl__pane-title">
                <strong>Source</strong>
                <div className="lb-hurl__crumb">{s.crumb}</div>
              </div>
              <span className="lb-hurl__crumb lb-hurl__note">read only · e opens $EDITOR in Krypton</span>
            </div>
            {source.kind === 'note' ? (
              <pre ref={sourceEl} className="lb-hurl__code lb-hurl__source" tabIndex={0}>
                {source.text}
              </pre>
            ) : (
              <pre
                ref={sourceEl}
                className="lb-hurl__code lb-hurl__source"
                tabIndex={0}
                // The one raw sink (spec 361): `sourceHtml` is highlightHurl output, which escapes every source character it emits.
                dangerouslySetInnerHTML={{ __html: sourceHtml }}
              />
            )}
          </section>
          {splits.sourceSplit}
          <section className="lb-hurl__pane">
            <div className="lb-hurl__pane-head">
              <strong>Response</strong>
              <Tabs label="Response view" tabs={VIEWS} active={s.view} onSelect={(id): void => store.setView(id as ResponseView)} />
            </div>
            <div ref={viewportEl} className="lb-hurl__code lb-hurl__viewport" tabIndex={0}>
              <ResponseBody state={s.response} />
            </div>
          </section>
        </div>
      </section>
      <KbdHints entries={HINTS} />
    </div>
  );
}
