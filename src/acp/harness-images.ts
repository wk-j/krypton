// Krypton — ACP Harness inline images (spec 281).
// Decode / sniff / byte budget / local-path discovery for the per-row image
// strip. Every image is a Blob + object URL owned by exactly one transcript
// row; base64 never reaches markdownHtml and the markdown sanitizer is untouched.

import { invoke } from '@tauri-apps/api/core';

import type { ContentBlock } from './types';
import type { HarnessImage, HarnessImageMime, LaneImageState } from './harness-view-types';
import { makeId } from './harness-format';
import { fileUriToPath, resolveFilePath } from './message-resources';

/** Per image, decoded. Mirrors READ_IMAGE_MAX_BYTES in src-tauri/src/commands.rs. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Live object-URL bytes per lane before the oldest images are released. */
export const LANE_IMAGE_BUDGET = 64 * 1024 * 1024;
/** Path images per row (same cap as retained tool content blocks). */
export const MAX_PATH_IMAGES_PER_ROW = 8;
/** Text scanned per source, same bound as tool retention. */
export const IMAGE_SCAN_TEXT_LIMIT = 64 * 1024;

const IMAGE_PATH_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const REJECTED_PATH_CHARS = /[()[\]{}<>|"'*?$`=\n\r\t]/;
const LEADING_TRIM = /^[([{<"'`]+/;
const TRAILING_TRIM = /[)\]}>"'`.,;:!?]+$/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function createLaneImageState(): LaneImageState {
  return { bytes: 0, live: [], turnPaths: new Map(), queue: Promise.resolve() };
}

// ─── Bytes ────────────────────────────────────────────────────────────────

/** Magic-byte sniff; the declared mimeType is never trusted. */
export function sniffImageMime(head: Uint8Array): HarnessImageMime | null {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return 'image/gif';
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function decodeBase64(data: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(data.replace(/\s+/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export interface ImageBytesSource {
  data: string;
  mimeType: string;
  uri?: string;
}

/** `image` blocks and image-typed `resource` blobs carry displayable bytes. */
export function imageBytesSource(block: ContentBlock | undefined): ImageBytesSource | null {
  if (!block) return null;
  if (block.type === 'image' && block.data.length > 0) {
    return { data: block.data, mimeType: block.mimeType, uri: block.uri };
  }
  if (
    block.type === 'resource' &&
    typeof block.resource.blob === 'string' &&
    block.resource.blob.length > 0 &&
    (block.resource.mimeType ?? '').toLowerCase().startsWith('image/')
  ) {
    return { data: block.resource.blob, mimeType: block.resource.mimeType ?? '', uri: block.resource.uri };
  }
  return null;
}

/** Explicit local image path from a block: an image `resource_link`, or an
 *  `image` block without data that points at a file uri. */
export function imagePathFromBlock(block: ContentBlock | undefined): string | null {
  if (!block) return null;
  if (block.type === 'resource_link') {
    const imageMime = (block.mimeType ?? '').toLowerCase().startsWith('image/');
    if (imageMime || IMAGE_PATH_EXTENSIONS.test(block.uri) || IMAGE_PATH_EXTENSIONS.test(block.name ?? '')) {
      return block.uri;
    }
    return null;
  }
  if (block.type === 'image' && block.data.length === 0 && block.uri && !/^https?:/i.test(block.uri)) {
    return block.uri;
  }
  return null;
}

export function bytesImageKey(mimeType: string, data: string): string {
  return `b:${mimeType}:${data.length}:${data.slice(0, 32)}:${data.slice(-32)}`;
}

/** Decode one byte source into a live (or rejected) image. Caller retains it. */
export function createBytesImage(
  itemId: string,
  source: HarnessImage['source'],
  src: ImageBytesSource,
  ordinal: number,
  path: string | null,
): HarnessImage {
  const image: HarnessImage = {
    imageId: makeId(),
    itemId,
    origin: 'bytes',
    path,
    discovery: 'explicit',
    state: 'rejected',
    mimeType: null,
    bytes: Math.floor((src.data.length * 3) / 4),
    objectUrl: null,
    label: imageLabel(path ?? src.uri ?? null, ordinal),
    source,
    key: bytesImageKey(src.mimeType, src.data),
    hintLabel: null,
  };
  if (image.bytes > IMAGE_MAX_BYTES) {
    image.rejectReason = 'too large';
    return image;
  }
  const bytes = decodeBase64(src.data);
  if (!bytes) {
    image.rejectReason = 'decode';
    return image;
  }
  const mime = sniffImageMime(bytes);
  image.bytes = bytes.length;
  if (!mime) {
    image.rejectReason = src.mimeType || 'unknown';
    return image;
  }
  image.mimeType = mime;
  image.objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  image.state = 'live';
  return image;
}

export function createPathImage(
  itemId: string,
  source: HarnessImage['source'],
  path: string,
  discovery: HarnessImage['discovery'],
): HarnessImage {
  return {
    imageId: makeId(),
    itemId,
    origin: 'path',
    path,
    discovery,
    state: 'loading',
    mimeType: null,
    bytes: 0,
    objectUrl: null,
    label: imageLabel(path, 0),
    source,
    key: `p:${path}`,
    hintLabel: null,
  };
}

export type ImageFileResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; mimeType: HarnessImageMime }
  | { ok: false; reason: string };

/** Read one local image through `read_image_file` (magic-sniffed in Rust). */
export async function readImageFile(path: string): Promise<ImageFileResult> {
  try {
    const buffer = await invoke<ArrayBuffer>('read_image_file', { path });
    const bytes = new Uint8Array(buffer);
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) return { ok: false, reason: 'not an image' };
    return { ok: true, bytes, mimeType };
  } catch (e) {
    return { ok: false, reason: typeof e === 'string' ? e : 'not found' };
  }
}

/** Make a loaded path image live. Caller retains it. */
export function makePathImageLive(
  image: HarnessImage,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: HarnessImageMime,
): void {
  if (image.objectUrl) URL.revokeObjectURL(image.objectUrl);
  image.objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  image.mimeType = mimeType;
  image.bytes = bytes.length;
  image.state = 'live';
  image.rejectReason = undefined;
}

// ─── Budget / lifecycle ───────────────────────────────────────────────────

/** Account a live image; release the oldest live images while over budget.
 *  Returns the images released so the caller can repaint their rows. */
export function retainImage(state: LaneImageState, image: HarnessImage): HarnessImage[] {
  if (image.state !== 'live' || state.live.includes(image)) return [];
  state.live.push(image);
  state.bytes += image.bytes;
  const released: HarnessImage[] = [];
  while (state.bytes > LANE_IMAGE_BUDGET && state.live.length > 1) {
    const oldest = state.live.shift();
    if (!oldest) break;
    state.bytes -= oldest.bytes;
    revoke(oldest);
    oldest.state = 'released';
    released.push(oldest);
  }
  return released;
}

/** Drop images whose rows left the transcript (eviction, removal, clear). */
export function disposeImages(state: LaneImageState, images: readonly HarnessImage[] | undefined): void {
  if (!images || images.length === 0) return;
  for (const image of images) {
    const idx = state.live.indexOf(image);
    if (idx !== -1) {
      state.live.splice(idx, 1);
      state.bytes -= image.bytes;
    }
    revoke(image);
    if (image.state === 'live' || image.state === 'loading') image.state = 'released';
    if (image.path && state.turnPaths.get(image.path) === image.imageId) state.turnPaths.delete(image.path);
  }
}

export function disposeAllImages(state: LaneImageState): void {
  for (const image of state.live) revoke(image);
  state.live = [];
  state.bytes = 0;
  state.turnPaths.clear();
}

function revoke(image: HarnessImage): void {
  if (image.objectUrl) URL.revokeObjectURL(image.objectUrl);
  image.objectUrl = null;
}

// ─── Path discovery ───────────────────────────────────────────────────────

export function isImagePath(value: string): boolean {
  return IMAGE_PATH_EXTENSIONS.test(value);
}

/** Absolute local path for a candidate, or null. `~/` stays unexpanded —
 *  Rust expands it against HOME. Relative paths join the lane's project dir. */
export function resolveImagePath(raw: string, projectDir: string | null): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^file:/i.test(value)) {
    const path = fileUriToPath(value);
    return path && isImagePath(path) ? path : null;
  }
  if (value.startsWith('~/')) return value;
  if (URI_SCHEME.test(value)) return null;
  const resolved = resolveFilePath(value, projectDir);
  return resolved && isImagePath(resolved) ? resolved : null;
}

export interface ImagePathScan {
  paths: string[];
  overflow: number;
}

/** Image paths in free text (prose, shell commands, tool output), in order,
 *  deduped, capped at `max`. Bare file names (`shot.png`) are ignored. */
export function findImagePaths(text: string, max = MAX_PATH_IMAGES_PER_ROW): ImagePathScan {
  const seen = new Set<string>();
  const paths: string[] = [];
  let overflow = 0;
  for (const token of shellTokens(text.slice(0, IMAGE_SCAN_TEXT_LIMIT))) {
    const candidate = cleanPathToken(token);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (paths.length < max) paths.push(candidate);
    else overflow += 1;
  }
  return { paths, overflow };
}

/** Walk every string inside a tool's rawInput / rawOutput. A string that is
 *  wholly one path counts even with spaces; anything else is tokenized. */
export function scanValueForImagePaths(value: unknown, max = MAX_PATH_IMAGES_PER_ROW): ImagePathScan {
  const seen = new Set<string>();
  const paths: string[] = [];
  let overflow = 0;
  let budget = IMAGE_SCAN_TEXT_LIMIT;
  const push = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    if (paths.length < max) paths.push(path);
    else overflow += 1;
  };
  const visit = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > 8) return;
    if (typeof node === 'string') {
      const text = node.slice(0, budget);
      budget -= text.length;
      const whole = text.trim();
      // A whole value may contain spaces only when it is unmistakably a path.
      // Tokens are still scanned: a space-separated list of paths also matches
      // the whole-value shape, and its wrong whole candidate drops silently.
      if (whole && isImagePath(whole) && /^(\/|~\/|\.\.?\/|file:\/\/)/i.test(whole) && !/[<>|"'`*?$\n\r]/.test(whole)) {
        push(whole);
      }
      const scan = findImagePaths(text, Number.POSITIVE_INFINITY);
      for (const path of scan.paths) push(path);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const child of Object.values(node as Record<string, unknown>)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return { paths, overflow };
}

function hasPathForm(value: string): boolean {
  if (value.startsWith('-')) return false;
  if (/^(\/|~\/|\.\.?\/)/.test(value)) return true;
  if (/^file:\/\//i.test(value)) return true;
  if (URI_SCHEME.test(value)) return false;
  return value.includes('/');
}

function cleanPathToken(token: string): string | null {
  let value = token.replace(LEADING_TRIM, '').replace(TRAILING_TRIM, '');
  // `--output=/tmp/x.png`, `out=./a.png`
  const eq = value.indexOf('=');
  if (eq !== -1) value = value.slice(eq + 1).replace(LEADING_TRIM, '');
  if (!value || !isImagePath(value)) return null;
  if (REJECTED_PATH_CHARS.test(value)) return null;
  if (/^(https?|data|blob):/i.test(value)) return null;
  return hasPathForm(value) ? value : null;
}

/** Shell-like split: whitespace and `; | & < >` separate outside quotes; a
 *  quote only opens at a token start (so prose apostrophes stay literal);
 *  backslash escapes the next character outside quotes. */
function shellTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const flush = (): void => {
    if (current) tokens.push(current);
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        flush();
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        current += text[++i];
      } else if (ch === '\n') {
        // An unterminated quote never spans lines.
        quote = null;
        flush();
      } else {
        current += ch;
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && current === '') {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length && text[i + 1] === ' ') {
      current += ' ';
      i++;
      continue;
    }
    if (/\s/.test(ch) || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>' || ch === '`') {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

function imageLabel(path: string | null, ordinal: number): string {
  if (path) {
    const clean = path.replace(/[?#].*$/, '');
    const base = clean.slice(clean.lastIndexOf('/') + 1);
    if (base) return base;
  }
  return `image ${ordinal + 1}`;
}

export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Images a viewer / open-hint can open: live, or released but reloadable. */
export function isOpenableImage(image: HarnessImage): boolean {
  return image.state === 'live' || (image.state === 'released' && image.origin === 'path');
}
