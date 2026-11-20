---
kind: summary
status: complete
feature: debugger
phase: 06-the-editor
---

# Phase 06 — The editor: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/debugger/06-the-editor`, merged into `feat/debugger` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

The debugger in the editor: F5 on a TypeQLite file, breakpoints in its gutter, and the whole route proven in a real
VS Code against the packaged extension.

## What was built

- **The manifest:** the `typeqlite` debug type for the `typeqlite` language, with its launch attributes, an initial
  configuration, and two snippets (a file; a file with schema and seed data); breakpoints in TypeQLite files; activation
  when a TypeQLite debug session resolves.
- **`src/debug/register.ts`:** a `DebugAdapterInlineImplementation` of `TypeQLiteDebugSession` over the extension's
  own `HostClient` (B3), so the adapter runs in the extension's process and the engine in the host's; launch files read
  through `vscode.workspace.fs`; a configuration provider that debugs the active TypeQLite file when F5 finds no
  `launch.json`, and refuses a configuration with no program.
- **Documentation:** a Debugging section in the extension's README (what a session is, what it shows, the breakpoints,
  what is not there yet), its changelog, the root README's package table, `AGENTS.md`, the project overview.

## Exit evidence

- 🔴 **The e2e** (`e2e/suite.ts`, against the installed `.vsix`, 31 of 31): `vscode.debug.startDebugging` on a fixture
  program with a schema and a seed file; a breakpoint on `select $t;` stops at that stage, whose stack is
  `select · 2 → 2 row(s)` inside its statement, and whose rows read `{ $t: debug-title "Dune" }` and
  `{ $t: debug-title "Emma" }`; over goes to the next statement; with "when a step empties" on, continue stops at
  `$n > 1000 · 2 → 0 row(s)` on its own line; continue ends the session; the program file is unchanged.
- **DAP:** stepping out of a schema function and the step that called it, to the next stage.
- **The manifest spec** pins the debugger's contributions and the activation events.
- `src/debug/register.ts` is excluded from the unit coverage floor by name, with its reason (it calls `vscode.debug`,
  which exists only in the extension host); the e2e runs it.
- The gate, from a clean tree: all 14 steps passed on the second run. The first failed one spec of the sync demo's
  in-browser hub suite (`colors the hub's list the same way…`), which reads a chip's color once without waiting for
  the hub to re-render; rerun alone it passed once and failed once. Nothing this feature changed reaches the sync
  demo's page. Left as found: it is the sync demo's spec, and its neighbors already wait with `until`.

## The feature

Every item of the Definition of Done is ticked, each with where it was proven. What is deferred is in the feature
document: copying a store into memory, evaluating expressions in the Debug Console, streaming a recording, and the
splitter's `with fun` preamble.
