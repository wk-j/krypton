# Remove MiMo Integration

> Status: Implemented
> Approval: Full-removal implementation plan approved in conversation.

## Scope

Remove MiMo as a Krypton ACP backend, including its registration, implicit
`mimo/mimo-auto` model, startup hints, label, SVG logo, and backend-only CSS.
Keep explicit configured-model selection for supported backends unchanged.

## Design

- `resolve_backend("mimo")` returns `None`; backend listing no longer advertises it.
  Existing spawn and model-memory commands reject unknown backends normally.
- `harnessBackends()` excludes MiMo even if an older remote runtime advertises it.
  The shared list drives lane creation, session selection, and control validation.
- Other backends retain their existing palette indexes. The shared accent palette
  remains general-purpose; its colours are not removed with a backend.
- Supported-backend documentation and configuration comments match the removal.
  Explicitly dated historical probe records remain historical records.

## Data Safety

Do not uninstall external CLI software or rewrite user configuration, saved
transcripts, sessions, or remembered model settings. No storage migration is needed.

## Validation

Regression tests cover removed-backend resolution, local/remote picker exclusion,
and configured-model handling. Run frontend tests, type checking, production build,
Rust ACP tests, formatting checks, and Clippy; report unrelated repository failures
without changing unrelated code.