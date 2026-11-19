---
kind: checklist
status: in-progress
feature: debugger
phase: 02-adapter-shell
---

# Phase 02 — The adapter shell

**Branch:** `phase/debugger/02-adapter-shell`, from `feat/debugger` · **Opened:** 2026-11-19 ·
**Feature:** [TypeQLite Debugger](../../debugger.feature.md) · **Governed by:**
[ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)

**Goal.** A DAP session that launches a TypeQLite file in a fresh `:memory:` session on the engine host, runs the
launch's `schema` and `seed` files, records the program one statement at a time, and steps over statements. Facts and
answers go to the debug console. Run Without Debugging runs the file through `session.run`.

## Process

- [x] Cut this branch from `feat/debugger` (`999ec52`)

## `@typedblite/session`

- [ ] `locateStatements(source)`: each statement's original text (comments inside it kept) and where it starts. The
      splitting loop is shared with `splitStatements`, whose output does not change (invariant 6)

## The engine host

- [ ] `statement.locate`: a query over `locateStatements`
- [ ] `session.debug`: one statement through `Session.debug`, answering `{ result, recording }`. 🔴 Refused with
      `NOT_IN_MEMORY` on any session not at `:memory:` (B2)
- [ ] `session.debug` is not an MCP tool, in either tier (ADR-011 D8, B2)

## `libs/debugger` (`@typedblite/debugger`, private, B4)

- [ ] The project: package, Nx targets, tsconfig, vitest; `@vscode/debugadapter` and `@vscode/debugprotocol` 1.68.0,
      checked in the lockfile against registry.npmjs.org
- [ ] The host's wire shapes declared here, with a type-level spec that they match the runtime's and the session's
      own (no runtime dependency, B4)
- [ ] The launch: `program`, `schema[]`, `seed[]`, `cwd`, `stopOnEntry`, `noDebug`. A schema or seed refusal ends the
      launch and says which file and statement
- [ ] A timeline of stops (statement stops in this phase), pure and specified on its own
- [ ] The DAP session: initialize, launch, configurationDone, threads, stackTrace, scopes, variables, next, stepIn,
      stepOut, continue, disconnect; output of facts and answers; exited and terminated events
- [ ] Run Without Debugging through `session.run`
- [ ] The host session is closed on disconnect

## Proof

- [ ] Timeline specs, launch specs with a fake host
- [ ] DAP specs over a real engine host (the bundle the `.vsix` ships), driven by `@vscode/debugadapter-testsupport`:
      launch, stop on entry, step over statements, output, a refusal, Run Without Debugging, disconnect
- [ ] A session whose program writes and commits leaves every file in its folder byte for byte as it was
- [ ] `AGENTS.md`'s layout and dependency graph name `libs/debugger`
- [ ] The gate, from a clean tree

## Outputs

- [ ] `summary.md`
- [ ] The feature document's Phase Plan row
- [ ] Merged into `feat/debugger`
