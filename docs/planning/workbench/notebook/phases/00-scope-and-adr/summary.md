---
kind: summary
status: complete
feature: notebook
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the file format, and the ADR: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/notebook/00-scope-and-adr`, merged into `feat/notebook` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Answer the six open questions, record them in an ADR, and leave Phase 02 nothing to decide.

## What was built

No code, as planned.

- [ADR-012](../../../../../architecture/adr-012-the-notebook-is-a-markdown-file-run-on-the-engine-host.md), accepted.
- The [feature document](../../notebook.feature.md) and the initiative's status table, updated to match.

## What was measured

- **The document's "what exists" table was stale.** It was written before the engine host. The host, `statement.split`,
  `session.restart`, the extension's `HostClient` and the shared classifier all exist now.
- **A spike against the real language server.** Advertising `notebookDocumentSync` and calling
  `NotebookDocuments.listen(connection)` is enough for cells to be built as documents: a label defined in cell 1
  resolves in cell 2, exactly one diagnostic is reported for the truly unresolved one, and go-to-definition crosses
  cells. (A first run found no diagnostics: the spike sent `notebook` where the protocol says `notebookDocument`.)
- **The schema scope is the whole workspace**, so a second notebook resolved the first notebook's `name`. That is
  why N4 restricts scope per notebook, which is a change to `libs/language`.

## What was not measured

- **A very large answer through the sidecar.** The host returns every row as one JSON line. Whether it needs a
  `limit` input is decided in Phase 03 once measured.

## For Phase 02

The format: a parser and a serializer over Markdown, byte-exact for an unedited notebook, with no outputs stored,
and the `typeqlite-notebook` type registered for `*.tql.md` and, as an option, `*.md`. Pure functions with specs over
fixture notebooks, including the five-minute tour.
