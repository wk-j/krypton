// Files over PREVIEW_MAX_BYTES (cursor only — search previews have no limit, quirk P6).

import { PREVIEW_MAX_BYTES, formatSize } from '../../../file-preview';
import type { PreviewRenderer } from '../registry';

export const tooLarge: PreviewRenderer = {
  id: 'too-large',
  sources: ['cursor'],
  matches: (t) => !!t.entry && t.entry.size > PREVIEW_MAX_BYTES,
  render: (t) => ({ kind: 'text', text: `File too large for preview\n${formatSize(t.entry?.size ?? 0)}` }),
};
