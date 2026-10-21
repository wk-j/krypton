// Krypton — File Manager shared types (spec 317).

/** A file/directory entry returned by the backend list_directory command */
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: number;
  permissions: string;
  symlink_target: string | null;
}

export type SortField = 'name' | 'size' | 'modified';
export type SortOrder = 'asc' | 'desc';

/** Prompt state for inline status-bar input (rename, mkdir, etc.) */
export interface PromptState {
  label: string;
  value: string;
  onSubmit: (value: string) => void;
}

export interface ClipboardState {
  paths: string[];
  op: 'copy' | 'cut';
}

/** What the preview pane shows. */
export type PreviewOutput =
  /** `<pre>.textContent`, markdown div hidden */
  | { kind: 'text'; text: string }
  /** `<pre>.innerHTML` (hljs output), markdown div hidden */
  | { kind: 'html'; html: string }
  /** markdown div innerHTML, `<pre>` hidden, `img` max-width 100% */
  | { kind: 'markdown'; html: string };

/** null = leave className as it is (the `Y` "Copied:" flash, quirk P7). */
export type StatusTone = 'normal' | 'prompt' | 'filter' | 'error' | 'confirm' | null;
