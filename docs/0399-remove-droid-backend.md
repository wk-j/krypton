# Droid Backend Removal

> Status: Implemented
> Approval: Full removal ordered in conversation ("Remove droid from harness").

## Scope

Remove Factory Droid as an ACP backend throughout Krypton, not merely from the
lane picker. Backend discovery no longer advertises it and backend resolution
rejects it before spawning a process. This applies to local and remote harnesses
and other callers of the shared ACP transport.

## Implementation

- Remove the `droid` registration from `builtin_backends()` and the spawn-time
  `-m` CLI model flag that only Droid used.
- Exclude `droid` from `harnessBackends()` even if an older remote runtime
  advertises it. The shared list drives lane creation, session selection, and
  control validation.
- Remove Droid's label, SVG logo, accent match, and backend-only CSS tokens.
  Keep the accent palette and remaining backend slot assignments stable.
- Supported-backend documentation and configuration comments match the removal.
  Spec 86 is retired as historical design context.

## Data Safety

Do not uninstall the external `droid` CLI or rewrite user configuration, saved
transcripts, sessions, or remembered model settings. Old `lane_models.droid`
entries remain parseable but have no effect because the backend no longer
exists. No Krypton-generated overlay or storage migration is needed.

## Validation

Regression tests cover removed-backend resolution, picker exclusion, and
`advertise_read_text_file` for remaining backends. Run the affected frontend
tests, type checking, and Rust ACP tests.

## Resources

N/A — internal removal; the implementation plan follows specs 393 and 394.
