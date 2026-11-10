// Spec 381 — helpers for writing canonical example data by hand.

import type { ToolSection, ToolView } from '../../../../acp/adapters/types';
import type { ContentBlock } from '../../../../acp/types';
import type { GalleryInput, GalleryItem } from './types';

/** A 64×40 PNG, four flat colours. `data:` only: the page CSP allows no other image source. */
export const SAMPLE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAYklEQVR42u3ZMRGAMBBFwQigSoWECEgZHWhBEzWa0BELuQq42Zkn4O+1V7a9/bqSBFD7sVg7r1DPPUKtLwEAAAAAAAAAAAAAAMgB+MKg6IEAAAAAAAAAAAAAAByAHwpX2sC0/x4Z+kxUn0AAAAASUVORK5CYII=';

export const imageBlock: ContentBlock = { type: 'image', data: SAMPLE_PNG, mimeType: 'image/png' };

/** A `ToolView` with every field the decoder fills, defaulted to "the server sent nothing". */
export function toolView(id: string, fields: Partial<ToolView> & Pick<ToolView, 'kind' | 'status'>): ToolView {
  return {
    id,
    parentId: null,
    declaredKind: fields.kind,
    title: '',
    toolName: null,
    subject: '',
    command: '',
    commandLine: null,
    modifiedPath: null,
    locations: [],
    inputPaths: [],
    sections: [],
    exit: null,
    diffs: [],
    mcp: null,
    background: null,
    ...fields,
  };
}

/** A bare output well; `label` other than output/content/stdout/text draws a label line. */
export function section(text: string, label = 'output'): ToolSection {
  return { label, text };
}

export function tool(view: ToolView, elapsedMs: number | null = 1200): GalleryInput {
  return { kind: 'tool', view, elapsedMs };
}

export function item(data: GalleryItem): GalleryInput {
  return { kind: 'item', item: data };
}

/** `n` numbered lines, `prefix` first. */
export function lines(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}
