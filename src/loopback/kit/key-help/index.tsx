// Spec 341 — `?` lists every labelled key the page answers to: the shell's,
// then the surface's. The shell reads them from the keymap when it opens the
// overlay (spec 361: a React component the shell portals into `<body>`).

import type { JSX, MouseEvent } from 'react';

import { useKeymap, useModal } from '../hooks';
import type { HelpEntry } from '../lib/keymap';

import '../overlay/overlay.css';
import './key-help.css';

export interface KeyHelpProps {
  readonly open: boolean;
  /** `keymap().help()` captured when the overlay opened. */
  readonly entries: readonly HelpEntry[];
  onClose(): void;
}

export function KeyHelp({ open, entries, onClose }: KeyHelpProps): JSX.Element {
  useModal(open);
  useKeymap([{ key: ['Escape', '?'], inInput: true, modal: true, when: () => open, run: onClose }]);

  const groups = new Map<string, HelpEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.group);
    if (list) list.push(entry);
    else groups.set(entry.group, [entry]);
  }

  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="lb-overlay lb-keyhelp" hidden={!open} onMouseDown={onBackdrop}>
      <div className="lb-overlay__panel" role="dialog" aria-label="Keyboard shortcuts">
        <div className="lb-overlay__head">
          <h2 className="lb-overlay__title">Keyboard</h2>
        </div>
        <div className="lb-overlay__body lb-keyhelp__body">
          {[...groups].map(([group, list]) => (
            <section key={group} className="lb-keyhelp__group">
              <h3 className="lb-h3">{group}</h3>
              <dl className="lb-keyhelp__list">
                {list.map((entry) => (
                  <KeyHelpRow key={`${entry.keys}|${entry.label}`} entry={entry} />
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="lb-overlay__foot">
          <span>
            <kbd>Esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}

function KeyHelpRow({ entry }: { readonly entry: HelpEntry }): JSX.Element {
  return (
    <>
      <dt>
        <kbd>{entry.keys}</kbd>
      </dt>
      <dd>{entry.label}</dd>
    </>
  );
}
