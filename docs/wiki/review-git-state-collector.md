---
type: entity
title: "Shared git-state collector"
tags: [entity]
---

# Shared git-state collector

A Rust function (`collect_git_state` in `src-tauri/src/hook_server.rs`, exposed
to the frontend via the `acp_collect_review_git_state` Tauri command) that
assembles a JSON snapshot of a lane's working tree. It is the one piece of the
old Review Lane Mode that **survived** the [[simplify-review-to-peer-send]]
deletion sweep.

## Shape

`{ hasGitRepo, isUnbornHead, diffstat, diff, untracked }`

Simplified from the old `ReviewPacket` (dropped: worktree fingerprint,
partial-staging detection, churn-sorted per-file hunk caps).

## Why it is shared

Two consumers need git context, so the collector is deliberately **not**
review-specific:

- [[review-command]] forwards the `diff` / `untracked` subject to reviewers.
- [[attention-triage]] uses `diffstat` to compute a flagged decision's
  blast-radius.

This shared consumer is the reason the collector was kept rather than deleted
with the rest of the review machinery.

## Key correctness decisions

- **Diff against a single tree-ish, not `--cached`.** The collector runs
  `git diff <base>` where `<base>` is `HEAD` (normal repo) or the
  empty-tree object (unborn HEAD). Diffing the working tree against one
  tree-ish captures **both staged and unstaged** edits — a `git add`-then-edit
  file (porcelain `AM`) keeps its unstaged changes, which the old `--cached`
  diff silently dropped.
- **Unborn HEAD** (fresh repo, no commits): the empty-tree base is *derived*
  via `git hash-object -t tree /dev/null` so it is correct for both SHA-1 and
  SHA-256 repos; the SHA-1 empty-tree constant is only a fallback.
- **Genuine failure ≠ no changes.** A non-zero `git diff` emits a sentinel
  (`<git diff failed>`) rather than coercing failure into an empty diff, which
  a populated diffstat would otherwise contradict.
- Payload is byte-capped (UTF-8-safe) with untracked files contributing only
  head excerpts — this bounds the *payload*, not process memory.

## Open questions (raised in peer review, not yet resolved)

- The `--numstat` call (which feeds `diffstat`) uses `unwrap_or_default()` on
  failure while the unified `diff` emits the sentinel, so a populated diffstat
  can appear alongside a failed-diff sentinel.
- `--numstat` omits `--no-textconv` while the unified diff passes it, so repos
  with textconv filters can disagree on whether a path changed.
- On a SHA-256 repo without `/dev/null`, the SHA-1 empty-tree fallback object
  may not exist, yielding the sentinel instead of a real diff.
