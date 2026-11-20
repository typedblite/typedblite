---
kind: checklist
status: complete
feature: editor
phase: 04-query-labels
---

# Phase 04 — Query-side labels

**Branch:** `phase/editor/04-query-labels`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md) · **Governed by:**
[ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
D2, D5, D6

**Goal.** A type label that is a plain `ID` (`$p isa person`, `has name`, `links (employee: $x)`, a
re-open's label, an `undefine`'s target) resolves against the workspace schema, with no grammar
change (D5). It then gets definition, references, hover, resolved highlighting, and an unknown-label
warning that the runtime never sees (D2, D6).

## Found at the start

- [x] Query labels are colored by position today, whether or not they name anything. The provider
      says so in a 🔴 comment, because until now nothing could resolve them
- [x] A query document has no cross-references into the schema, so Langium would never rebuild it when
      a schema file changed, and an unknown-label warning would go stale. The document builder has to
      count label sites as dependencies

## Build

- [x] `TypeQLiteLabels`: one table of every label position, by AST type and property, with the kind of
      definition each expects (any type, entity, relation, attribute, or role, where the role's
      relation is known from context) and resolution through the index
- [x] Definition, references and hover consult it when Langium's cross-references give nothing
- [x] Semantic tokens: in a workspace with a schema, a label is colored only when it resolves; without
      one, by position, as today (D6)
- [x] `TypeQLiteDocumentValidator`: an unknown label is a warning, `typedblite.unknown-label`, only in a
      workspace that defines at least one type. It is never a `ValidationRegistry` check (D2)
- [x] `TypeQLiteDocumentBuilder`: a document with label sites is relinked when any document changes

## Proof

- [x] Language specs: each label position resolves, definition, references (cross-reference and label
      uses together), hover, tokens with and without a schema, the warning with and without a schema,
      the warning clearing when the defining file appears, and `validateSync` not reporting it
      (`test/labels.spec.ts`, 17 cases). With the document builder unregistered, the clearing case fails
- [x] e2e: definition and hover from a query into another file's schema, and the warning. 12 of 12
      passed. Phase 03's references case now also finds `labels.tql`, which is correct, and its
      expectation says why
- [x] Gate green from a clean tree, and the report card unchanged

## Close

- [x] `summary.md`, and the Phase Plan row
