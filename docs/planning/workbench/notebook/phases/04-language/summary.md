---
kind: summary
status: complete
feature: notebook
phase: 04-language
---

# Phase 04 — Language services across cells: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/notebook/04-language` · **Checklist:** [checklist.md](checklist.md)

## Goal

Make the language features work across a notebook's cells, with each notebook's schema its own.

## What was built

- **One rule, `schemaOwnerOf`** (`@typedblite/language`): a notebook cell's owner is its notebook, everything else's is the
  workspace. A definition is visible only inside its owner. Every reader of the index uses it: scoping, re-opens, the labels
  service, the hover. So diagnostics, completion, definition, rename and the quick fix all follow.
- **The server serves notebooks:** a subclass of Langium's server advertises `notebookDocumentSync` for both notebook types, and
  the server listens for notebook documents. The client selects the cell scheme.
- **`createTypeQLiteServices(context, sharedOverrides?)`**: a host can replace shared services, here the language server.

## What was proven

- **The language library (19 specs, 554 in all):** cells resolve each other; notebooks, and files, do not see each other; two
  notebooks may define one label; completion, definition, rename, hover and the quick fix stay inside a schema.
- **The bundled server over stdio (5 specs)** with real `.tql.md` cell URIs and `languageId`.
- **e2e, 27 of 27:** diagnostics, definition and completion across cells in the real VS Code, and notebook B cannot see notebook A.
- Seven mutations each fail a spec.

## Found while building

- **A cell's language comes from its `languageId`, not its URI.** A real cell's path ends `.tql.md`, which no language claims, and
  Langium's registry only falls back to the extension. The library's harness has no synced documents, so its first run failed
  with "no services for the extension ''": its notebooks are named `.tql`, and the bundled-server spec uses the real shape.
- **The changelog had no entry for the engine host or the new `@typedblite/session` package.** An omission of the earlier work,
  caught here when the public API changed again. They are added in this phase's change, with the notebook's.
- **`usesOf`'s document filter is not load-bearing:** removing it changes no answer, because resolution already respects
  ownership. It stays as a guard against scanning every document.
- My first e2e indexed cells as if Markdown sat between every pair; adjacent code cells have none, so the cell I asserted on was
  the deliberately incomplete query. It reported a parse error, which is what made me look.

## What was not done

- **A cell's quick fix to rename across notebooks**, and workspace symbols: a notebook's definitions appear in workspace symbol
  search like any other document's. Not scoped; left as is.
- **Interrupting a statement**, store choice, export: Phases 03 and 05.

## For Phase 05

Choosing a store (in memory by default; a file only as an explicit, shown choice, never saved or remembered, with a mode for
when its writes commit), and export to a `.tql` script and to Markdown. The kernel still says "In-memory store".
