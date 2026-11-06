# Rails scans a changed lockfile whole for known vulnerabilities

> Status: accepted
> Date: 2026-11-06

## Context

The Rails verifier (ADR-0025) runs the project's checks at every harness quiet point and judges the working diff against HEAD. [OSV-Scanner](https://google.github.io/osv-scanner/) reports known vulnerabilities for the packages in a lockfile; it exits `1` when it finds one. Its answer depends on the lockfile and on the OSV database at that moment, not on the diff. On 2026-11-06 the OSV API listed 179 advisory ids against the three lockfiles (`package-lock.json`, `src-tauri/Cargo.lock`, `raycast/package-lock.json`) as committed. A scan on every run would fail every run, and a newly published advisory would turn Rails red in the middle of a session with no change behind it.

## Decision

The `osv` check (`scripts/rails-osv.py`) scans only when a lockfile's content differs from HEAD. It then scans each changed lockfile whole and fails on every known vulnerability in it, the ones the change brought in and the ones the lockfile already carried alike: a lockfile edit is when its dependencies get looked at, so the check lists everything known against them. A scan that cannot finish (`osv-scanner` missing from `PATH`, exit `127` or `128`, output that is not JSON) also fails, with output that says it is not a finding, because Rails gives `error` only to a command that cannot start. A lockfile that does not change is not scanned; its vulnerabilities are a full scan's job (`osv-scanner scan -r .` or a scheduled CI scan).

## Considered Options

- **Fail only on vulnerabilities the change adds** (scan each changed lockfile as it is now and as it is at HEAD, and compare). Rejected on 2026-11-06: the vulnerabilities a lockfile already carried would never show in Rails.
- **Scan whole lockfiles with an ignore list as the baseline** (`[[IgnoredVulns]]` with `ignoreUntil`). Rejected: it hides the same existing vulnerabilities, and 179 ids would need keeping current.
- **Scan on every run.** Rejected: a call to `api.osv.dev` each time the tree changes, and failures that no diff caused.

## Consequences

- A change to a lockfile fails the check until every known vulnerability in that lockfile is fixed, even when the change itself adds none. As of 2026-11-06 each of the three lockfiles has some, so any edit to one of them turns Rails red.
- The output is one row per advisory group with the count last. Rails keeps the last 80 lines and the judge reads the last 2 000 chars, so a long list loses its first rows, never the count.
- A run that changes a lockfile sends package names and versions (never source) to `api.osv.dev` and needs the network; the check's `timeout_s` is 120.
- A machine without `osv-scanner` fails the check whenever a lockfile changes, and passes it otherwise.

## Rails

Applies to: `package-lock.json`, `src-tauri/Cargo.lock`, `raycast/package-lock.json`

- A lockfile that differs from HEAD carries no package with a known vulnerability (OSV). `check:osv`
