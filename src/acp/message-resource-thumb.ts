// Krypton — ACP Harness: REFERENCES rail thumbnails (spec 286).
//
// Pure helpers: the extension glyph a reference row shows when it has no
// pixels, and the spec 281 image (same row or borrowed from another row of the
// lane) whose object URL a reference row reuses. Nothing here reads files.

import { isImagePath, isOpenableImage } from './harness-images';
import type { HarnessImage, HarnessLane, HarnessTranscriptItem, MessageResource } from './harness-view-types';

export type ResourceGlyphKind = 'code' | 'doc' | 'data' | 'web' | 'image' | 'dir' | 'file' | 'url';

export interface ResourceGlyph {
  kind: ResourceGlyphKind;
  /** ≤ 4 upper-case chars; empty for `url` (drawn as a globe). */
  text: string;
}

const GLYPH_KINDS: Record<string, ResourceGlyphKind> = {};
const GLYPH_GROUPS: Array<[ResourceGlyphKind, string]> = [
  ['code', 'ts tsx js jsx mjs cjs rs py go swift kt java c h cpp cs rb sh zsh fish lua'],
  ['doc', 'md mdx txt rst adoc pdf'],
  ['data', 'json jsonc toml yaml yml xml csv lock ini env'],
  ['web', 'html htm css scss svg'],
  ['image', 'png jpg jpeg gif webp'],
];
for (const [kind, exts] of GLYPH_GROUPS) {
  for (const ext of exts.split(' ')) GLYPH_KINDS[ext] = kind;
}

/** Deterministic glyph for a reference without pixels — by extension only. */
export function resourceGlyph(resource: MessageResource): ResourceGlyph {
  if (resource.kind === 'url') return { kind: 'url', text: '' };
  const target = resource.target;
  if (target.endsWith('/')) return { kind: 'dir', text: 'DIR' };
  const base = target.slice(target.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  const kind = GLYPH_KINDS[ext];
  // A dotfile (`.gitignore`) has no extension unless its name is a known one (`.env`).
  if (!ext || (dot === 0 && !kind)) return { kind: 'file', text: 'FILE' };
  if (kind === 'image') return { kind, text: 'IMG' };
  return { kind: kind ?? 'file', text: ext.slice(0, 4).toUpperCase() };
}

/** The spec 281 image a file reference shows: the row's own image for that
 *  path, else the newest live image in the lane, else the newest reloadable
 *  (released) one. Per-turn dedupe means the reply row often owns no image —
 *  an earlier tool row showed it — so the lookup spans the lane. */
export function resolveResourceImage(
  lane: Pick<HarnessLane, 'imageState' | 'transcript'> | null,
  item: HarnessTranscriptItem,
  resource: MessageResource,
): HarnessImage | null {
  if (resource.kind !== 'file' || !isImagePath(resource.target)) return null;
  const target = resource.target;
  const own = item.images?.find((image) => image.path === target);
  if (own) return own;
  if (!lane) return null;
  const live = lane.imageState.live;
  for (let i = live.length - 1; i >= 0; i--) {
    if (live[i].path === target) return live[i];
  }
  for (let r = lane.transcript.length - 1; r >= 0; r--) {
    const match = lane.transcript[r].images?.find((image) => image.path === target && isOpenableImage(image));
    if (match) return match;
  }
  return null;
}

/** A sealed row's image whose path is one of its own file references — the
 *  rail shows it, so the image strip and open-hint targets skip it. */
export function railCoversImage(item: HarnessTranscriptItem, image: HarnessImage): boolean {
  if (item.resourcesScanned !== true || image.path === null) return false;
  return (item.resources ?? []).some((resource) => resource.kind === 'file' && resource.target === image.path);
}
