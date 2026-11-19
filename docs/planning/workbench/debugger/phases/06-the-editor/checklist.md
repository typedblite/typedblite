---
kind: checklist
status: complete
feature: debugger
phase: 06-the-editor
---

# Phase 06 — The editor

**Branch:** `phase/debugger/06-the-editor`, from `feat/debugger` · **Opened:** 2026-11-19 ·
**Feature:** [TypeQLite Debugger](../../debugger.feature.md) · **Governed by:**
[ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)

**Goal.** `apps/vscode` contributes the `typeqlite` debug type, its launch snippets, and breakpoints in TypeQLite files.
The adapter is bundled into the `.vsix` and runs inline (B3). The e2e drives a session through
`vscode.debug.startDebugging`.

## Process

- [x] Cut this branch from `feat/debugger` (`f6f890a`)

## The extension

- [x] `contributes.debuggers`: the `typeqlite` type for the `typeqlite` language, its launch attributes (`program`,
      `schema`, `seed`, `cwd`, `stopOnEntry`), an initial configuration and two snippets
- [x] `contributes.breakpoints` for the `typeqlite` language
- [x] Activation on `onDebugResolve:typeqlite` and `onDebugDynamicConfigurations:typeqlite`
- [x] `src/debug/register.ts`: the inline adapter over the extension's `HostClient` (B3), files read through
      `vscode.workspace.fs`, and a configuration provider so F5 on a TypeQLite file with no `launch.json` debugs it
- [x] The adapter bundled into `out/extension.cjs`; the extension still imports nothing of the engine

## Proof

- [x] The manifest spec pins the contributions and the activation events
- [x] Stepping out across a function call over DAP (the last Definition of Done gap)
- [x] 🔴 The e2e, against the installed `.vsix`: a breakpoint on a stage's line, that stage's rows, a step, "when a step
      empties" stopping at the comparison where the rows ran out, the session ending, and the program file unchanged
- [x] The gate, from a clean tree

## Outputs

- [x] The extension's README (a Debugging section) and changelog; the root README; `AGENTS.md`; the project overview
- [x] The feature document: status, Definition of Done, Phase Plan; the initiative's status table
- [x] `summary.md`
- [x] Merged into `feat/debugger`
