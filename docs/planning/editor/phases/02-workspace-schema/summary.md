---
kind: summary
status: complete
feature: editor
phase: 02-workspace-schema
---

# Phase 02 — Workspace schema: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/02-workspace-schema`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

A schema reference resolves anywhere in the workspace (ADR-008 D3). This phase builds the index that
Phases 03–06 read.

## What was built

- [`TypeQLiteScopeComputation`](../../../../../libs/language/src/typeqlite-scope-computation.ts) exports
  every named definition in a `define` clause, and each re-open under the label it re-opens.
- [`TypeQLiteScopeProvider`](../../../../../libs/language/src/typeqlite-scope.ts) searches the current
  document's exports before the workspace's, so a same-file definition wins a collision. It now
  gathers a relation's re-opens from the whole workspace, through the index.
- [`test/workspace.ts`](../../../../../libs/language/test/workspace.ts) builds several documents
  together, each workspace with its own services, on an in-memory file system. Phases 03–06 will build
  on it.

The language server needed no change, and neither did the client. Langium already registers a `**/*`
file watcher dynamically, which is what made the e2e delete case pass.

## Exit evidence

- `workspace-scope.spec.ts`: 10 cases (`sub`, `owns`, `plays`, a re-open's role in a third file, two
  still-refused cases, two `define` clauses in one file, same-file precedence, removing and adding
  the defining file). With the scope computation unregistered, 8 of them fail.
- Stdio server test: a reference resolves into another open document.
- e2e, VS Code 1.146.0: **5 passed, 0 failed**. The new case opens a file whose attribute is defined
  in a file that is never opened, so the server found it by indexing the workspace. It then deletes
  that file on disk and sees the reference become unresolved.
- Gate green from a clean tree (1191 tests). Report card **1742 pass · 1 fail · 12 deviation · 1 n/a ·
  1756**, unchanged.

## What did not go as planned

- 🔴 **Two `define` clauses in one file could not see each other.** Langium made a definition local
  to its clause, and nothing was exported. So every multi-clause file showed a false *"Could not
  resolve"* in an editor. The runtime never links, so it never saw this. The fix is the same export,
  and a spec pins it.
- 🔴 **Phase 01's gate was green without having checked the runtime.** Its `vscode-languageserver` 10
  bump widened `Diagnostic.message` to `string | MarkupContent` (LSP 3.18). The runtime stopped
  compiling against `validateSync`, but `build` is `tsc -b`, which is incremental. The language
  library's sources had not changed, so its declarations were not re-emitted, and the runtime was
  judged up to date, even with `--skip-nx-cache`. The error surfaced only when this phase changed
  the library. `validateSync` now returns `SyncDiagnostic` (`message: string`), which is what every
  check produces and what ADR-004's reports carry. The runtime is unchanged. The trap is recorded in
  AGENTS.md, and the lifecycle standard's exit gate now requires a clean tree after a dependency or
  public-type change.
- The test helper needed a real file system. `DocumentBuilder.update` asks the file system whether a
  changed URI is a file before it reads it, so `EmptyFileSystem` cannot model a file being added.

## Handoff to Phase 03

- Navigation over schema references is mostly free now: Langium's default definition, references and
  rename work from cross-references, and those resolve across files. Phase 03 needs to prove that, and
  build hover, the outline and folding.
- `workspace()` from `test/workspace.ts` is the harness for multi-document cases.
- Pipeline labels are still plain `ID`s, so navigation from a query is Phase 04's job (ADR-008 D5).
