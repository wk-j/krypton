# 9. Open Questions

| # | Question | Context | Status |
|---|----------|---------|--------|
| 1 | **xterm.js renderer fallback** | Use `@xterm/addon-webgl` by default with automatic fallback to canvas renderer if WebGL is unavailable in the webview. Validate during M1. | To validate |
| 2 | **Session persistence** | Should Krypton support saving/restoring sessions across application restarts? This would require serializing scrollback buffer and shell state. | Open |
| 3 | **Plugin system** | Is a plugin/extension API in scope for v1, or deferred to a later release? If included, what should the API surface look like? | Open |

## How to Add New Questions

Append to the table above with the next sequential number. Update the status as decisions are made:

- **Open** — Not yet discussed
- **To validate** — Needs prototyping/testing
- **Decided** — Decision made (add a note)
- **Deferred** — Pushed to a future version
