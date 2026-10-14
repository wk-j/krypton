# GitHub Release Automation — Implementation Spec

> Status: Implemented
> Date: 2026-10-14
> Milestone: Distribution — versioned releases

## Problem

Krypton has a GitHub Action that builds four `krypton-remote` assets after a Release is published, but no Action builds the macOS app or creates the Release. A maintainer currently has to coordinate the app build and publication by hand, and a Release may appear before all required binaries exist.

## Solution

A pushed `vX.Y.Z` tag starts one release workflow. It validates the tag and project versions, runs the release checks, builds signed and notarized macOS DMGs for Apple Silicon and Intel, and builds the four existing remote runtime targets. A final job publishes one GitHub Release only after every build succeeds and every expected asset has been collected. The existing remote runtime job moves into that workflow so publication does not depend on a second workflow event.

## Research

- Previously, `.github/workflows/remote-runtime-release.yml` ran on `release.published`, verified `v<app Cargo version> == v<remote Cargo version>`, and uploaded four executables plus SHA-256 files. `src-tauri/src/remote_harness.rs` downloads those exact filenames from the matching Krypton release.
- `Makefile` builds the Tauri app, `kryptonctl`, and `krypton-bridge`; `make install` also builds the browser extension. The new Release distributes the GUI DMG, while those separate local-install outputs need their own packaging design. `src-tauri/tauri.conf.json` sets `signingIdentity` to the local `Krypton Dev` identity. GitHub runners cannot be assumed to have that identity.
- The application version currently appears in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/remote-runtime/Cargo.toml`, and `src-tauri/Cargo.lock`. The release gate must reject mismatches before a build.
- GitHub does not start a second workflow from a Release created with the same workflow's `GITHUB_TOKEN`. Keeping `release.published` as the sole remote asset trigger would silently omit the helpers from an automated release.
- Tauri's macOS distribution guide supports CI certificate import through `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and notarization with Apple credentials. Tauri's app bundler notarizes the `.app`; the downloadable DMG also needs a separate `notarytool submit` and `stapler staple` pass. A Developer ID build must be notarized. Ad hoc signing requires users to approve the app in macOS Privacy & Security.
- GitHub workflow artifacts transfer outputs between jobs. GitHub CLI can create a draft release for an existing tag, upload assets, and publish it after upload succeeds.
- Repository secret names could not be inspected: `gh secret list` could not reach `api.github.com`. Secret availability is therefore an operational prerequisite, not a verified fact.

## Prior Art

Tauri's official GitHub pipeline uses `tauri-action` to build native bundles and publish a GitHub Release. Krypton needs an additional release gate because the app's matching remote runtime binaries must be present at the same tag. The proposed workflow uses the standard tag, build, artifact, publish sequence and keeps Krypton's existing remote asset names.

## Affected Files

| File | Change |
|------|--------|
| `.github/workflows/release.yml` | New tag-triggered validation, macOS app builds, four remote builds, and final publication. |
| `.github/workflows/remote-runtime-release.yml` | Remove the separate `release.published` path after moving its build and checksum logic into `release.yml`. |
| `scripts/verify-release.py`, `scripts/test-verify-release.py` | Make version and asset checks locally executable and cover failure cases. |
| `src-tauri/src/git.rs`, `src-tauri/src/timeline.rs`, `src-tauri/src/typesafe.rs` | Clear three existing test-only Clippy warnings so the release gate can enforce `-D warnings` on the current Rust toolchain. |
| `README.md` | Document version bump, tag push, required GitHub secrets, release output, and verification. |
| `docs/0247-remote-acp-harness.md` | Point remote asset publication to the unified workflow. |
| `docs/README.md` | Add this spec to the index. |

## Design

### Trigger and validation

1. A maintainer updates version files and lockfiles, merges the release commit to `master`, then pushes an annotated `vX.Y.Z` tag on that commit. The workflow runs on `push.tags: ['v*']`, with one concurrency group per tag.
2. A read-only gate checks the full tag against `^v[0-9]+\.[0-9]+\.[0-9]+$`, requires an annotated tag, verifies that it points to a commit on `origin/master`, and rejects an existing published Release for the tag.
3. The gate compares the tag version with the root `package.json` and `package-lock.json`, Tauri config, `app` and `krypton-remote` Cargo package versions, and their `Cargo.lock` entries. It rejects a stale lockfile instead of editing it in CI.
4. The gate runs `npm ci`, `npm test`, `npm run check`, `cargo fmt -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`. `npm run build` is exercised by each Tauri build's `beforeBuildCommand`.

### macOS builds

