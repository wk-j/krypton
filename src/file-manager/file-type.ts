// Krypton — File Manager file-type colouring (spec 317). Pure, moved verbatim.

import type { FileEntry } from './types';

/** Return a CSS modifier class for file type colouring, or '' for unknown types. */
export function fileTypeClass(entry: FileEntry): string {
  if (entry.is_dir || entry.is_symlink) return '';
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  const base = entry.name.toLowerCase();
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'].includes(ext)) return 'krypton-file-manager__item--ft-script';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go',
       'c', 'cpp', 'cc', 'h', 'hpp', 'java', 'kt', 'swift', 'rb', 'php',
       'lua', 'zig', 'cs', 'scala', 'r', 'dart', 'ex', 'exs', 'erl',
       'hs', 'ml', 'clj', 'el', 'lisp', 'pl', 'pm', 'vim'].includes(ext)
      || base === 'makefile' || base === 'gnumakefile' || base === 'dockerfile') return 'krypton-file-manager__item--ft-code';
  if (['json', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'lock', 'env'].includes(ext)
      || base.startsWith('.') && ['gitignore', 'editorconfig', 'eslintrc', 'prettierrc',
         'babelrc', 'npmrc', 'env', 'envrc'].some(s => base.endsWith(s))) return 'krypton-file-manager__item--ft-config';
  if (['html', 'htm', 'css', 'scss', 'less', 'xml', 'svg', 'graphql', 'gql'].includes(ext)) return 'krypton-file-manager__item--ft-markup';
  if (['md', 'markdown', 'txt', 'rst', 'pdf', 'doc', 'docx'].includes(ext)) return 'krypton-file-manager__item--ft-doc';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif', 'tiff', 'tif'].includes(ext)) return 'krypton-file-manager__item--ft-image';
  if (['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv'].includes(ext)) return 'krypton-file-manager__item--ft-media';
  if (['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst'].includes(ext)) return 'krypton-file-manager__item--ft-archive';
  if (['csv', 'sql', 'db', 'sqlite', 'sqlite3', 'parquet'].includes(ext)) return 'krypton-file-manager__item--ft-data';
  return '';
}
