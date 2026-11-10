// Krypton — ACP Harness inline images (spec 281).
// Decode / sniff / byte budget / local-path discovery for the per-row image
// strip. Every image is a Blob + object URL owned by exactly one transcript
// row; base64 never reaches markdownHtml and the markdown sanitizer is untouched.

import { invoke } from '@tauri-apps/api/core';

import type { ContentBlock } from './types';
import type { HarnessImage, HarnessImageMime, LaneImageState } from './harness-view-types';
import { makeId } from './harness-format';
import { fileUriToPath, resolveFilePath } from './message-resources';
import { IMAGE_PATH_EXTENSIONS, URI_SCHEME, isImagePath } from './image-paths';

export {
  IMAGE_SCAN_TEXT_LIMIT,
  MAX_PATH_IMAGES_PER_ROW,
  findImagePaths,
  isImagePath,
  scanValueForImagePaths,
  type ImagePathScan,
} from './image-paths';

/** Per image, decoded. Mirrors READ_IMAGE_MAX_BYTES in src-tauri/src/commands.rs. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Live object-URL bytes per lane before the oldest images are released. */
export const LANE_IMAGE_BUDGET = 64 * 1024 * 1024;

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
