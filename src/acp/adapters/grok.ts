// Spec 380 — Grok (`grok agent stdio`, backend id `grok`).
//
// Grok sends typed `rawOutput` (`ReadFile`, `Bash`, `GrepSearch`, …), prefixes
// Bash dumps with `exit: N`, wraps grep hits in `<workspace_result>` and
// numbers `read_file` lines `1→`. Before spec 380 these readers ran on every
// lane; they now run on Grok lanes only.

import { grokRawOutputSections, normalizeToolDump } from '../harness-tool-render';
import type { LaneAdapter } from './types';

export const grokAdapter: LaneAdapter = {
  id: 'grok',
  outputSections: grokRawOutputSections,
  cleanOutput: normalizeToolDump,
  exitPrefix: true,
};
