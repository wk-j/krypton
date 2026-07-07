# Verb composition is inline token substitution, resolved once into a single prompt — not a workflow engine

> Status: accepted
> Date: 2026-07-07

## Context

Krypton ships built-in [[Verb]]s — one-job system prompts injected into a
[[Lane]] from the `#` palette (`#fix-issue`, `#polly`, `#wiki`, `#review`, …),
project-agnostic and needing no per-project `.claude/skills/`. We want authors to
build **bigger** verbs out of smaller ones (e.g. a GitHub-issue verb that first
analyses, then fixes, then comments) without re-writing each sub-prompt.

The obvious framing — "a workflow is an ordered list of verbs `[a → b → c]` run
in sequence" — is a trap. It implies a **runner**: a multi-turn driver that
executes step 1 to completion, waits for idle, runs step 2, and so on, with
per-step state and possibly cross-lane operations. Krypton already has the
substrate that would tempt this (`queuedPrompts`, spec 136, drains one prompt per
idle turn), so building the engine is *easy* — which is exactly why it needs an
explicit decision to **not**.

## Decision

Verb composition is **inline token substitution**, not a pipeline:

- **A verb name is a token.** A verb's prompt may embed another verb by token
  (`{{#analyze-github-issue}}`) *anywhere inline* in its prose — once, many
  times, or inside conditional/connective instructions the author writes around
  it. A composing verb is **free-form prompt prose with verb tokens in it**, not
  an ordered array of steps.
- **The resolver substitutes each token with the referenced verb's rendered
  prompt text**, producing ONE combined prompt.
- **That prompt is sent to the lane in a single turn.** There is no runner, no
  per-step turn boundary, no queue drain, no cross-turn state. The LLM reads the
  combined prompt and carries out the work in its own flow.
- **Only prompt-verbs are injectable.** A token resolves to prompt *text*, so a
  verb must have text to substitute. A **control-op verb** — one that performs an
  operation rather than carrying a prompt, e.g. the `#fix-issue` **dispatch**
  (spawns/targets a lane, sets its [[Goal]], clears its session) — has nothing to
  substitute and **cannot be a token**.
- **Resolution is guarded.** The resolver tracks a visited set and a max depth so
  a cycle (`a` embeds `b` embeds `a`) or runaway nesting fails loudly at
  invocation rather than expanding forever.
- **Composed verbs are themselves verbs.** A composed verb can be invoked
  directly, appears in the `#` palette and the `/commands` manifest (spec 185)
  like any other, and can be nested inside another composed verb (subject to the
  cycle/depth guard).

## Considered Options

- **Serial pipeline `[a → b → c]` with a multi-turn runner.** Rejected: it is the
  workflow engine we are deliberately declining. It reopens per-step state,
  turn-boundary orchestration, and failure/retry semantics — a large surface for
  a feature whose whole appeal is "verbs are just prompts." The user's explicit
  ask was to *not* make this complex.
- **A `composedOf: string[]` field on the verb definition.** Rejected: it forces
  composition into a rigid ordered list and loses the ability to place a verb
  mid-sentence, conditionally, or more than once. Inline tokens in prose are
  strictly more expressive and match how the author already writes a prompt.
- **Queue-drain execution reusing `queuedPrompts` (spec 136).** Rejected for
  composition: enqueuing each sub-verb as its own prompt is the multi-turn runner
  by another name. `queuedPrompts` remains for its existing purpose (queueing
  prompts typed while a lane is busy); composition does not touch it.
- **Letting control-op verbs (dispatch) participate as tokens.** Rejected:
  substituting an operation into prompt text is a category error. Cross-lane
  fan-out is [[Orchestration]] (spec 180), a different mechanism; a composed verb
  runs on one lane in one turn.

## Consequences

- The *only* new machinery is a string resolver (token scan + substitute +
  cycle/depth guard). No executor, no scheduler, no new lane lifecycle. This is
  why the feature stays small.
- Composition inherits every verb property for free: discoverability in the `#`
  palette and `/commands` page, project-agnostic availability, and the "lane uses
  its own tools" execution model — because the output is still just a prompt.
- The single-turn model bounds what a composed verb can express: everything must
  fit one prompt the LLM executes in one flow. Genuinely cross-lane or
  operation-level work (dispatch, spawning reviewers) stays outside composition
  and is done with the existing control-op verbs / orchestrator — by design.
- Because the result is one prompt, a composed GitHub-issue verb that ends in
  `{{#post-github-comment}}` will have the lane post to GitHub within the same
  turn with no human gate (see spec 191 §Risk) — the author of the composed verb
  owns that sequencing decision, the same way they own any prompt they write.
- **The same resolver also runs on a free-form user prompt.** A user's typed
  message is just prose, so the harness applies the identical token scan +
  substitution before sending it: a user may embed `{{#analyze-github-issue}}` (or
  any injectable verb) at any position of their message and it expands in place.
  This needs no new machinery — a user prompt is a composing prompt whose author
  happens to be the human. Control-op verbs remain non-injectable, and a bad/cyclic
  token fails loudly (flash) instead of sending a half-expanded prompt.
