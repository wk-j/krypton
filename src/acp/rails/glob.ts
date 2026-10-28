// Krypton — Rails verifier (spec 337): `Applies to:` globs.
//
// Globs are repo-relative and anchored at both ends. `**` spans any number of
// path segments (zero included), `*` stays inside one segment, `?` is one
// non-slash character. Everything else, dots included, is literal.

const cache = new Map<string, RegExp>();

function escapeRegExp(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(glob: string): RegExp {
  const source = glob.trim().replace(/^\.\//, '');
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '*' && source[i + 1] === '*') {
      const atSegmentStart = i === 0 || source[i - 1] === '/';
      const next = source[i + 2];
      if (atSegmentStart && next === '/') {
        // `**/` — zero or more whole directories.
        out += '(?:[^/]*/)*';
        i += 3;
        continue;
      }
      if (atSegmentStart && next === undefined) {
        // Trailing `**` — anything below, at any depth.
        out += '.*';
        i += 2;
        continue;
      }
      // `a**b` is not a segment wildcard: same as `*`.
      out += '[^/]*';
      i += 2;
      continue;
    }
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRegExp(ch);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

function compiled(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re;
}

export function matchesAnyGlob(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => compiled(glob).test(path));
}
