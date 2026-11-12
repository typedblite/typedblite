---
kind: summary
status: complete
feature: editor
phase: 03-navigation
---

# Phase 03 — Navigation: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/03-navigation`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Go to definition, find references, an outline, workspace symbols, folding, and hover, over schema
references across the workspace.

## What was built

- [`typeqlite-navigation.ts`](../../../../../libs/language/src/typeqlite-navigation.ts):
  - `TypeQLiteNodeKindProvider`: entity → class, relation → interface, attribute → property,
    struct → struct, function → function, role → enum member. These are the symbol kinds, and the
    completion kinds Phase 05 will use.
  - `TypeQLiteDocumentSymbolProvider`: a re-open appears in the outline under the label it re-opens,
    with the roles it adds as children. Every symbol carries its kind word as `detail`.
  - `TypeQLiteHoverProvider`: shows the definition's source, its `#!` doc comment and `@doc` text, a
    role named with its relation (`employment:employee`), and the files that re-open a type.
- [`typeqlite-doc-comments.ts`](../../../../../libs/language/src/typeqlite-doc-comments.ts):
  `docCommentOf`, moved from the runtime's SQL generator unchanged. The runtime imports it now, so the
  runtime and the editor read the same rule from one place.

Definition, references, workspace symbols and folding are Langium's defaults. Phase 02 is what made
them correct across files, so no code was needed for them here.

## Exit evidence

- `navigation.spec.ts`: 12 cases over a three-file workspace.
- e2e, VS Code 1.146.0: **10 passed, 0 failed**, with five new cases: definition and references
  across files, the outline with roles and a re-open, hover with both kinds of documentation, and
  folding.
- Gate green from a clean tree (1204 tests). Report card **1742 · 1 · 12 · 1 · 1756**, unchanged,
  which is the proof that moving `docCommentOf` did not change what the runtime stores.

## Notes

- Hover on a *re-open's* label (`employment` in `employment relates manager;`) shows nothing yet,
  because the label is a plain `ID`. It is a pipeline-style label, so it is Phase 04's work.
- The e2e gained `diagnosticsSettled`. An empty diagnostic set cannot be told apart from none having
  been published, so it waits for the server to go quiet instead.

## Handoff to Phase 04

- Pipeline labels are plain `ID`s (ADR-008 D5). Phase 04 needs one service that resolves a label
  position to its definitions through the index, and the definition, references, hover and semantic
  token providers must consult it alongside the cross-references.
- The re-open label (`TypeExtensionDef.type`) and `TypePattern.subject` are the same kind of label,
  and belong in the same service.
