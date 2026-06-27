import { describe, expect, it } from 'vitest';

import { DocArtifactRequestQueue } from './artifact-feedback';
import { LaneBus } from './lane-bus';

describe('DocArtifactRequestQueue', () => {
  it('drains doc artifact requests into a source-linked artifact prompt', () => {
    const bus = new LaneBus();
    let status: 'busy' | 'idle' = 'busy';
    const injected: string[] = [];
    const queue = new DocArtifactRequestQueue(
      bus,
      () => status,
      (_laneId, text) => injected.push(text),
    );

    expect(
      queue.accept('lane-1', {
        kind: 'doc_artifact_request',
        batchId: 'da-1',
        harnessId: 'hm-1',
        docPath: 'docs/171-docs-browser.md',
        title: 'Docs artifact · 171-docs-browser.md',
        sentAt: 1,
      }),
    ).toBe('accepted');
    expect(
      queue.accept('lane-1', {
        kind: 'doc_artifact_request',
        batchId: 'da-2',
        harnessId: 'hm-1',
        docPath: 'docs/174-docs-browser-artifact-export.md',
        title: 'Docs artifact · 174-docs-browser-artifact-export.md',
        sentAt: 2,
      }),
    ).toBe('accepted');
    expect(injected).toHaveLength(0);

    status = 'idle';
    bus.emit({
      type: 'lane:status',
      payload: { laneId: 'lane-1', prev: 'busy', next: 'idle', at: 3 },
    });

    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('Read each SOURCE markdown file');
    expect(injected[0]).toContain('### Source: docs/171-docs-browser.md');
    expect(injected[0]).toContain('Docs artifact · 171-docs-browser.md');
    expect(injected[0]).toContain('### Source: docs/174-docs-browser-artifact-export.md');
    expect(injected[0]).toContain('Docs artifact · 174-docs-browser-artifact-export.md');
    expect(injected[0]).toContain('call artifact_new');
    expect(injected[0]).toContain('call artifact_register');

    queue.dispose();
  });
});
