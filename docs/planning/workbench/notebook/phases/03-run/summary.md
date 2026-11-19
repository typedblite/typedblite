---
kind: summary
status: complete
feature: notebook
phase: 03-run
---

# Phase 03 — Run: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/notebook/03-run` · **Checklist:** [checklist.md](checklist.md)

## Goal

Run a notebook's cells on the engine host, show their answers, and bound what is rendered.

## What was built

- **A controller for each notebook type**, whose cells are run by the host: `statement.split`, then each statement
  through the notebook's one in-memory session, in order, **stopping at the first refusal** with earlier statements still
  committed (ADR-012 N6). Run All, Run Above and Run Below are VS Code's own and call the same handler.
- **Outputs from built-in MIME types**, so no renderer of our own: a table (Markdown, with a plain fallback), JSON for a
  `fetch`, the engine's execution facts, and a refusal as an error output with its line and column in the cell.
- **The output bound:** a page of rows (`typedblite.notebook.maxRows`, default 1,000), and "N more rows are not shown".
- **Restart**, on the notebook toolbar and in the palette, over `session.restart`.
- **Recovery:** if the host process was restarted, the next cell says its store is new and empty, rather than every cell failing.

## What was proven

- **Real cells through the real host bundle with no VS Code (11 cases):** a later cell sees an earlier cell's schema and data,
  a refusal stops a cell with earlier statements kept, restart empties the store and the next query is refused with the engine's
  own message, two notebooks do not share a store.
- **e2e, 25 of 25:** Run All, a refusal on its cell, the cell after it not started, the notebook not marked changed, restart.
- 58 unit specs on the runner, the sessions and the outputs. Four mutations (no stop at a refusal, no reopen, no escaping, no
  count of cut rows) and one in the e2e (outputs not transient) each fail a spec.

## Found while building

- **The host answers every statement with execution facts, and an `insert` answers a table of what it made** (`b → entity:book:#1`).
  My first integration expectations assumed neither. Both are useful in a notebook, so they are shown.
- **The sidecar needs no `limit`:** measured, 50,000 rows in 0.7 s as one 2.3 MiB line, so 200,000 is about 3 s. The notebook
  bounds what it renders. (A first guess in the ADR's Phase 00 said this might need a host change; it does not.)
- **A value in a table is data.** A `$` reads as math in a notebook's Markdown renderer, a `|` ends a cell, and `<script>` is HTML,
  so every value is made literal and a spec per case checks it.
- **A refusal's location is the host's range for the statement, added to where the statement starts in the cell.** The host splits
  a copy with comment lines removed, so a statement with a comment inside it cannot be found as written, and its location is left
  out rather than guessed.

## What was not done

- **Interrupting a statement mid-run.** The host's engine is synchronous, so a stop takes effect between statements only.
- **Choosing a store** and **export**: Phase 05. The kernel says "In-memory store" until then.
- **Language services across cells:** Phase 04.

## For Phase 04

The language server serves cells: advertise `notebookDocumentSync`, call `NotebookDocuments.listen`, widen the client's document
selector to the cell scheme, and make the **schema scope per notebook** (ADR-012 N4) in `libs/language`, including the places that
read the whole index (role re-opens, the nearest-label quick fix). Conformance stays at 1742 of 1756.