1. A matrix uses the existing `macos-15` Apple Silicon and `macos-15-intel` runner labels, one native target per runner. Each job sets up Node and Rust, installs dependencies with `npm ci`, and imports the base64 Developer ID Application certificate into a temporary keychain.
2. The job selects that Developer ID identity through `APPLE_SIGNING_IDENTITY`, overriding the local `Krypton Dev` choice, and supplies `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), and `APPLE_TEAM_ID` for Tauri notarization. Missing credentials, signing failure, or notarization failure stops the job. The workflow must never fall back to an unsigned or ad hoc public artifact.
3. The job runs `npx tauri build --bundles dmg` for its native architecture. Tauri's `beforeBuildCommand` stages the bundled `krypton-remote` and builds the frontend. It verifies the app signature and notarization ticket, submits the DMG to Apple's notary service, staples its ticket, and validates the resulting DMG before packaging.
4. It uploads a versioned DMG and its SHA-256 file as workflow artifacts. The Release does not claim to install `kryptonctl`, `krypton-bridge`, or the browser extension.

### Remote builds and publication

1. A four-target matrix retains the current macOS/Linux runner and Rust target mapping. Each job builds `krypton-remote` with `cargo build --release --locked`, then uploads `krypton-remote-<target>` and its `.sha256` file as workflow artifacts.
2. The final job needs the validation and all build jobs. It downloads artifacts, rejects missing, duplicate, empty, or unexpectedly named files, and verifies local SHA-256 files.
3. With `contents: write` limited to this job, it creates or resumes a draft Release for the existing tag using `gh release create --draft --verify-tag --generate-notes`, uploads the expected files, checks the remote asset inventory, then publishes the draft. If upload or verification fails, the Release stays a draft.
4. Reruns may resume that draft, but a published Release is immutable to this workflow. A failed build never creates a visible Release. Human-created releases are outside this automated path.

### Required GitHub secrets

`APPLE_CERTIFICATE` (base64 `.p12` Developer ID Application certificate), `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), and `APPLE_TEAM_ID`. The repository's `GITHUB_TOKEN` has read-only access in the validation job and `contents: write` only in the final publication job. No personal access token is required.

## Edge Cases

- A tag with a wrong version, stale lockfile, or commit outside `master` fails before publication.
- Any one runner or certificate/notarization failure prevents publication. Successful workflow artifacts remain available for diagnosis.
- A partial upload leaves a draft for safe rerun. The rerun verifies that the draft belongs to the same tag before replacing draft assets.
- Existing remote download URLs and SHA-256 filenames remain stable for already shipped app versions.
- No release is triggered by pushing `master` alone or by a pull request.

## Validation

- Parse and lint the workflow YAML; check the event, permissions, job dependencies, matrix entries, expected asset names, and no `release.published` dependency.
- Exercise version and asset-inventory gates with matching and mismatched fixtures without publishing a Release.
- Run the repository's frontend and Rust checks locally where available. Only a tagged GitHub run with configured Apple secrets can prove signing, notarization, upload, and final publication end to end.

Implementation note: the current Rust toolchain flagged three existing test-only
Clippy warnings. The tests were adjusted without changing application behavior so
the planned `-D warnings` gate can pass.

Local checks passed: `actionlint`, the release verifier's three tests and current
version check, `npm test` (1,535 tests), `npm run check`, `npm run build`, Rust
format, strict workspace Clippy, and workspace tests. The full Rust test suite
needed loopback access for its fake Telegram listener. Signing, notarization,
asset upload, and Release publication still require a tagged GitHub run with
configured Apple secrets.

## Open Questions

None. This design chooses Developer ID signing and notarization as a requirement for public macOS Releases.

## Out of Scope

Windows/Linux GUI bundles, automatic app updates, distribution of `kryptonctl`, `krypton-bridge`, or the browser extension, and publishing a new version while implementing this workflow.

## Resources

- [GitHub: Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) — `GITHUB_TOKEN` event behavior and tag filters.
- [GitHub: Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) — passing build files to a later job.
- [GitHub CLI: `gh release create`](https://cli.github.com/manual/gh_release_create) — existing-tag check, draft, and release notes.
- [Tauri: GitHub Actions pipeline](https://v2.tauri.app/distribute/pipelines/github/) — macOS Tauri builds and release conventions.
- [Tauri: macOS code signing](https://v2.tauri.app/distribute/sign/macos/) — CI certificate import, notarization, and ad hoc limitations.
- [Tauri app bundler source](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/app.rs) — notarization is applied to the `.app` bundle during Tauri packaging.
- [GitHub runner images](https://github.com/actions/runner-images) — macOS 15 Apple Silicon and Intel runner labels and four-target matrix availability.
