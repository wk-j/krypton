// Binary extensions (cursor source): "Binary file\n<size>".

import { formatSize, isBinaryExtension } from '../../../file-preview';
import type { PreviewRenderer } from '../registry';

export const binary: PreviewRenderer = {
  id: 'binary',
  sources: ['cursor'],
  matches: (t) => isBinaryExtension(t.name),
  render: (t) => ({ kind: 'text', text: `Binary file\n${formatSize(t.entry?.size ?? 0)}` }),
};
