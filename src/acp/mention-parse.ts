// Krypton — @mention fan-out parser (spec 115).

export interface MentionParseResult {
  targets: string[];
  body: string;
}

export type MentionParseError =
  | { kind: 'unknown_lane'; token: string }
  | { kind: 'self_only' }
  | { kind: 'empty_body' };

/**
 * Parse leading @DisplayName tokens from composer draft. All-or-nothing against roster.
 * Longest roster match per token; does not scan mid-body.
 */
export function parseMentionFanOut(
  draft: string,
  selfDisplayName: string,
  rosterDisplayNames: string[],
): MentionParseResult | MentionParseError {
  const roster = new Set(rosterDisplayNames);
  const byLength = [...rosterDisplayNames].sort((a, b) => b.length - a.length);
  let cursor = 0;
  const text = draft.trimStart();
  const targets: string[] = [];
  const seen = new Set<string>();

  while (cursor < text.length && text[cursor] === '@') {
    let matched: string | null = null;
    for (const name of byLength) {
      const prefix = `@${name}`;
      if (!text.startsWith(prefix, cursor)) continue;
      const next = text[cursor + prefix.length];
      if (next !== undefined && next !== ' ') continue;
      matched = name;
      break;
    }
    if (!matched) {
      const rest = text.slice(cursor);
      const loose = rest.match(/^@([A-Za-z][A-Za-z0-9_-]*)/);
      const token = loose?.[1];
      if (!token) return { kind: 'unknown_lane', token: '@?' };
      const ci = rosterDisplayNames.filter((n) => n.toLowerCase() === token.toLowerCase());
      if (ci.length === 1) matched = ci[0];
      else return { kind: 'unknown_lane', token: `@${token}` };
    } else {
      const ci = rosterDisplayNames.filter((n) => n.toLowerCase() === matched!.toLowerCase());
      if (ci.length !== 1) return { kind: 'unknown_lane', token: `@${matched}` };
      matched = ci[0];
    }
    if (!roster.has(matched)) {
      return { kind: 'unknown_lane', token: `@${matched}` };
    }
    if (!seen.has(matched)) {
      seen.add(matched);
      targets.push(matched);
    }
    cursor += matched.length + 1;
    while (cursor < text.length && text[cursor] === ' ') cursor += 1;
  }

  if (targets.length === 0) {
    return { kind: 'empty_body' };
  }
  const filtered = targets.filter((t) => t !== selfDisplayName);
  if (filtered.length === 0) {
    return { kind: 'self_only' };
  }
  const body = text.slice(cursor).trim();
  if (!body) {
    return { kind: 'empty_body' };
  }
  return { targets: filtered, body };
}
