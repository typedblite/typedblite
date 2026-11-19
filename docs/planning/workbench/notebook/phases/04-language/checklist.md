---
kind: checklist
status: complete
feature: notebook
phase: 04-language
---

# Phase 04 — Language services across cells

**Branch:** `phase/notebook/04-language`, from `feat/notebook` · **Opened:** 2026-11-19 · **Feature:** [Notebook](../../notebook.feature.md)

**Goal.** The language features work across the cells of a notebook, with each notebook's schema its own (ADR-012 N4).

## Build

- [x] `libs/language`: `schemaOwnerOf`, one rule for whose schema a document is part of
- [x] Every reader of the index filters by it: the global scope, a relation's re-opens, the labels service (resolve, candidates,
      has-a-schema, uses), the hover's re-opens. Optional `context` parameters keep the API compatible
- [x] `createTypeQLiteServices` takes shared services to replace; the server's `NotebookAwareLanguageServer` advertises
      `notebookDocumentSync` for both notebook types and the TypeQLite cells; the server listens for notebook documents
- [x] The client's document selector gains the cell scheme

## Specs

- [x] **Language library (19):** the owner rule; cells of one notebook resolve `owns`, `sub`, `plays` and re-opens across each other;
      an unknown label is still refused; query labels and the unknown-label warning; another notebook, and a file, do not see a
      notebook's schema; two notebooks may define one label; a schema-less notebook and a schema-less workspace flag nothing;
      completion, go to definition, rename, hover and the quick fix stay inside the schema. The whole library suite: 554 of 554
- [x] **The bundled server over stdio (5)**, with real `.tql.md` cell URIs and `languageId`: it advertises both types; cells are built
      and resolve each other; notebooks are kept apart; definition crosses cells; completion offers a notebook its own definitions
- [x] **e2e (27 of 27):** diagnostics, go to definition and completion across cells in the real VS Code; another notebook does not
      see the first one's schema
- [x] Mutations: every document in one schema (12 specs fail); the labels service on the whole index; the scope provider on the whole
      index; the hover's re-opens on the whole index; no notebook capability; the server not listening; the cell scheme missing from the
      client's selector: each fails a spec. (`usesOf`'s document filter is only a scan-saving guard: resolution already respects ownership)

## Checks

- [x] `npm run gate -- --quick`; conformance untouched (the runtime and the conformance suite have no diff)

## Outputs

- [x] `summary.md`; ADR-012 (Phase 04); the changelog; the feature, the initiative, the extension README
- [ ] Merged into `feat/notebook`
