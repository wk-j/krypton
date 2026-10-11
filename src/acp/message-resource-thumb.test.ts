import { describe, expect, it } from 'vitest';

import { createLaneImageState, createPathImage } from './harness-images';
import { railCoversImage, resolveResourceImage, resourceGlyph } from './message-resource-thumb';
import type { HarnessImage, HarnessTranscriptItem, MessageResource } from './harness-view-types';

function fileRef(target: string): MessageResource {
  return { key: `f:${target}`, kind: 'file', target, label: target, source: 'markdown', hintLabel: null };
}

function image(itemId: string, path: string, state: HarnessImage['state']): HarnessImage {
  return { ...createPathImage(itemId, 'tool', path, 'explicit'), state, objectUrl: state === 'live' ? `blob:${itemId}` : null };
}

describe('resourceGlyph', () => {
  it('classifies by extension and keeps dotfiles without a known name generic', () => {
    expect(resourceGlyph(fileRef('/p/src/a.tsx'))).toEqual({ kind: 'code', text: 'TSX' });
    expect(resourceGlyph(fileRef('/p/docs/README.md'))).toEqual({ kind: 'doc', text: 'MD' });
    expect(resourceGlyph(fileRef('/p/tsconfig.jsonc'))).toEqual({ kind: 'data', text: 'JSON' });
    expect(resourceGlyph(fileRef('/p/shot.PNG'))).toEqual({ kind: 'image', text: 'IMG' });
    expect(resourceGlyph(fileRef('/p/.env'))).toEqual({ kind: 'data', text: 'ENV' });
    expect(resourceGlyph(fileRef('/p/.gitignore'))).toEqual({ kind: 'file', text: 'FILE' });
    expect(resourceGlyph(fileRef('/p/Makefile'))).toEqual({ kind: 'file', text: 'FILE' });
    expect(resourceGlyph(fileRef('/p/archive.tar.zst'))).toEqual({ kind: 'file', text: 'ZST' });
    expect(resourceGlyph(fileRef('/p/src/'))).toEqual({ kind: 'dir', text: 'DIR' });
    expect(resourceGlyph({ ...fileRef('https://x.dev/a.png'), kind: 'url' })).toEqual({ kind: 'url', text: '' });
  });
});

describe('resolveResourceImage', () => {
  const path = '/tmp/issue-42.png';

  it("prefers the row's own image, in any state", () => {
    const own = image('reply', path, 'missing');
    const elsewhere = image('bash', path, 'live');
    const reply: HarnessTranscriptItem = { id: 'reply', kind: 'assistant', text: '', images: [own] };
    const lane = { imageState: { ...createLaneImageState(), live: [elsewhere] }, transcript: [reply] };
    expect(resolveResourceImage(lane, reply, fileRef(path))).toBe(own);
  });

  it('borrows the image an earlier row showed this turn, newest live first', () => {
    const older = image('read', path, 'live');
    const newer = image('bash', path, 'live');
    const reply: HarnessTranscriptItem = { id: 'reply', kind: 'assistant', text: '' };
    const lane = { imageState: { ...createLaneImageState(), live: [older, newer] }, transcript: [reply] };
    expect(resolveResourceImage(lane, reply, fileRef(path))).toBe(newer);
  });

  it('falls back to a reloadable released image but never to a failed one elsewhere', () => {
    const released = image('bash', path, 'released');
    const bash: HarnessTranscriptItem = { id: 'bash', kind: 'tool', text: '', images: [released] };
    const reply: HarnessTranscriptItem = { id: 'reply', kind: 'assistant', text: '' };
    const lane = { imageState: createLaneImageState(), transcript: [bash, reply] };
    expect(resolveResourceImage(lane, reply, fileRef(path))).toBe(released);

    released.state = 'missing';
    expect(resolveResourceImage(lane, reply, fileRef(path))).toBeNull();
  });

  it('ignores non-image files and works without a lane', () => {
    const reply: HarnessTranscriptItem = { id: 'reply', kind: 'assistant', text: '', images: [image('reply', path, 'live')] };
    expect(resolveResourceImage(null, reply, fileRef('/tmp/notes.md'))).toBeNull();
    expect(resolveResourceImage(null, reply, fileRef(path))).not.toBeNull();
  });
});

describe('railCoversImage', () => {
  it('covers only a sealed row image whose path is one of its file references', () => {
    const path = '/tmp/issue-42.png';
    const covered = image('reply', path, 'live');
    const other = image('reply', '/tmp/other.png', 'live');
    const reply: HarnessTranscriptItem = {
      id: 'reply',
      kind: 'assistant',
      text: '',
      images: [covered, other],
      resources: [fileRef(path)],
    };
    expect(railCoversImage(reply, covered)).toBe(false);
    reply.resourcesScanned = true;
    expect(railCoversImage(reply, covered)).toBe(true);
    expect(railCoversImage(reply, other)).toBe(false);
  });
});
