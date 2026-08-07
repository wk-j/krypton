// Krypton — Shared File Preview Helpers
// Extension classification, size formatting, and the shared `marked` instance
// used by every surface that renders file content: the file manager preview
// pane and the Quick Overview dialog (docs/210-quick-overview-dialog.md).

import hljs from 'highlight.js';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

/** Upper bound on how much of a file any preview surface renders. */
export const PREVIEW_MAX_BYTES = 65536;

/** Marked instance for rendering markdown previews with syntax-highlighted code. */
export const previewMarked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

/** Map a filename to a highlight.js language id, or null when unknown. */
export function extToLang(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    rs: 'rust', py: 'python', rb: 'ruby', go: 'go', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    xml: 'xml', sql: 'sql', graphql: 'graphql',
    dockerfile: 'dockerfile', makefile: 'makefile',
    lua: 'lua', r: 'r', dart: 'dart', zig: 'zig',
    ex: 'elixir', exs: 'elixir', erl: 'erlang',
    hs: 'haskell', ml: 'ocaml', clj: 'clojure',
    vim: 'vim', el: 'lisp', lisp: 'lisp',
    php: 'php', pl: 'perl', pm: 'perl',
  };
  // Handle dotfiles like Makefile, Dockerfile
  const basename = name.split('/').pop()?.toLowerCase() ?? '';
  if (basename === 'makefile' || basename === 'gnumakefile') return 'makefile';
  if (basename === 'dockerfile') return 'dockerfile';
  return map[ext] ?? null;
}

export function isMarkdownFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

export function isBinaryExtension(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const binary = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
    'mp4', 'avi', 'mkv', 'mov', 'webm',
    'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class',
    'wasm', 'ttf', 'otf', 'woff', 'woff2', 'eot',
  ]);
  return binary.has(ext);
}

/** Human-readable byte count, e.g. `21.4K`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}
