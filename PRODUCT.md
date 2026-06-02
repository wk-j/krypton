# Product

## Register

product

## Users

Developers and power users who live inside the terminal and rarely touch the mouse. They run many shells at once, switch between virtual desktops constantly, and increasingly drive AI coding agents alongside their own work. Their context is a focused, full-screen session where speed of navigation and zero hand-travel matter more than discoverability.

## Product Purpose

Krypton is a keyboard-driven terminal emulator that behaves like a single invisible cockpit. One transparent, borderless fullscreen window hosts a DOM compositor of terminal "windows" arranged across workspaces (virtual desktops), with tabs and panes, plus an ACP harness for running multiple AI agent lanes side by side. It exists so a power user can manage a dense, multi-session, multi-agent workspace entirely from the keyboard, without the visual noise or mouse-dependence of conventional terminal apps and IDEs. Success looks like never reaching for the mouse, never waiting on the UI, and the chrome staying out of the way of the terminal content.

## Brand Personality

Cyberpunk, precise, fast. Neon-on-blue-black with hard geometry and monospace typography. Futurist but restrained: the aesthetic sharpens focus rather than performing spectacle. Three words: precise, fast, neon.

## Anti-references

What Krypton must never look like:

- **Side-stripe / left-bar accent borders** on panels, list items, callouts, or tabs. Use background tint, a full border, or typographic weight instead.
- **Nested containers** — cards inside cards, panels inside panels. Chrome stays flat; one surface, not a stack of boxes.
- **Stacked decorative effect layers** — multiple pseudo-element glow/blur layers piled on for richness. Effects stay flat and singular.
- **`backdrop-filter: blur()`** — banned outright; it freezes transparent WKWebView on macOS.
- **Generic GUI / IDE chrome** — heavy toolbars, big click targets, drag handles, CSS-framework (Bootstrap/Material) surfaces. Mouse-first affordances are not the primary path.

## Design Principles

- **Keyboard is the only first-class input.** Every feature has a keyboard path; the mouse is a fallback, never a requirement.
- **One window, one cockpit.** The whole app is a single transparent native window; never spawn extra OS windows or break the invisible-shell illusion.
- **Latency is a feature.** Keypress-to-render under 16ms, 60 FPS animation, sub-1% idle CPU. Perceived instantness wins over visual richness.
- **Chrome recedes, content leads.** The terminal/agent content is the hero; window chrome is flat, quiet, and legible, never decorative depth for its own sake.
- **Cohesive identity over novelty.** The cyberpunk system (and its NASA / amber alternates) is applied consistently; new surfaces extend the language rather than inventing their own.

## Accessibility & Inclusion

Legibility-first rather than a formal WCAG target (single-user power tool). Every animation must have a `prefers-reduced-motion: reduce` alternative (already a system constraint). Theme tokens carry the contrast contract; gauges, timers, and counters use `tabular-nums`. Color is never the sole signal for status — pair it with shape, icon, or text.
