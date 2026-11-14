# Krypton Bug Trail — `trail.toml` v1

Krypton writes this file on every Analyze. It describes `trail.toml`, the
technical diagnosis a lane writes **before any code is edited**. Spec: Krypton
`docs/0400-bug-trail.md`.

## Rules

- Analysis is read-only on the code. Do not edit, create or delete any file
  outside the issue's bundle folder `.krypton/analyses/<owner>/<repo>/<n>/`.
  Krypton records HEAD and the changed files when Analyze starts and on every
  `trail_check`, and the page shows any change.
- You make claims; Krypton checks them. There is no field for "verified".
  A `cite` counts only when its `quote` is really in those lines at `commit`.
  A `repro` counts only when Krypton ran it (after the user's `#trail trust`
  and `#trail run`) on `commit` with a clean tree and it ended as `expect` says.
- Pin every step to a node `id` of `map`. A step whose `at` is not a node is
  still shown, under "not on the map".
- Write `note`, `question`, `options` and `what` in the analysis language
  (Thai, unless told otherwise). Ids, kinds, paths and quotes stay as written.
- Call the `trail_check` tool with `issue = "<owner>/<repo>#<n>"` and fix every
  error and every `mismatch` / `missing` / `unknown` status until `ok` is true.

## File

```toml
version = 1
issue  = "owner/repo#123"          # must match the bundle folder
title  = "short bug title"          # optional, ≤ 200 chars
map    = "e2e/maps/system.toml"     # repo-relative 0355 map; if none covers the
                                    # area, write map.toml in the bundle and point here
commit = "b420e805"                 # the commit you analysed (git rev-parse --short HEAD)

[[repro]]                           # optional, ≤ 10; never run by you
id        = "done-path"             # ^[a-z0-9][a-z0-9-]{0,39}$
argv      = ["hurl", "--test", ".krypton/analyses/owner/repo/123/repro/done.hurl"]
expect    = "fail"                  # fail (default) | pass — on the analysed commit
timeout_s = 300                     # 5..1800
what      = "what the command shows"

[[step]]                            # ≤ 60, in the order you found them
at   = "api003"                     # a map node id
kind = "root-cause"                 # symptom | ruled-out | suspect | root-cause | decision | plan
note = "what this step says"        # ≤ 600 chars; optional only for decision
  [[step.evidence]]                 # ≤ 8 per step
  type  = "cite"
  file  = "src/service/Foo.java"    # repo-relative
  lines = "1688-1689"               # "a" or "a-b", span ≤ 200
  quote = 'policyInfo.get("al_policy_no")'   # exact text inside those lines, ≤ 200 chars
```

### Step kinds

| kind | use |
|---|---|
| `symptom` | where the wrong behaviour shows |
| `ruled-out` | a part you checked that is not the cause |
| `suspect` | a likely cause not yet pinned to code |
| `root-cause` | the cause, with `cite` evidence at least |
| `decision` | something a person must decide before the fix: `question` (required), `options` (≤ 6 strings), `answer` (leave empty; write it only after the user answers in chat) |
| `plan` | where and how the fix will go — nothing applied; cite the lines to change |

### Evidence types

| type | fields | Krypton checks |
|---|---|---|
| `cite` | `file`, `lines`, `quote` | `quote` is inside `lines` of `file` at `commit` |
| `commit` | `sha` | the commit exists |
| `observed` | `file` (bundle-relative), `what` | the file exists in the bundle (save query output, API responses, screenshots there first) |
| `repro` | `id` | Krypton's own run of that `[[repro]]` |
| `inferred` | `what`, optional `source` | nothing — your reasoning, shown as inferred |
| `ref` | `what`, optional `url` | nothing — something outside the repo |

Prefer `observed` and `cite` over `inferred`. When the symptom is only
inferred, say so; when nothing reproduces the bug yet, add a `[[repro]]` the
user can trust and run before the fix.
