// Krypton — File Peek Source
//
// The first `OverviewSource`: resolve a path as written in a terminal buffer or
// a DOM pane, read it, classify it, and expose the escalations that used to be
// hint mode's only behaviour (Helix tab / markdown viewer / OS browser).
//
// See docs/210-quick-overview-dialog.md.

import { invoke } from '@tauri-apps/api/core';

import type { Compositor } from './compositor';
import { openInHelixTab } from './editor-open';
import { openExternalUrl } from './external-url';
import {
  PREVIEW_MAX_BYTES,
  extToLang,
  formatSize,
  isBinaryExtension,
  isMarkdownFile,
} from './file-preview';
import type { OverviewBody, OverviewSource } from './quick-overview';

/** Strip a `file://` prefix and percent-decoding, leaving a plain path. */
export function stripFileUrl(raw: string): string {
  if (!raw.startsWith('file://')) return raw;
  const path = raw.slice('file://'.length);
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * Turn a path that has already had `~` expanded into an absolute path.
 * Throws when it is relative and there is no working directory to anchor it.
 */
export function resolvePeekPath(expanded: string, cwd: string | null): string {
  if (expanded.startsWith('/')) return expanded;
  if (!cwd) throw new Error(`cannot resolve ${expanded} — no working directory`);
  return `${cwd.replace(/\/+$/, '')}/${expanded.replace(/^(\.\/)+/, '')}`;
}

/**
 * Build a read-only peek source for `rawPath` — a path exactly as it appeared
 * on screen, so it may be absolute, `~`-relative, `file://`, or relative to the
 * focused pane's working directory.
 */
export function createFilePeekSource(compositor: Compositor, rawPath: string): OverviewSource {
  /** Absolute path once resolved; null until `load()` runs (or if unresolvable). */
  let resolved: string | null = null;
  let meta = '';

  async function resolve(): Promise<string> {
    const expanded = await compositor.expandVaultPath(stripFileUrl(rawPath));
    if (expanded.startsWith('/')) return expanded;
    return resolvePeekPath(expanded, await compositor.getFocusedWorkingDirectory());
  }

  function escalate(): void {
    const target = resolved ?? rawPath;

    if (isMarkdownFile(target)) {
      compositor.openMarkdownView(target).catch((err: unknown) => {
        console.error('[file-peek] Failed to open markdown viewer:', err);
      });
      return;
    }

    if (/\.html?$/i.test(target)) {
      const url = target.startsWith('/')
        ? 'file://' + target.split('/').map((part) => encodeURIComponent(part)).join('/')
        : target;
      openExternalUrl(url, { external: true });
      return;
    }

    openInHelixTab(compositor, { path: target }).catch((err: unknown) => {
      console.error('[file-peek] Failed to open file in Helix:', err);
    });
  }

  return {
    title: rawPath,
    get meta(): string {
      return meta;
    },

    async load(signal: AbortSignal): Promise<OverviewBody> {
      resolved = await resolve();
      if (signal.aborted) return { kind: 'notice', text: 'cancelled' };

      if (isBinaryExtension(resolved)) {
        meta = 'binary';
        return { kind: 'notice', text: 'binary file — nothing to preview' };
      }

      let content: string;
      try {
        content = await invoke<string>('read_file', { path: resolved });
      } catch (err: unknown) {
        meta = 'unreadable';
        return { kind: 'notice', text: `cannot read ${resolved}` + (err ? ` — ${String(err)}` : '') };
      }
      if (signal.aborted) return { kind: 'notice', text: 'cancelled' };

      const truncated = content.length > PREVIEW_MAX_BYTES;
      const text = truncated ? content.slice(0, PREVIEW_MAX_BYTES) : content;

      if (isMarkdownFile(resolved)) {
        meta = `markdown · ${formatSize(content.length)}`;
        return { kind: 'markdown', text, basePath: resolved };
      }

      const lang = extToLang(resolved);
      const lines = text.split('\n').length;
      meta = `${lang ?? 'text'} · ${formatSize(content.length)} · ${lines} lines`;
      return { kind: 'code', text, lang, truncated };
    },

    actions: [
      {
        key: 'y',
        label: 'copy path',
        closes: false,
        run(): void {
          void navigator.clipboard.writeText(resolved ?? rawPath).catch((err: unknown) => {
            console.error('[file-peek] Failed to copy path:', err);
          });
        },
      },
      {
        key: 'Enter',
        label: 'open',
        run: escalate,
      },
    ],
  };
}
