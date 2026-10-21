// Binary extensions (search source): "[binary file]" (quirk P6).

import { isBinaryExtension } from '../../../file-preview';
import type { PreviewRenderer } from '../registry';

export const searchBinary: PreviewRenderer = {
  id: 'search-binary',
  sources: ['search'],
  matches: (t) => isBinaryExtension(t.name),
  render: () => ({ kind: 'text', text: '[binary file]' }),
};
