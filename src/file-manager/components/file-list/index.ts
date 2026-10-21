// Krypton — File Manager directory list (spec 317).
//
// Keyed `reconcile()` over the virtual window: rows that stay are updated (and
// only repaint when their deps moved), rows that leave are disposed. Shares the
// one `div.krypton-file-manager__list` node with SearchList; the view calls
// `release()` on the outgoing list when the mode switches. Rows live in a
// `ListFrame` inner node that is translated by `shiftPx` (smooth scrolling).

import { Component } from '../../../ui/component';
import { reconcile, type ListSpec } from '../../../ui/list';
import { FileRow, type FileRowProps } from '../file-row';
import { ListFrame } from '../list-frame';

export interface FileListProps {
  /** The visible window plus overscan (see `overscanRange`). */
  rows: readonly FileRowProps[];
  /** Empty-state text; when non-null, `rows` is ignored. */
  empty: string | null;
  /** `(firstRenderedRow - animatedTopRow) * cellHeight`; applied every update, outside the deps. */
  shiftPx?: number;
}

const FILE_ROW_SPEC: ListSpec<FileRowProps, FileRow> = {
  key: (r) => `f:${r.entry.path}`,
  create: (r) => {
    const row = new FileRow();
    row.update(r);
    return row;
  },
  update: (row, r) => row.update(r),
};

export class FileList extends Component<FileListProps> {
  private readonly frame: ListFrame;

  constructor(listEl: HTMLElement) {
    super(listEl);
    this.frame = new ListFrame(listEl);
  }

  /** The inner node holding the row elements. */
  get rowsEl(): HTMLElement {
    return this.frame.rows;
  }

  update(next: FileListProps): void {
    super.update(next);
    // The scroll position moves every animation frame; it never repaints rows.
    if (next.empty === null) this.frame.place(next.shiftPx ?? 0);
  }

  /** Dispose every row and force the next update to paint. */
  release(): void {
    this.frame.release();
    this.invalidateDeps();
  }

  protected readDeps(p: FileListProps): readonly unknown[] {
    return [p.empty, p.rows.length, ...p.rows.flatMap((r) => [r.entry, r.isCursor, r.marked, r.recency])];
  }

  protected paint(p: FileListProps): void {
    this.syncClasses(p);
    if (p.empty !== null) {
      this.frame.showEmpty(p.empty);
      return;
    }
    reconcile(this.frame.mountRows(), p.rows, FILE_ROW_SPEC);
  }

  /** The list node's class and inline flex belong to the view, not to props. */
  protected syncClasses(_p: FileListProps): void {}

  protected onDispose(): void {
    this.frame.dispose();
  }
}
