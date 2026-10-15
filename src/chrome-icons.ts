// Krypton — icon geometry shared by chrome surfaces that each wrap it their own
// way: the workspace footer clones `<svg>` templates (`workspace-footer.ts`),
// the harness injects `<symbol>` defs (`acp/harness-icons.ts`). Paths live in a
// `0 0 16 16` box and carry no colour or stroke of their own, so one mark reads
// identically wherever it is mounted — the footer and the composer meta row
// drew two different branch icons until this body was the single source.

/** git branch: three nodes, the right one merging into the trunk. */
export const BRANCH_ICON_BODY =
  '<circle cx="4.5" cy="3.6" r="1.5"/><circle cx="4.5" cy="12.4" r="1.5"/><circle cx="11.5" cy="3.6" r="1.5"/>' +
  '<path d="M4.5 5.1 V12.4"/><path d="M11.5 5.1 V6.6 c0 2.2 -1.8 4 -4 4 H4.5"/>';
