// Krypton — File Manager breadcrumb (spec 317).

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';

export interface BreadcrumbProps {
  /** Search mode: amber variant. */
  search: boolean;
  /** Final text (cwd with `~`, or `SEARCH // <query>█`). */
  text: string;
}

export class Breadcrumb extends Component<BreadcrumbProps> {
  constructor() {
    super(el('div', { class: 'krypton-file-manager__breadcrumb' }));
  }

  protected readDeps(p: BreadcrumbProps): readonly unknown[] {
    return [p.search, p.text];
  }

  protected paint(p: BreadcrumbProps): void {
    this.syncClasses(p);
    this.el.textContent = p.text;
  }

  protected syncClasses(p: BreadcrumbProps): void {
    this.el.classList.toggle('krypton-file-manager__breadcrumb--search', p.search);
  }
}
