---
kind: summary
status: complete
feature: engine-host
phase: 04-mcp
---

# Phase 04 — MCP: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/engine-host/04-mcp` · **Checklist:** [checklist.md](checklist.md)

## Goal

MCP as the fifth transport: tools only, read-only by default (invariant 8), the write tier opt-in, HTTP MCP on
loopback only.

## What was built

- **`--mcp` (stdio) and `--mcp-http` (Streamable HTTP at `/mcp`)**, written in the host, as decided. They serve the
  **read tier**; `--mcp-write` adds the rest. `--mcp-write` alone is refused, because it is a tier and not a mode.
- **Each operation with an input schema is a tool**, with the descriptor's own JSON Schema sent as it is. The server
  uses the SDK's low-level `Server`, so the host needs no zod. A call goes through the one runtime, so it does what
  the same operation does everywhere else; the server adds only the tier.
- **The read tier:** `session.list`, `session.get`, `schema.get`, `statement.classify`, `statement.split`, and
  `session.run` restricted to reads. `session.open`, the transaction operations and `session.close` are not offered.
- **HTTP MCP on loopback:** `--host` is refused unless it is loopback (exit 2, naming it, before anything listens);
  a request is refused unless its peer, `Host` and `Origin` are loopback; stateless, with the sessions shared.

## How the read tier is held

`session.run` in the read tier runs a statement only if the host's **own classifier** says it is a read. That is
the classifier that routes execution (invariant 3): a read goes to the interpreter's `query`, which cannot write.
So what is allowed and what runs are one decision. It errs towards refusing: a comment that mentions `insert`
classifies as a write. Even `undefine`, which the classifier mis-sends down the read path (Phase 01's finding), is
only refused by `query`, and a spec shows the schema survives it.

## Found while building

- **Opening a path that does not exist creates a 69 KB file.** Measured. So a read-tier `session.run` with a
  `location` refuses one that is not there. Opening and reading an existing store leaves it **byte for byte**
  unchanged (measured, and a spec).
- **An `Origin` hole in the HTTP fence from Phase 03.** A page that posts to `http://127.0.0.1:3470` carries
  `Host: 127.0.0.1:3470` and its own `Origin`, so the peer and `Host` checks pass it. Browsers do not let it read
  the answer, but a request that runs a statement is the problem. Building the MCP endpoint, where this matters
  most, showed it; the check is now shared by both and tested on both. A later explorer webview, whose origin is not
  loopback, will need an allowlist.
- **The coverage floor failed at first** (67%): the mode wiring and the servers were only run as processes. They are
  testable in this process, so I moved the modes to `mcp-modes.ts` with an injectable environment (streams, a stop
  signal, stderr, the exit code) instead of excluding files. The host is at 93%, with nothing excluded.
- The SDK's stdio transport does not notice its input ending, so `--mcp` would wait for ever; it closes on `end`.

## Decisions made while building

- **A refusal is not an MCP error.** A statement the engine refuses is data (`kind: "refused"`, `isError: false`),
  as on every transport. A fault (an unknown session, bad input) and a tier refusal are `isError: true`.
  The exit-code question from Phase 02 is still open.
- **Stateless HTTP.** Each request builds a server and a transport; the runtime, and so the sessions, is shared.

## What was not done

- The WASM, browser, e2e and clean-room steps.
- A write-tier safeguard beyond opt-in (a confirmation, an allowlist of locations). Opt-in is what invariant 8
  asks for, and it should be revisited before an agent is given `--mcp-write` on a real store.
- Authentication, and a non-loopback listener.
- The lockfile's devx-micro entries (Phase 02's note).

## For Phase 05

The client in `apps/vscode`: start the host over the sidecar with `SidecarClient`, and expose its operations. It
needs a `node` the extension can launch (ADR-011 D1), and `node:sqlite` in the desktop Electron's Node is still
unverified. Packaging, the e2e smoke test against the `.vsix`, and the docs (README, `AGENTS.md`, the project
overview memory).
