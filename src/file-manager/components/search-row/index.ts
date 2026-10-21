// Krypton — File Manager search result row (spec 317).

import { Component } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import { matchRuns } from '../../fuzzy';

export interface SearchRowProps {
  relPath: string;
  /** Lower-cased query; empty = plain text. */
  query: string;
  isCursor: boolean;
}

const B = 'krypton-file-manager';

export class SearchRow extends Component<SearchRowProps> {
  private readonly nameEl = el('span', { class: `${B}__name` });

  constructor() {
    super(el('div', { class: `${B}__item` }));
    this.el.append(el('span', { class: `${B}__icon`, text: '  ' }), this.nameEl);
  }

  protected readDeps(p: SearchRowProps): readonly unknown[] {
    return [p.relPath, p.query, p.isCursor];
  }

  protected paint(p: SearchRowProps): void {
    this.syncClasses(p);
    if (p.query && p.relPath.length > 0) {
      setChildren(
        this.nameEl,
        matchRuns(p.relPath, p.query).map((run) =>
          run.matched ? el('span', { class: `${B}__match`, text: run.text }) : document.createTextNode(run.text),
        ),
      );
    } else {
      this.nameEl.textContent = p.relPath;
    }
  }

  protected syncClasses(p: SearchRowProps): void {
    this.el.classList.toggle(`${B}__item--cursor`, p.isCursor);
  }
}
