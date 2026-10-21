// Directory summary (cursor only): "Directory: name/\n\nD directories, F files".

import type { PreviewRenderer } from '../registry';

export const directory: PreviewRenderer = {
  id: 'directory',
  sources: ['cursor'],
  matches: (t) => !!t.entry?.is_dir,
  async render(t, io) {
    const name = t.entry?.name ?? t.name;
    try {
      const children = await io.listDirectory(t.path);
      const dirs = children.filter((c) => c.is_dir).length;
      const files = children.length - dirs;
      return { kind: 'text', text: `Directory: ${name}/\n\n${dirs} directories, ${files} files` };
    } catch {
      return { kind: 'text', text: `Directory: ${name}/\n\n(cannot read)` };
    }
  },
};
