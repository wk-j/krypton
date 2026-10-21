// Krypton — File Manager search result list (spec 317). See FileList for the
// shared-node contract and the smooth-scrolling frame.

import { Component } from '../../../ui/component';
import { reconcile, type ListSpec } from '../../../ui/list';
import { ListFrame } from '../list-frame';
import { SearchRow, type SearchRowProps } from '../search-row';

export interface SearchListProps {
  /** The visible window plus overscan (see `overscanRange`). */
  rows: readonly SearchRowProps[];
  /** `'No matches'` / `'Loading...'`; when non-null, `rows` is ignored. */
  empty: string | null;
  /** See `FileListProps.shiftPx`. */
  shiftPx?: number;
}

const SEARCH_ROW_SPEC: ListSpec<SearchRowProps, SearchRow> = {
  key: (r) => `s:${r.relPath}`,
  create: (r) => {
    const row = new SearchRow();
    row.update(r);
    return row;
  },
  update: (row, r) => row.update(r),
};

export class SearchList extends Component<SearchListProps> {
  private readonly frame: ListFrame;

  constructor(listEl: HTMLElement) {
    super(listEl);
    this.frame = new ListFrame(listEl);
  }

  /** The inner node holding the row elements. */
  get rowsEl(): HTMLElement {
    return this.frame.rows;
  }

  update(next: SearchListProps): void {
    super.update(next);
    if (next.empty === null) this.frame.place(next.shiftPx ?? 0);
  }

  /** Dispose every row and force the next update to paint. */
  release(): void {
    this.frame.release();
    this.invalidateDeps();
  }

  protected readDeps(p: SearchListProps): readonly unknown[] {
    return [p.empty, p.rows.length, ...p.rows.flatMap((r) => [r.relPath, r.query, r.isCursor])];
  }

  protected paint(p: SearchListProps): void {
    this.syncClasses(p);
    if (p.empty !== null) {
      this.frame.showEmpty(p.empty);
      return;
    }
    reconcile(this.frame.mountRows(), p.rows, SEARCH_ROW_SPEC);
  }

  /** The list node's class and inline flex belong to the view, not to props. */
  protected syncClasses(_p: SearchListProps): void {}

  protected onDispose(): void {
    this.frame.dispose();
  }
}
