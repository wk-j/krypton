// Krypton — File Manager directory row (spec 317).
//
// The row derives its whole className from props, so the mark glyph and the
// `--marked` class can never disagree (spec 317 §Parity D1).

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import { formatSize } from '../../../file-preview';
import { ROW_CLASS_DECORATORS, ageFillStyle, sizeClass } from '../../decorations';
import type { FileEntry } from '../../types';

export interface FileRowProps {
  entry: FileEntry;
  isCursor: boolean;
  marked: boolean;
  /** 0..1 age-bar fill, or undefined for no fill (`modified === 0`). */
  recency: number | undefined;
}

const B = 'krypton-file-manager';

export class FileRow extends Component<FileRowProps> {
  private readonly markEl = el('span', { class: `${B}__mark` });
  private readonly iconEl = el('span', { class: `${B}__icon` });
  private readonly nameEl = el('span', { class: `${B}__name` });
  private readonly ageBarEl = el('span', { class: `${B}__age-bar` });
  private readonly sizeEl = el('span', { class: `${B}__size` });
  /** `null` = never painted; distinguishes "no fill yet" from "fill for undefined". */
  private paintedRecency: { value: number | undefined } | null = null;

  constructor() {
    super(el('div', { class: `${B}__item` }));
    this.el.append(this.markEl, this.iconEl, this.nameEl, this.ageBarEl, this.sizeEl);
  }

  protected readDeps(p: FileRowProps): readonly unknown[] {
    return [p.entry, p.isCursor, p.marked, p.recency];
  }

  protected paint(p: FileRowProps): void {
    const { entry } = p;
    this.syncClasses(p);

    this.markEl.textContent = p.marked ? '\u25cf ' : '  ';
    this.iconEl.textContent = entry.is_dir ? '\u25b8 ' : '  ';

    let nameText = entry.name;
    if (entry.is_dir) nameText += '/';
    if (entry.is_symlink && entry.symlink_target) {
      nameText += ` \u2192 ${entry.symlink_target}`;
    }
    this.nameEl.textContent = nameText;

    if (this.paintedRecency === null || this.paintedRecency.value !== p.recency) {
      this.paintedRecency = { value: p.recency };
      this.ageBarEl.replaceChildren();
      if (p.recency !== undefined) {
        const fill = el('span', { class: `${B}__age-fill` });
        const style = ageFillStyle(p.recency);
        fill.style.width = style.width;
        fill.style.background = style.background;
        fill.style.opacity = style.opacity;
        this.ageBarEl.appendChild(fill);
      }
    }

    // Size (right-aligned, always present for alignment)
    this.sizeEl.className = classes(`${B}__size`, sizeClass(entry));
    this.sizeEl.textContent = entry.is_dir ? '' : formatSize(entry.size);
  }

  protected syncClasses(p: FileRowProps): void {
    const { entry } = p;
    this.el.className = classes(
      `${B}__item`,
      p.isCursor && `${B}__item--cursor`,
      entry.is_dir && `${B}__item--dir`,
      entry.is_symlink && `${B}__item--symlink`,
      p.marked && `${B}__item--marked`,
      ROW_CLASS_DECORATORS.map((d) => d(entry)),
    );
  }
}
