# Rails scans every lockfile for known vulnerabilities as a manual check

> Status: accepted
> Date: 2026-11-06
> Updated: 2026-11-07 — spec 368 makes `osv` a manual check that scans every lockfile whole; see `docs/0368-rails-manual-checks.md`.

## Context

The Rails verifier (ADR-0025) runs the project's checks at every harness quiet point and judges the working diff against HEAD. [OSV-Scanner](https://google.github.io/osv-scanner/) reports known vulnerabilities for the packages in a lockfile; it exits `1` when it finds one. Its answer depends on the lockfile and on the OSV database at that moment, not on the diff. On 2026-11-06 the OSV API listed 179 advisory ids against the three lockfiles (`package-lock.json`, `src-tauri/Cargo.lock`, `raycast/package-lock.json`) as committed. A scan on every run would fail every run, and a newly published advisory would turn Rails red in the middle of a session with no change behind it.

## Decision

The `osv` check (`scripts/rails-osv.py`) is declared `manual = true` in `.krypton/rails.toml` (spec 368): Rails never runs it at a quiet point; only the human starts it, from the Rails dock or with `#rails check osv`. Each run scans every lockfile that exists (`package-lock.json`, `src-tauri/Cargo.lock`, `raycast/package-lock.json`) whole and fails on every known vulnerability in them, whether or not the working diff touches a lockfile. A scan that cannot finish (`osv-scanner` missing from `PATH`, exit `127` or `128`, output that is not JSON) also fails, with output that says it is not a finding, because Rails gives `error` only to a command that cannot start. When no lockfile exists the check prints so and passes.

## Considered Options

- **Fail only on vulnerabilities the change adds** (scan each changed lockfile as it is now and as it is at HEAD, and compare). Rejected on 2026-11-06: the vulnerabilities a lockfile already carried would never show in Rails.
- **Scan whole lockfiles with an ignore list as the baseline** (`[[IgnoredVulns]]` with `ignoreUntil`). Rejected: it hides the same existing vulnerabilities, and 179 ids would need keeping current.
- **Scan on every run.** Rejected for automatic runs: a call to `api.osv.dev` each time the tree changes, and failures that no diff caused. It no longer applies to `osv`: a manual check runs only when the human asks, so there is no call per tree change and its result never colours Rails in the middle of a session.
- **Scan only lockfiles that differ from HEAD** (the 2026-11-06 decision). Replaced on 2026-11-07 by spec 368: vulnerabilities in an unchanged lockfile never showed, and a lockfile edit still turned Rails red for vulnerabilities it did not add.

## Consequences

- Automatic Rails runs never call `osv-scanner` and never touch the network for this check.
- A manual run sends package names and versions (never source) to `api.osv.dev` and needs the network; the check's `timeout_s` is 120.
- As of 2026-11-06 each of the three lockfiles has known vulnerabilities, so a manual run fails until they are fixed.
- The result shows in the check's row in the Rails dock and never colours the tab or footer (spec 368). A failed result rides Send to a lane as its count line, its check file and its rerun command (spec 368 amendment A).
- The output is one row per advisory group with the count last. Rails keeps the last 80 lines and the judge reads the last 2 000 chars, so a long list loses its first rows, never the count; Send carries only that count line.
- A machine without `osv-scanner` fails a manual run with output saying the lockfiles went unscanned.

## Rails

Applies to: `package-lock.json`, `src-tauri/Cargo.lock`, `raycast/package-lock.json`

- No lockfile carries a package with a known vulnerability (OSV). `check:osv`
