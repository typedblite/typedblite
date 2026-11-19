---
kind: summary
status: complete
feature: debugger
phase: 02-adapter-shell
---

# Phase 02 — The adapter shell: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/debugger/02-adapter-shell`, merged into `feat/debugger` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

A DAP session that launches a TypeQLite file in a fresh `:memory:` session on the engine host, runs the launch's
`schema` and `seed` files, records the program one statement at a time, and steps over statements, with answers and
facts in the debug console and Run Without Debugging through `session.run`.

## What was built

- **`@typedblite/session`:** `locateStatements(source)`, each statement as written (comments inside it kept) and where
  it starts. `splitStatements` and it share one loop, `statementBounds`, run over the source with comment lines removed
  (`splitStatements`, unchanged output) or blanked to spaces (`locateStatements`, every offset the source's own).
- **The engine host:** `session.debug` (`{ session, statement, limits? }` → `{ result, recording }`), refused with
  the new host error `NOT_IN_MEMORY` on any session not at `:memory:`, and `statement.locate`. `session.debug` is in
  `NOT_TOOLS`, so MCP never offers it, in either tier. The host's pinned operation counts moved from 12 to 14 (13 MCP
  tools in the write tier), each on purpose.
- **`libs/debugger` (`@typedblite/debugger`, private):**
  - `wire.ts`: the host's shapes as the debugger reads them. No dependency on the runtime or the session package.
  - `timeline.ts`: the stops, in order, with depths; `over`, `in`, `out` and `continue` as rules over them. Out of a
    statement goes to the next one.
  - `program.ts`: `DebugProgram`. The launch (`program`, `schema[]`, `seed[]`, `cwd`, `stopOnEntry`, `noDebug`): a
    schema or seed refusal closes the session and fails the launch naming the file and line. A forward move runs each
    statement it passes through `session.debug`, once. A refusal stops the move there with reason `exception`, and
    the next move ends the program with exit code 1, running nothing more, as `typedblite --file` does. Run Without
    Debugging goes through `session.run`.
  - `adapter.ts`: `TypeQLiteDebugSession`, DAP over `DebugProgram`: initialize, launch, configurationDone, threads,
    stackTrace, scopes and variables (a statement's status and text), next, stepIn, stepOut, continue, disconnect and
    terminate, with output, stopped, exited and terminated events. A host fault ends the session with a message.
- **`@typedblite/notebook`** exports `outputsOf(result, maxRows)`, so the debugger's console prints an answer exactly as
  the notebook does.
- `AGENTS.md`'s layout, dependency graph and project list name `libs/debugger`. ADR-014 records what this phase made
  exact (B2's input, answer and error, `statement.locate`; B4's proof and the notebook dependency).

## Exit evidence

- **`libs/debugger`:** 25 specs. Timeline rules; the launch (schema then seed, a refused seed naming its file and
  line, an unreadable file before anything opens); moves (a recording per statement passed, a read that sees every
  write before it, a refusal and exit 1, nothing run after it); Run Without Debugging; DAP over a socket with
  `@vscode/debugadapter-testsupport` against an in-process stand-in built on the real `Session`.
- **The wire shapes:** `test/wire.test.ts`, typechecked. **Mutation-checked:** a retyped field, a renamed field, a
  retyped boolean and an added field each fail the typecheck. The first version of the check, a deep "same type"
  comparison, passed with a field retyped, and so did an assignment of `Recording` alone: the compiler stops comparing
  recursive types at a depth limit. Each record is now assigned on its own.
- **DAP against the real host bundle** (`apps/vscode/test/debug-adapter.test.ts`, the `.vsix`'s `out/host/sidecar.cjs`):
  stop on entry, step over, a read printing what the insert before it wrote, exit 0; a refusal with the engine's own
  message, exit 1; a refused schema failing the launch; and 🔴 **a program that inserts and deletes, in a folder holding
  a schema, a seed and a `store.db`, leaves every file byte for byte as it was** (SHA-256 of each, before and after).
- **The host:** `session.debug` answers what `session.run` would plus a recording, passes its caps, records a refusal;
  🔴 refused on a file session with nothing run; `statement.locate`; input validation and the schema/validate agreement
  for both operations; 109 host specs in all.
- **`@typedblite/session`:** `locateStatements` finds what `splitStatements` finds, keeps the comments inside a
  statement, and places each at its own text.
- **The gate**, from a clean tree: all 14 steps passed, on the third run. The first stopped at the API check
  (`LocatedStatement.character` had no doc comment). The second, under the coverage run, found three faults in this
  phase's specs: the wire proof assigned declared constants at module load, which do not exist at run time (it is now
  a function, typechecked and never called, and was mutation-checked again); two DAP specs waited for a stop only after
  the launch answered, which a slower run lost; and the MCP process spec still pinned 12 tools.

## Found

- The notebook places a refusal by `indexOf` of the split statement in the cell, so a statement with a comment inside
  it is not found and its location is left out (its own code says so). `statement.locate` would fix that. Not done
  here: it is the notebook's, and nothing in this feature depends on it.

## For Phase 03

Stops at stage boundaries: a statement's recording becomes stage stops in the timeline, the Rows variables (paged,
each thing from `Recording.things`), the Scope variables, and line breakpoints on statements and stages, placed with
`statement.locate`'s positions.
