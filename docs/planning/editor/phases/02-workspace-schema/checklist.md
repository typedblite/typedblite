---
kind: checklist
status: complete
feature: editor
phase: 02-workspace-schema
---

# Phase 02 — Workspace schema

**Branch:** `phase/editor/02-workspace-schema`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md) · **Governed by:**
[ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
D2, D3

**Goal.** A schema reference resolves anywhere in the workspace: `sub`, `owns`, `plays` and roles
added by re-opens. This builds the index that Phases 03–06 read.

## Found at the start

- [x] 🔴 **A second `define` clause cannot see the first, even in one file.** Langium makes a
      definition local to its container (the clause) and exports nothing, so
      `define attribute name …; define entity person, owns name;` reports *"Could not resolve
      reference to AttributeDef named 'name'"* today. That is a false error in every multi-clause
      file. Exporting the definitions fixes it as a side effect, and a spec pins it
- [x] Langium registers a `**/*` file watcher dynamically when the client supports it, so a file
      created or deleted on disk reaches the server with no client change

## Build

- [x] `TypeQLiteScopeComputation`: export every named definition inside a `define` clause (entity,
      relation, attribute, struct, function), and each re-open (`TypeExtensionDef`) under the label it
      re-opens
- [x] `TypeQLiteScopeProvider.getGlobalScope`: the current document's exports before the rest of the
      workspace, so a same-file definition wins a name collision (ADR-008 D3)
- [x] The role scope gathers re-opens from the whole workspace, not only the relation's own document
- [x] Nothing added to `ValidationRegistry` (ADR-008 D2)
- [x] **Not planned:** `validateSync` now returns `SyncDiagnostic` (`message: string`). Phase 01's
      `vscode-languageserver` 10 bump widened `Diagnostic.message` to `string | MarkupContent`, and the
      runtime stopped compiling against it. An incremental `tsc -b` hid that until this phase changed
      the language library's sources

## Proof

- [x] Language specs over a multi-document workspace (`test/workspace-scope.spec.ts`, 10 cases, on a
      new `test/workspace.ts` helper with an in-memory file system): `sub`, `owns`, `plays` and a re-open's role,
      each across files; the two-clause case; same-file precedence; and removing the defining
      document turns a resolved reference into an unresolved one. Adding the defining document resolves
      it again. With the scope computation unregistered, 8 of the 10 fail (the other two are the
      still-refused cases)
- [x] Stdio server test: two documents, where one resolves into the other
- [x] e2e: a schema split across two files resolves, and deleting the defining file on disk produces
      the unresolved-reference diagnostic. 5 of 5 passed
- [x] Report card before and after: 1742 of 1756. Gate green, run again from a clean tree (no `out/`, no
      `*.tsbuildinfo`)

## Close

- [x] `summary.md`, and the Phase Plan row
