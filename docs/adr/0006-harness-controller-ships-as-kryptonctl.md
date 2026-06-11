# Harness Controller ships as `kryptonctl`

> Status: accepted
> Date: 2026-06-11

## Context

Scripts need an unambiguous command for controlling a running Krypton instance
without confusing that operation with launching the GUI.

## Decision

The Harness Controller ships as a separate Rust binary named `kryptonctl`. Its
command surface begins under `kryptonctl acp`, and it shares versioned protocol
types with the Rust control server.

## Considered Options

- Add controller flags to the Krypton GUI binary. Rejected because launch and
  control commands become ambiguous.
- Use a Node.js CLI. Rejected to avoid an additional runtime dependency.

## Consequences

`make install` installs the app bundle to `/Applications` and places
`kryptonctl` in `~/.local/bin` by default. Users may override the CLI location
with `CLI_INSTALL_DIR=/desired/path`; that directory must be on `PATH`.
