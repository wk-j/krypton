// Krypton — local image-path discovery in tool payloads and prose (spec 281).
//
// Pure: no IPC and no Tauri imports, so the spec 380 lane decoder can scan tool
// calls for image paths and the spec 381 gallery can run that decoder in a
// browser. `harness-images.ts` resolves, reads and owns the images, and
// re-exports these scanners.

/** Path images per row (same cap as retained tool content blocks). */
export const MAX_PATH_IMAGES_PER_ROW = 8;
/** Text scanned per source, same bound as tool retention. */
export const IMAGE_SCAN_TEXT_LIMIT = 64 * 1024;

export const IMAGE_PATH_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const REJECTED_PATH_CHARS = /[()[\]{}<>|"'*?$`=\n\r\t]/;
const LEADING_TRIM = /^[([{<"'`]+/;
const TRAILING_TRIM = /[)\]}>"'`.,;:!?]+$/;
export const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function isImagePath(value: string): boolean {
  return IMAGE_PATH_EXTENSIONS.test(value);
}

export interface ImagePathScan {
  paths: string[];
  overflow: number;
}

/** Image paths in free text (prose, shell commands, tool output), in order,
 *  deduped, capped at `max`. Bare file names (`shot.png`) are ignored. */
export function findImagePaths(text: string, max = MAX_PATH_IMAGES_PER_ROW): ImagePathScan {
  const seen = new Set<string>();
  const paths: string[] = [];
  let overflow = 0;
  for (const token of shellTokens(text.slice(0, IMAGE_SCAN_TEXT_LIMIT))) {
    const candidate = cleanPathToken(token);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (paths.length < max) paths.push(candidate);
    else overflow += 1;
  }
  return { paths, overflow };
}

/** Walk every string inside a tool's rawInput / rawOutput. A string that is
 *  wholly one path counts even with spaces; anything else is tokenized. */
export function scanValueForImagePaths(value: unknown, max = MAX_PATH_IMAGES_PER_ROW): ImagePathScan {
  const seen = new Set<string>();
  const paths: string[] = [];
  let overflow = 0;
  let budget = IMAGE_SCAN_TEXT_LIMIT;
  const push = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    if (paths.length < max) paths.push(path);
    else overflow += 1;
  };
  const visit = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > 8) return;
    if (typeof node === 'string') {
      const text = node.slice(0, budget);
      budget -= text.length;
      const whole = text.trim();
      // A whole value may contain spaces only when it is unmistakably a path.
      // Tokens are still scanned: a space-separated list of paths also matches
      // the whole-value shape, and its wrong whole candidate drops silently.
      if (whole && isImagePath(whole) && /^(\/|~\/|\.\.?\/|file:\/\/)/i.test(whole) && !/[<>|"'`*?$\n\r]/.test(whole)) {
        push(whole);
      }
      const scan = findImagePaths(text, Number.POSITIVE_INFINITY);
      for (const path of scan.paths) push(path);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const child of Object.values(node as Record<string, unknown>)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return { paths, overflow };
}

function hasPathForm(value: string): boolean {
  if (value.startsWith('-')) return false;
  if (/^(\/|~\/|\.\.?\/)/.test(value)) return true;
  if (/^file:\/\//i.test(value)) return true;
  if (URI_SCHEME.test(value)) return false;
  return value.includes('/');
}

function cleanPathToken(token: string): string | null {
  let value = token.replace(LEADING_TRIM, '').replace(TRAILING_TRIM, '');
  // `--output=/tmp/x.png`, `out=./a.png`
  const eq = value.indexOf('=');
  if (eq !== -1) value = value.slice(eq + 1).replace(LEADING_TRIM, '');
  if (!value || !isImagePath(value)) return null;
  if (REJECTED_PATH_CHARS.test(value)) return null;
  if (/^(https?|data|blob):/i.test(value)) return null;
  return hasPathForm(value) ? value : null;
}

/** Shell-like split: whitespace and `; | & < >` separate outside quotes; a
 *  quote only opens at a token start (so prose apostrophes stay literal);
 *  backslash escapes the next character outside quotes. */
function shellTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const flush = (): void => {
    if (current) tokens.push(current);
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        flush();
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        current += text[++i];
      } else if (ch === '\n') {
        // An unterminated quote never spans lines.
        quote = null;
        flush();
      } else {
        current += ch;
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && current === '') {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length && text[i + 1] === ' ') {
      current += ' ';
      i++;
      continue;
    }
    if (/\s/.test(ch) || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>' || ch === '`') {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}
