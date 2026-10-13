// Regression guard for CLAUDE.md constraint 10: a sealed assistant row must
// stop its streaming label pulse. The signature-hit render path never rewrites
// the wrapper, so the seal path itself has to drop the class.
import { describe, expect, it, vi } from 'vitest';

import type { HarnessLane, HarnessTranscriptItem } from './harness-view-types';

// The seal path's DOM-only helpers; the class/signature handoff under test does
// not depend on what they do to the body.
vi.mock('streaming-markdown', async (orig) => ({
  ...(await orig<typeof import('streaming-markdown')>()),
  parser_write: vi.fn(),
  parser_end: vi.fn(),
}));
vi.mock('./harness-markdown', async (orig) => ({
  ...(await orig<typeof import('./harness-markdown')>()),
  streamingMarkdownDroppedTable: () => false,
  resolveLocalImageSrcs: vi.fn(),
}));
vi.mock('./harness-svg-fence', async (orig) => ({
  ...(await orig<typeof import('./harness-svg-fence')>()),
  clearLiveSvgFences: vi.fn(),
  decorateSvgFences: vi.fn(),
}));
vi.mock('./harness-transcript-render', async (orig) => ({
  ...(await orig<typeof import('./harness-transcript-render')>()),
  scanMessageResourceBody: vi.fn(),
  appendMessageResourceRail: vi.fn(),
}));

import { AcpHarnessView } from './acp-harness-view';
import { transcriptRenderSignature } from './harness-transcript-render';

type SealAssistant = (lane: HarnessLane, item: HarnessTranscriptItem) => void;

describe('assistant seal leaves a static row', () => {
  it('drops the streaming class and stamps the sealed signature', () => {
    const classes = new Set([
      'acp-harness__msg',
      'acp-harness__msg--assistant',
      'acp-harness__msg--streaming',
    ]);
    const wrapper = {
      dataset: { msgId: 'a1', renderSignature: 'stream' } as DOMStringMap,
      classList: { remove: (name: string) => classes.delete(name) },
    };
    const body = { classList: { remove: vi.fn() }, innerHTML: '<p>done</p>', parentElement: wrapper };
    const item = { id: 'a1', kind: 'assistant', text: 'done', streamingMarkdownWritten: 4 } as HarnessTranscriptItem;
    const lane = {
      streamingMarkdownParser: {},
      streamingMarkdownBody: body,
      streamingMarkdownItemId: 'a1',
      transcript: [item],
      imageState: { byKey: new Map() },
    } as unknown as HarnessLane;
    // Private method; the view cannot be constructed without Tauri.
    const seal = (AcpHarnessView.prototype as unknown as { sealAssistantStreamingMarkdown: SealAssistant })
      .sealAssistantStreamingMarkdown;

    seal.call({ projectDir: '/tmp', remoteRuntimeId: null, scheduleReferenceGitRefresh: vi.fn() }, lane, item);

    expect(classes.has('acp-harness__msg--streaming')).toBe(false);
    expect(wrapper.dataset.renderSignature).toBe(transcriptRenderSignature(item, false, lane));
  });
});
