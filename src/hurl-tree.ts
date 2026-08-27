// Folder expand/collapse helpers shared by HurlContentView.
// The web client (artifact-hurl.html) mirrors these rules inline.

/** Ancestor dirs of a file (`hurl/temp/foo.hurl` → `['hurl', 'hurl/temp']`). */
export function fileAncestorDirs(relPath: string): string[] {
  const segs = relPath.split('/').filter((s) => s.length > 0);
  if (segs.length <= 1) return [];
  segs.pop();
  return prefixChain(segs);
}

/** The dir and its ancestors (`hurl/temp` → `['hurl', 'hurl/temp']`). */
export function dirChain(relPath: string): string[] {
  const segs = relPath.split('/').filter((s) => s.length > 0);
  return prefixChain(segs);
}

function prefixChain(segs: string[]): string[] {
  const out: string[] = [];
  let acc = '';
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s;
    out.push(acc);
  }
  return out;
}

/** Open every ancestor of a file so it is visible in a collapsed-by-default tree. */
export function revealFile(expanded: Set<string>, relPath: string): void {
  for (const dir of fileAncestorDirs(relPath)) expanded.add(dir);
}

/** Open a directory and every ancestor so a nested expand is actually visible. */
export function revealDir(expanded: Set<string>, relPath: string): void {
  for (const dir of dirChain(relPath)) expanded.add(dir);
}

/**
 * First ancestor dir of a file that is not in `expanded`.
 * Null means every ancestor is open, so the file is visible.
 * Used on restore: never reopen a folder the user collapsed, even if the
 * selected file sits inside it — land on this dir instead.
 */
export function collapsedCover(expanded: Set<string>, relPath: string): string | null {
  for (const dir of fileAncestorDirs(relPath)) {
    if (!expanded.has(dir)) return dir;
  }
  return null;
}
