---
kind: checklist
status: complete
feature: editor
phase: 03-navigation
---

# Phase 03 — Navigation

**Branch:** `phase/editor/03-navigation`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md) · **Governed by:**
[ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)

**Goal.** Go to definition, find references, an outline, workspace symbols, folding, and hover,
over schema references across the workspace.

## Found at the start

- [x] The server already advertises definition, references, document and workspace symbols,
      folding, hover and rename: they are Langium's defaults. Since Phase 02, definition and
      references work across files from the cross-references, and workspace symbols list every
      exported definition
- [x] What the defaults get wrong for TypeQLite: every symbol is a `Field`; a re-open
      (`employment relates manager;`) is missing from the outline, because it has no `name`; and hover
      reads `/** */` comments, which TypeQLite does not have
- [x] 🔴 TypeDB's doc comment (`#!` on the lines above a definition) is read by a private helper in
      the runtime's SQL generator. Hover needs the same rule, and a second copy would define TypeQLite
      twice (ADR-008, invariant 2)

## Build

- [x] Move `docCommentOf` into the language library, and have the runtime import it, unchanged
- [x] `TypeQLiteNodeKindProvider`: symbol and completion kinds per definition kind
- [x] `TypeQLiteDocumentSymbolProvider`: a re-open appears in the outline under the label it re-opens
- [x] `TypeQLiteHoverProvider`: the definition's source, its `#!` doc comment and `@doc` text, and
      where else it is re-opened
- [x] Nothing added to `ValidationRegistry` (ADR-008 D2)

## Proof

- [x] Language specs over a multi-document workspace (`test/navigation.spec.ts`, 12 cases): definition
      and references across files, the outline with kinds and re-opens, workspace symbols, hover content,
      and folding
- [x] e2e: definition, references, symbols, hover and folding through the `vscode.execute*` commands.
      10 of 10 passed
- [x] Gate green from a clean tree, and the report card unchanged

## Close

- [x] `summary.md`, and the Phase Plan row
