---
kind: checklist
status: complete
feature: editor
phase: 06-code-actions-rename
---

# Phase 06 — Code actions and rename

**Branch:** `phase/editor/06-code-actions-rename`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md) · **Governed by:**
[ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)

**Goal.** Quick fixes where the fix is mechanical and the diagnostic's code identifies it, and a type
or role rename that is safe across the whole workspace.

## Found at the start

- [x] Langium's rename edits cross-references only, starting from a declaration or a reference.
      🔴 Renaming `person` in a schema would leave every `isa person` in every query naming a type
      that no longer exists. A label position is not renameable at all
- [x] No code-action provider is registered for TypeQLite
- [x] `annotation-not-admitted` and `annotation-repeated` range over the annotation node, so
      removing it is mechanical. ⚠️ Corrected during the phase: `annotation-repeated` fires only when
      the two **disagree** (`@card(0..1) @card(1..2)`; identical repeats are accepted). Removing either
      one would choose for the writer, so the fix offers both, and prefers neither. `duplicate-owns` is not: two `owns` that disagree leave the choice to
      the writer. `reserved-keyword` needs a new name, so it is not mechanical either
- [x] A linking error carries `data.code: 'linking-error'` with its container type and property, so
      the scope it failed against can be asked for the names it could have meant

## Build

- [x] `TypeQLiteRenameProvider`: rename from a declaration, a reference, or a label. Edits every
      cross-reference **and** every label use. Refuses a new name that is not a TypeQLite identifier,
      or that is a reserved keyword
- [x] `TypeQLiteCodeActionProvider`:
  - [x] Remove the annotation, for `annotation-not-admitted`. "Keep …" for each of the two, for
        `annotation-repeated`
  - [x] "Change to '…'", for an unknown label and an unresolved reference: the nearest names of the
        right kind, within a small edit distance
- [x] Nothing added to `ValidationRegistry` (ADR-008 D2)

## Proof

- [x] Language specs: rename from each starting point across files, with the renamed workspace
      re-validating clean; refused names; each quick fix's edit applied and the document re-validating
      without that diagnostic (`test/edits.spec.ts`, 17 cases). With Langium's default rename in place
      of ours, 8 fail
- [x] e2e: a cross-file rename through `vscode.executeDocumentRenameProvider`, and a quick fix through
      `vscode.executeCodeActionProvider`. 15 of 15 passed
- [x] Gate green from a clean tree, and the report card unchanged

## Close

- [x] `summary.md`, and the Phase Plan row
