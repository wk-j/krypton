# Artifact Default Styling — Implementation Spec

> Status: Implemented
> Date: 2026-05-31
> Milestone: M8 — Polish

## Problem

Spec 133 HTML artifacts open verbatim in the OS browser with **zero baseline styling** — `artifact_new` issues a path but writes no file, so the lane authors the entire document. Output quality is therefore uncontrolled: one lane ships a polished page, another an unstyled white table, a third broken markup. There is no consistent look and no light/dark affordance. This is a quality/consistency gap (not a security one — spec 133's threat model already covers safety).

## Solution

Make `artifact_new` write a **self-contained styled scaffold** to the issued path instead of leaving it empty. The scaffold is a complete `<!doctype html>` document carrying a `<style id="krypton-artifact-base">` block whose **default look is the Krypton cyberpunk theme** (dark, monospace, dense — chosen by the user for being minimal and space-efficient, mirroring `docs/prototypes/*.html`), a header with an in-page **cyberpunk → light → auto** toggle persisted to `localStorage`, and a placeholder `<main>` the lane fills in. A clean light variant and an OS-following `auto` mode remain available through the toggle, but **cyberpunk is the default** — not `prefers-color-scheme`. The lane then **edits** the file (replacing the placeholder, keeping the scaffold) rather than creating it from scratch. Styling is inline — no external CSS file to resolve over `file://`, no harness mutation of HTML at register time, and the file stays self-contained, portable, and sweepable. The scaffold is a strong default, not enforced confinement: a lane *can* overwrite the whole file, consistent with spec 133's trust envelope.

## Research

- **Current code (`hook_server.rs`):** `artifact_new` (line 522) creates the lane dir + `.gitignore`, records a `pending` entry, and returns `{ id, path, tail, state, title }` — **but never touches the file**. `artifact_register` (line 608) calls `validate_artifact_file` requiring a regular file within `ARTIFACT_FILE_BYTES_MAX` (4 MiB). `artifact_cancel` best-effort deletes the issued file. Caps: `ARTIFACT_TITLE_MAX=200`, `ARTIFACT_PER_SESSION_MAX=64`, `ARTIFACT_PENDING_PER_LANE_MAX=4`.
- **Path-handoff constraint (spec 133):** HTML bytes never travel through MCP; the harness must not transport or mutate HTML. A scaffold *written at `new`* is consistent with this — the harness authors the **starter** file (it owns the path/dir already) *before the lane begins editing*, then hands it off; it never mutates the lane's later content. The invariant needs tightening, though: spec 133's "the lane writes the file / the harness never transports HTML bytes" becomes **"the harness never transports lane-authored HTML bytes and never mutates the artifact after handoff or at register."** Register-time injection would violate the new wording (and fight size/hash integrity + live-edit), so it is rejected.
- **`artifact_register` no longer proves the lane wrote anything** (Codex-1 review). With a seeded file, `new → register` with no edit produces a valid, polished *placeholder* artifact. Not a security break, but a lifecycle change from spec 133's "lane writes then registers" — called out explicitly and decided below (placeholder registration is **allowed**, not validated).
- **`file://` + project-dir constraint:** artifacts live under the *target project's* `.krypton/artifacts/...` and open as `file://`. A `<link rel=stylesheet>` to a bundled Krypton CSS would need a fragile relative depth or an absolute install-path URL that breaks across machines and when the file is moved/shared. **Inlining** the CSS sidesteps all of this and keeps the single-file portability the blog workflow relies on.
- **Krypton theme does not reach the browser:** artifacts open in the OS browser, not the in-app webview — there is no `--krypton-*` context. The scaffold must be self-sufficient and follow OS `prefers-color-scheme`, not Krypton's active theme.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code Markdown preview | Ships a built-in stylesheet themed to the editor's light/dark; users override/extend via the `markdown.styles` setting (workspace-relative or https). Restricts resource loading to the workspace for security. | Default-but-overridable themed baseline — the closest analog to what we want. |
| Claude.ai Artifacts | Self-contained single-file page in a sandboxed iframe; defaults to an internal CSS-token system (`--color-background-primary`…) that **silently has no fallback** outside Claude's shell, so unguided artifacts can render with no background/borders. Theme set via `theme="dark"`/`"light"`. | Cautionary: a token system with no fallback degrades badly out of context. Our scaffold must define its own variables with concrete fallbacks. |
| Jupyter / nbconvert | Output cells rendered with a bundled default CSS; HTML export uses templates with embedded styles. | Embedded-styles-in-output template pattern. |
| GitHub rendered HTML | Sanitized + GitHub's own CSS applied by the host. | Host-applied, not self-contained — not viable for `file://`. |

**Krypton delta.** We match VS Code's "themed default you can override" model but **inline** the baseline (VS Code can rely on its renderer host; a `file://` page cannot). We deliberately avoid Claude's no-fallback token trap by shipping concrete values. Where VS Code/GitHub default to a neutral light theme, Krypton's default is the **cyberpunk dark aesthetic** (user decision — minimal, dense, space-efficient, matching the app's identity), with light/auto as opt-outs. Unlike all of the above, opening is a user-triggered OS-browser handoff, so the styling has to be 100% self-contained in the file with no host cooperation. No market tool ships a *headless agent* a pre-styled HTML scaffold to fill in — that part is novel.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/resources/artifact-scaffold.html` | **New.** The scaffold template: doctype, head, `<style id="krypton-artifact-base">`, header with theme toggle, `<main data-artifact-content>` placeholder, toggle `<script>`. Carries a `{{title}}` token. |
| `src-tauri/src/hook_server.rs` | `artifact_new`: after creating dirs, `include_str!` the scaffold, substitute `{{title}}` (HTML-escaped), write it to the issued path before returning. Update `artifact_new` tool description (scaffold + edit-don't-recreate guidance). Add `ARTIFACT_SCAFFOLD` const + escape helper. |
| `docs/133-harness-html-artifacts.md` | Cross-ref: `artifact_new` now seeds a styled scaffold; the issued path is pre-populated, not empty. Note the edit-not-create flow. |
| Lane-context stub (`buildPromptBlocks()` in `acp-harness-view.ts`) | One-word touch-up: artifacts come "pre-styled (light/dark)"; lane fills content. Discoverability only. |
| `src/acp/acp-harness-view.test.ts` / `hook_server.rs` tests | Update existing artifact tests for the now-pre-existing scaffold file (any test that expected *register-before-write* to fail now **succeeds** — the seed makes the file exist); add tests asserting `artifact_new` writes a non-empty file containing the `krypton-artifact-base` marker + escaped title, and that an **untouched-scaffold register succeeds** (placeholder allowed). |

## Design

### Scaffold template (`artifact-scaffold.html`)

A single self-contained document. Skeleton (CSS abbreviated):

```html
<!doctype html>
<html lang="en">           <!-- no data-theme attr ⇒ :root cyberpunk default applies -->
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<style id="krypton-artifact-base">
  /* DEFAULT = Krypton cyberpunk (dark, mono, dense). Palette mirrors
     src/styles/acp-harness.css / docs/prototypes/*.html. */
  :root {
    --bg:#050810; --fg:#d7e7f0; --muted:#6a7d8a; --border:#14222e;
    --accent:#5fd9d9; --card:#08121e; --code-bg:#0a141c;
    --add:#7fd9c0; --del:#e8737b; color-scheme: dark;
    --mono:'JetBrains Mono','SF Mono',Menlo,ui-monospace,monospace;
  }
  /* opt-out variants via the toggle */
  html[data-theme="light"] {
    color-scheme: light;
    --bg:#ffffff; --fg:#1a1f24; --muted:#5a6671; --border:#d7dde2;
    --accent:#0a7ea4; --card:#f6f8fa; --code-bg:#f0f3f5; --add:#1a7f37; --del:#cf222e;
  }
  @media (prefers-color-scheme: light) {            /* auto only follows OS */
    html[data-theme="auto"] { color-scheme: light;
      --bg:#ffffff; --fg:#1a1f24; --muted:#5a6671; --border:#d7dde2;
      --accent:#0a7ea4; --card:#f6f8fa; --code-bg:#f0f3f5; --add:#1a7f37; --del:#cf222e; }
  }
  body { margin:0; font-family:var(--mono); font-size:13px; line-height:1.45;
         background:var(--bg); color:var(--fg); -webkit-font-smoothing:antialiased; }
  .ka-main { max-width: 880px; margin: 0 auto; padding: 16px 20px 48px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border:1px solid var(--border); padding:4px 8px; text-align:left; }
  pre, code { font-family: var(--mono); background: var(--code-bg); }
  pre { padding:10px; overflow:auto; border-radius:4px; }
  .ka-card { background:var(--card); border:1px solid var(--border);
             border-radius:4px; padding:12px; }
  .ka-header { display:flex; justify-content:space-between; align-items:center;
               padding:8px 20px; border-bottom:1px solid var(--border); }
  .ka-toggle { font:inherit; cursor:pointer; background:transparent;
               border:1px solid var(--border); color:var(--accent);
               border-radius:4px; padding:3px 9px; }
</style>
</head>
<body>
<header class="ka-header">
  <strong>{{title}}</strong>
  <button class="ka-toggle" id="ka-theme">◐ theme</button>
</header>
<main class="ka-main" data-artifact-content>
  <!-- Replace this block with your content. Keep <style id="krypton-artifact-base">
       and the theme toggle. Use plain semantic HTML — it is styled automatically.
       To OVERRIDE defaults, add your own <style> AFTER krypton-artifact-base. -->
  <p>Artifact scaffold ready. Edit this file to add your content.</p>
</main>
<script>
  // cyberpunk/light/auto toggle, best-effort persisted (file:// origin varies by browser)
  (function () {
    var order = ["cyberpunk", "light", "auto"], html = document.documentElement;
    var k = "krypton-artifact-theme", btn = document.getElementById("ka-theme");
    try { var s = localStorage.getItem(k); if (s) html.dataset.theme = s; } catch (e) {}
    if (!html.dataset.theme) html.dataset.theme = "cyberpunk";  // default
    function label() { if (btn) btn.textContent = "◐ " + html.dataset.theme; }
    label();
    if (btn) btn.addEventListener("click", function () {   // guard: lane may drop the header
      var next = order[(order.indexOf(html.dataset.theme) + 1) % order.length];
      html.dataset.theme = next; label();
      try { localStorage.setItem(k, next); } catch (e) {}
    });
  })();
</script>
</body>
</html>
```

- **Default = cyberpunk** (no `data-theme` attr ⇒ `:root` applies; the script stamps `data-theme="cyberpunk"` on load). User decision: cyberpunk is minimal and space-efficient (mono, dense padding, tight `max-width`). The toggle cycles **cyberpunk → light → auto**, persisted to `localStorage` (best-effort, try/catch — some browsers block it on `file://`). Only `auto` follows `prefers-color-scheme`; the default deliberately does **not**, so artifacts look like Krypton out of the box regardless of OS setting.
- **Baseline reset, not purely non-conflicting** (Codex-1). The base styles `table`/`th`/`td`/`pre`/`code` globally on purpose — that is invasive by design so unstyled markup looks right. Lane content with its own classes/inline styles overrides cleanly, but to override the *element* defaults the lane must add its `<style>` **after** `krypton-artifact-base` (CSS source order at equal specificity) — stated in the scaffold comment and tool guidance.
- The scaffold is ~2–3 KiB, far under `ARTIFACT_FILE_BYTES_MAX`.

### `artifact_new` change (Rust)

```
1. (unchanged) validate title, allocate id, check caps, create lane dir + .gitignore
2. NEW: let html = ARTIFACT_SCAFFOLD.replace("{{title}}", &html_escape(title));
3. NEW: write atomically — write to <path>.tmp then rename onto <path>. On any error,
        best-effort remove the tmp file and FAIL CLOSED (return Err, do NOT insert the
        pending entry or return a path). temp+rename avoids leaving a truncated scaffold
        if the write is interrupted (Codex-1).
4. NEW: write the file BEFORE inserting the pending entry (current code inserts with
        size 0 / empty hash and never touches disk — order matters now).
5. (unchanged) insert pending ArtifactEntry, return { id, path, tail, state, title,
        content_marker: "main[data-artifact-content]" }
```

`ARTIFACT_SCAFFOLD: &str = include_str!("../resources/artifact-scaffold.html");` plus a small `html_escape()` for the title. Escape `& < > " '` (full text+attribute escape) so the helper is safe even though the token currently sits only in text positions (`<title>`, header) — guards against the token ever moving into an attribute (Codex-1).

The response gains **`content_marker`** so the lane can orient its first edit on a stable anchor rather than guessing.

### Tool description change (`artifact_new`)

Append after "Returns `{ id, path }`":

> The path points to a file that **already exists** — a ready-made HTML scaffold with Krypton's default styling and a light/dark toggle. Use your **Edit/patch** tool (NOT Write — the file is not empty) to replace the placeholder inside `<main data-artifact-content>` with your content; keep the `<style id="krypton-artifact-base">` block and the toggle. Write plain semantic HTML (headings, tables, `<pre><code>`, `<section class="ka-card">`); it is styled automatically. To override a default, add your own `<style>` *after* the base block. Then call `artifact_register { id }`.

The "the file already exists — Edit, don't Write" framing is the key nudge (Codex-1): agents otherwise treat a returned path as "write here." The **same wording is mirrored into the lane-context stub**, which is often more salient than the full tool description.

### Data Flow

```
1. Lane calls artifact_new { title }
2. hook_server seeds the styled scaffold at .krypton/artifacts/<h>/<l>/<id>.html
3. Returns { id, path } — path already holds a complete styled page
4. Lane EDITS the file (replaces <main> placeholder), keeping the scaffold styles
5. Lane calls artifact_register { id } → validate (regular file ≤ cap), record size/hash, raise card
6. User opens via hint → open_url(file://…) → OS browser renders the page in the
   cyberpunk default; user can flip cyberpunk → light → auto with the in-page toggle
```

### Configuration

None in v1. The cyberpunk default + in-page toggle (cyberpunk → light → auto) deliver the theming the user asked for without a config key. (A `krypton.toml` default-theme key is Out of Scope — see below.)

## Edge Cases

- **Lane overwrites the whole file** (full `Write` instead of editing) → scaffold styling lost. Mitigated by the tool/stub wording ("file exists — Edit, don't Write") and by the file already existing so editing is the natural path; **not enforced**, consistent with spec 133 trust envelope. Documented, not blocked.
- **Untouched scaffold registered** (`new → register`, no edit) → produces a valid placeholder artifact. **Decision: allowed.** `artifact_register` does *not* validate that the placeholder was replaced — that would be enforcement/content inspection we explicitly reject. The placeholder card is acceptable (it is an early-mistake artifact, harmless, user-opened). A test asserts this path succeeds.
- **Lane wants to override element defaults** → must add its `<style>` *after* `krypton-artifact-base` (equal-specificity source order). Lane styles placed *before* the base block lose. Stated in scaffold comment + tool guidance.
- **`localStorage` on `file://`** → try/catch; toggle still works for the session if blocked. Persistence is **best-effort and browser-dependent** — `file://` origin semantics vary (some persist, some block, some scope oddly); not promised as "per-origin." Default auto/`prefers-color-scheme` always applies.
- **Lane keeps the toggle script but drops the header/button** → script guards `getElementById` (null check) so it never throws.
- **Seed write fails / interrupted** → temp+rename + best-effort tmp cleanup; `artifact_new` fails closed (no pending entry, no path), so no partial scaffold is ever handed out.
- **`artifact_cancel` on a seeded-but-unedited pending** → existing best-effort delete already removes the file (now it always exists). No change needed.
- **Old browser without `prefers-color-scheme`** → `auto` mode never matches the light media query, so it shows the `:root` cyberpunk default; explicit `light` via toggle still works.
- **Title with HTML metacharacters** → full text+attribute escape (`& < > " '`) before substitution.

## Security delta (vs spec 133)

Spec 133 already accepts full HTML+JS opening verbatim. This change adds one thing worth stating honestly: **every artifact now ships a tiny harness-authored, local-only JS toggle by default** (reads/writes one `localStorage` key, mutates `data-theme`; no network, no DOM injection beyond the button label). It is in-page, user-opened, and within the existing trust envelope, but it is no longer true that artifact JS is exclusively lane-authored — the security section of spec 133 should note the default toggle script so "no bundled JS beyond the theme toggle" (below) is not carrying that fact implicitly.

## Out of Scope

- A `krypton.toml` key to pick the default artifact theme (cyberpunk/light/auto) — v1 ships one scaffold (cyberpunk default + light/auto via the in-page toggle). Revisit if requested.
- **Marker-absence signalling.** Detecting at register that the scaffold marker is gone (lane overwrote it) and labelling the card "custom HTML" or emitting debug telemetry — a non-blocking way to *measure* default adherence without enforcing it (Codex-1). Deferred; no card/telemetry change in v1. Listed so it is a known future option, not an oversight.
- Multiple scaffold templates / per-directive scaffolds.
- Enforcing the scaffold (sandboxing, register-time re-injection, content validation) — explicitly rejected; trust envelope unchanged from spec 133.
- Syntax highlighting, charting libs, or any bundled JS beyond the theme toggle.
- Matching Krypton's live `--krypton-*` theme (artifacts open in the OS browser, no Krypton context).

## Resources

- [Markdown and Visual Studio Code](https://code.visualstudio.com/docs/languages/markdown) — `markdown.styles` override model + workspace resource restriction; the "themed default you can override" prior art.
- [Reverse engineering Claude Artifacts](https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts) / [Ultimate Claude Artifacts guide](https://dev.to/hira_jabeen_ccaa191c13070/ultimate-claude-artifacts-guide-45k3) — sandboxed single-file model and the no-fallback CSS-token failure mode we avoid by shipping concrete values.
- [MDN: `prefers-color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme) — OS light/dark detection used for the default theme.
- Internal: `docs/133-harness-html-artifacts.md` (path-handoff, lifecycle, security), `src-tauri/src/hook_server.rs:518-650` (current `artifact_new`/`artifact_register`).
