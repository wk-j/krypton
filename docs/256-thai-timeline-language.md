# Thai Timeline Language — Implementation Spec

> Status: Implemented
> Date: 2026-09-19
> Milestone: ACP Harness — project provenance

## Problem

Timeline content and chrome currently mix English with user-authored text. Agent-created records,
trace answers, the capture sheet, and the browser therefore do not consistently serve the Thai
reader even though adjacent Harness workflows already use natural Thai.

## Solution

Make natural Thai the fixed language for timeline prose composed by an agent and for timeline UI
chrome. Preserve evidence exactly as supplied and keep identifiers, paths, enum values, tool names,
and established technical terms in English. Manual input remains unchanged rather than being
silently translated or rejected.

## Research

- Timeline language is controlled at three separate seams: the per-turn lane context for
  `timeline_record` / `timeline_suggest`, the one-shot `#timeline trace` prompt, and fixed strings in
  the capture/browser surfaces. Changing only one seam cannot make the workflow consistent.
- `instruction_excerpt` and `evidence_excerpt` are provenance fields. Translating them would make
  them cease to be exact evidence, so they are explicit exceptions to the Thai prose rule.
- `topic_title`, `summary`, `rationale`, and `impact` are the agent-composed human-readable fields.
  `made_by`, `source_ref`, relations, event IDs, paths, and schema keys are identity or machine data
  and must not be translated.
- Review Board and attention triage already establish the project convention: natural Thai for
  human-facing prose, English for technical terms and machine-parsed grammar.
- Server-side Thai-script detection was rejected. Valid records can consist mainly of identifiers,
  product names, or exact quoted evidence; script heuristics would reject useful data without
  proving that prose is natural Thai.
- Automatic translation of old or manually entered records was rejected because it would mutate
  provenance and could change the meaning of historical decisions.

## Prior Art

| Product / standard | Implementation | Lesson for Krypton |
|--------------------|----------------|--------------------|
| Jira Cloud | The product shell follows an account language preference while project content remains authored data | Localize fixed chrome without rewriting stored records |
| W3C HTML `translate` guidance | Human prose can be translated while code, keywords, names, and other protected content stay unchanged | Separate translatable prose from evidence and technical tokens |
| Krypton Review Board | Prompts require natural Thai but preserve technical terms and parsed keys in English | Reuse the existing project writing policy |
| Krypton attention triage | Lane context requires Thai free-text for a non-code-reading human | Put the rule in ambient lane context, not only documentation |

**Krypton delta** — unlike a selectable application locale, timeline Thai is a product rule for
this workflow. It applies to generated prose and fixed chrome, while original evidence and manual
entries remain faithful to their source.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Require natural Thai in agent-composed timeline fields for direct records and suggestions |
| `src-tauri/src/hook_server.rs` | Mirror the Thai contract in both MCP tool descriptors and cover it in descriptor tests |
| `src/acp/harness-prompts.ts` | Require `#timeline trace` answers to use natural Thai |
| `src/acp/harness-prompts.test.ts` | Assert the trace-language rule and preserved classifications |
| `src/acp/acp-harness-view.test.ts` | Assert both ambient timeline instructions carry the language rule |
| `src/acp/artifact-timeline.html` | Set `lang="th"`, render dates with `th-TH`, and translate fixed browser chrome |
| `src/acp/timeline-capture.ts` | Translate capture/review labels, help, buttons, and local error copy; keep values unchanged |
| `src/acp/timeline.ts` and tests | Return Thai validation messages shown by the capture sheet |
| `docs/72-acp-harness-view.md`, `docs/253-project-decision-requirement-timeline.md`, `docs/254-automatic-timeline-suggestions.md`, `docs/255-natural-language-timeline-recording.md` | Document the language contract at each workflow seam |

## Design

### Language Contract

Agent-authored `topic_title`, `summary`, `rationale`, and `impact` use natural Thai written by
meaning, not word-for-word translation. Technical terms stay English inside Thai sentences.

The following remain verbatim in any language: `instruction_excerpt`, `evidence_excerpt`,
`made_by`, `source_ref`, event/topic IDs, file paths, URLs, commit hashes, enum values, and quoted
source text. Empty optional fields stay empty.

Manual capture stores exactly what the human enters. Existing records are never rewritten.

### API / Commands

No API, schema, command, or persisted Markdown format changes. The existing request fields and
English machine values remain compatible.

### Data Flow

```text
1. Lane context or trace prompt tells the agent which prose fields must be natural Thai.
2. The agent sends the existing timeline payload; provenance and technical tokens remain verbatim.
3. Rust validates and persists the unchanged schema.
4. Capture and browser surfaces render Thai chrome around stored content without translating it.
```

### UI Changes

- The browser document language becomes `th`; fixed headings, labels, empty/error states, ordering
  text, and keyboard help become Thai. Product name `Krypton Timeline` and shortcut keys stay as-is.
- Browser day headings use the explicit `th-TH` locale so output does not depend on OS locale.
- Capture/review sheet labels, placeholders, actions, evidence heading, duplicate warning, and local
  validation errors become Thai. Relation option values remain English because they are API enums;
  their visible labels may be Thai.
- Dynamic stored content is displayed unchanged with `textContent` as today.

## Edge Cases

- A user asks in English to record an event: `instruction_excerpt` remains the exact English
  sentence, while agent-composed event prose is Thai.
- A topic or summary is only an identifier: keep the identifier; do not add filler merely to include
  Thai characters.
- Historical English records remain English and searchable.
- Diagnostic text originating from Rust remains verbatim so troubleshooting details are not lost;
  the surrounding diagnostic heading is Thai.
- A manual entry uses another language: save it unchanged; do not reject or translate it.

## Open Questions

None. The source-fidelity exceptions above define what “always Thai” means without corrupting
evidence or breaking machine contracts.

## Out of Scope

- Runtime locale selection or a new config key
- Translation services or language detection
- Migration/backfill of existing timeline files
- Translating identifiers, enums, technical terms, evidence, or user-entered content
- Changing the timeline schema or authorization model

## Resources

- [Atlassian account language preferences](https://support.atlassian.com/atlassian-account/docs/manage-your-language-preferences/) — product chrome follows a selected language independently of authored project data.
- [W3C: Using HTML's `translate` attribute](https://www.w3.org/International/questions/qa-translate-flag/) — distinguishes translatable prose from protected code, keywords, and names.
- [W3C Internationalization Tag Set 2.0](https://www.w3.org/TR/its/) — formal prior art for marking content that must remain untranslated.
