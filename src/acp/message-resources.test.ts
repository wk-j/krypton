import { describe, expect, it } from 'vitest';

import { assistantMessageEvent } from './client';
import { sanitizeHref } from './harness-markdown';
import {
  classifyResourceTarget,
  extractResourcesFromBody,
  MAX_MESSAGE_RESOURCES,
  mergeMessageResources,
  resourceFromContentBlock,
} from './message-resources';

describe('assistant response resources', () => {
  it('preserves ACP resource chunks and message boundaries', () => {
    expect(assistantMessageEvent({
      type: 'resource_link',
      uri: './src/main.ts:12:4',
      title: 'Main entry',
      description: 'Application entry point',
      mimeType: 'text/typescript',
      size: 240,
    }, 'message-7')).toEqual({
      type: 'message_chunk',
      text: '',
      content: {
        type: 'resource_link',
        uri: './src/main.ts:12:4',
        name: undefined,
        title: 'Main entry',
        description: 'Application entry point',
        mimeType: 'text/typescript',
        size: 240,
      },
      messageId: 'message-7',
    });
  });

  it('normalizes typed file resources with line and column metadata', () => {
    const resource = resourceFromContentBlock({
      type: 'resource_link',
      uri: '../shared/model.ts#L18:6',
      title: 'Shared model',
      mimeType: 'text/typescript',
    }, '/workspace/app');
    expect(resource).toMatchObject({
      key: 'file:/workspace/shared/model.ts:18:6',
      kind: 'file',
      target: '/workspace/shared/model.ts',
      label: 'Shared model',
      source: 'protocol',
      line: 18,
      column: 6,
      mimeType: 'text/typescript',
    });
  });

  it('treats a bare filename location as a file rather than a URI scheme', () => {
    expect(classifyResourceTarget('client.ts:12:4', '/workspace/app', {
      source: 'markdown',
    })).toMatchObject({
      target: '/workspace/app/client.ts',
      line: 12,
      column: 4,
    });
    expect(classifyResourceTarget('custom:thing', '/workspace/app', {
      source: 'markdown',
    })).toBeNull();
  });

  it('extracts only explicit safe anchors in DOM order', () => {
    const anchors = [
      fakeAnchor('./docs/guide.md:9', 'Guide'),
      fakeAnchor('https://example.com/reference?q=1', 'Web reference'),
      fakeAnchor('javascript:alert(1)', 'Unsafe'),
      fakeAnchor('#local-heading', 'Fragment'),
      fakeAnchor('data:text/plain,nope', 'Data'),
    ];
    const body = { querySelectorAll: () => anchors } as unknown as ParentNode;
    const resources = extractResourcesFromBody(body, '/workspace/project');
    expect(resources.map((resource) => resource.kind)).toEqual(['file', 'url']);
    expect(resources[0]).toMatchObject({
      target: '/workspace/project/docs/guide.md',
      line: 9,
      label: 'Guide',
    });
    expect(resources[1]).toMatchObject({
      target: 'https://example.com/reference?q=1',
      label: 'Web reference',
    });
  });

  it('retains file hrefs for sealed-DOM extraction while suppressing unsafe schemes', () => {
    expect(sanitizeHref(' file:///workspace/src/lib.rs#L4 ')).toBe('file:///workspace/src/lib.rs#L4');
    expect(sanitizeHref('javascript:alert(1)')).toBe('#');
  });

  it('deduplicates equivalent typed and Markdown targets without changing first appearance', () => {
    const markdown = classifyResourceTarget('file:///workspace/src/lib.rs#L4', '/workspace', {
      source: 'markdown',
      label: 'lib.rs',
    });
    const protocol = classifyResourceTarget('/workspace/src/lib.rs:4', '/workspace', {
      source: 'protocol',
      label: 'Library source',
      mimeType: 'text/rust',
    });
    const web = classifyResourceTarget('https://example.com/docs', '/workspace', {
      source: 'markdown',
      label: 'Docs',
    });
    expect(markdown).not.toBeNull();
    expect(protocol).not.toBeNull();
    expect(web).not.toBeNull();
    const merged = mergeMessageResources(
      [markdown!, web!],
      [protocol!],
    );
    expect(merged.resources).toHaveLength(2);
    expect(merged.resources[0]).toMatchObject({
      label: 'Library source',
      source: 'protocol',
      mimeType: 'text/rust',
    });
    expect(merged.resources[1].label).toBe('Docs');
  });

  it('caps unique resources and reports hidden overflow', () => {
    const incoming = Array.from({ length: MAX_MESSAGE_RESOURCES + 3 }, (_, index) => (
      classifyResourceTarget(`https://example.com/${index}`, null, {
        source: 'markdown',
      })!
    ));
    const merged = mergeMessageResources([], incoming);
    expect(merged.resources).toHaveLength(MAX_MESSAGE_RESOURCES);
    expect(merged.overflow).toBe(3);
  });
});

function fakeAnchor(href: string, text: string): Pick<HTMLAnchorElement, 'getAttribute' | 'textContent'> {
  return {
    getAttribute: (name: string) => name === 'href' ? href : null,
    textContent: text,
  };
}
