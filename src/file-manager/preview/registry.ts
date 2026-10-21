// Krypton — File Manager preview renderer registry (spec 317, extension point A).
//
// An ordered list of renderers; the first non-null output wins. A renderer may
// decline (`null`) so content-sniffing renderers (skill → frontmatter →
// markdown) can chain.
//
// Add a preview type: create `renderers/<id>.ts` exporting a `PreviewRenderer`,
// insert it into `PREVIEW_RENDERERS` (order is priority — e.g. images before
// `binary`), and add a case to `registry.test.ts`. A new `PreviewOutput` kind
// needs one `case` in `PreviewPane.paint()`.

import { formatSize } from '../../file-preview';
import type { FileEntry, PreviewOutput } from '../types';
import { binary } from './renderers/binary';
import { code } from './renderers/code';
import { directory } from './renderers/directory';
import { frontmatter } from './renderers/frontmatter';
import { markdown } from './renderers/markdown';
import { searchBinary } from './renderers/search-binary';
import { searchCode } from './renderers/search-code';
import { skill } from './renderers/skill';
import { tooLarge } from './renderers/too-large';

export type PreviewSource = 'cursor' | 'search';

export interface PreviewTarget {
  readonly source: PreviewSource;
  /** Absolute path. */
  readonly path: string;
  /** Basename used for extension / language checks. */
  readonly name: string;
  /** Cursor source only (size, is_dir). */
  readonly entry: FileEntry | null;
  readonly showHidden: boolean;
}

export interface PreviewIO {
  /** Memoised per request: several renderers may ask, `read_file` runs at most once. */
  readText(): Promise<string>;
  listDirectory(path: string): Promise<FileEntry[]>;
}

export interface PreviewRenderer {
  readonly id: string;
  readonly sources: readonly PreviewSource[];
  /** Cheap, metadata-only gate. */
  matches(t: PreviewTarget): boolean;
  /** Produce output, or `null` to decline and let the next renderer try. */
  render(t: PreviewTarget, io: PreviewIO): PreviewOutput | null | Promise<PreviewOutput | null>;
}

export const PREVIEW_RENDERERS: readonly PreviewRenderer[] = [
  directory,
  tooLarge,
  binary,
  searchBinary,
  skill,
  frontmatter,
  markdown,
  code,
  searchCode,
];

/** The text shown when reading or rendering throws. */
export function readError(t: PreviewTarget): PreviewOutput {
  return t.source === 'cursor'
    ? { kind: 'text', text: `Cannot read file\n${formatSize(t.entry?.size ?? 0)}` }
    : { kind: 'text', text: '[cannot read file]' };
}

/** Walk the list; the first non-null output wins. Any throw → `readError(t)`. */
export async function renderPreview(
  t: PreviewTarget,
  io: PreviewIO,
  renderers: readonly PreviewRenderer[] = PREVIEW_RENDERERS,
): Promise<PreviewOutput> {
  let text: Promise<string> | null = null;
  const memo: PreviewIO = {
    readText: () => (text ??= io.readText()),
    listDirectory: (path) => io.listDirectory(path),
  };
  try {
    for (const r of renderers) {
      if (!r.sources.includes(t.source) || !r.matches(t)) continue;
      const out = await r.render(t, memo);
      if (out) return out;
    }
  } catch {
    return readError(t);
  }
  return { kind: 'text', text: '' };
}
