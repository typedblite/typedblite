---
kind: feature
status: proposed
decided-by: []
title: TypeQLite Notebook
feature: notebook
branch: feat/notebook
initiative: workbench
depends-on: [editor, engine-host]
---

# TypeQLite Notebook — Feature Doc

> **Status:** 📋 Proposed, not started · **Written:** 2026-11-17 · **Branch:** `feat/notebook`, from
> `main`, not yet cut · **Depends on:** [TypeQLite Editor](../../editor/editor.feature.md) (complete)
> · **Shares work with:** [Graph Explorer](../graph-explorer/graph-explorer.feature.md) and
> [Debugger](../debugger/debugger.feature.md) · **Governed by:** an ADR that Phase 00 writes
>
> Request, 2026-11-17: *a notebook, as a future feature.*
>
> 🔴 **The request was one line. This document reads it as a VS Code notebook for TypeQLite**:
> a file of cells, some prose and some TypeQLite, where running a cell shows its answers beneath
> it, against one store that persists from cell to cell. That reading is the first thing Phase 00
> confirms with the founder (see [Open questions](#open-questions-for-phase-00)).
>
> **A feature in the [Workbench initiative](../workbench.initiative.md).** Its own deliverable is
> a notebook serializer, a controller that runs cells, and an output renderer. It runs on the
> [engine host](../engine-host/engine-host.feature.md) and its session, which the initiative builds
> first and shares with the [graph explorer](../graph-explorer/graph-explorer.feature.md) and the
> [debugger](../debugger/debugger.feature.md).

## Process

Per the [Multi-Phase Lifecycle Standard](../../../standards/governance/multi-phase-lifecycle-standard.md).
`feat/notebook` is cut from `main` when Phase 00 starts. Each phase branch,
`phase/notebook/<NN>-<slug>`, is cut from it and merges back into it. Each phase's checklist is
written when that phase starts. Questions for the founder are asked in Phase 00.

## Motivation

A TypeQLite schema and the queries that go with it are usually explained in prose: *this defines a
person, this inserts two of them, this asks who is older than 30.* Today that lives in two places.
The prose is a Markdown guide, and the statements are in a `.tql` file or typed into the CLI's
REPL. The reader cannot change a query and see what happens without leaving the page.

A notebook puts them in one file. It is the natural way to:

- **Teach TypeQLite.** The guides ([the TypeQLite language](../../../guides/typeqlite-language.md),
  [the five-minute tour](../../../guides/five-minute-tour.md)) could be run, not only read.
- **Explore a store step by step**, keeping each query and its answers next to the reasoning.
- **Share a reproducible example**, such as a bug report: a schema, some data, the query that goes
  wrong, and what it printed.

## What already exists — verify before relying on it

This is load-bearing. Check it again when Phase 00 starts. It has **not** been verified on disk for
this document, which was written from the other feature documents.

| Thing | State |
| ----- | ----- |
| The `.tql` language and editor | Complete ([editor feature](../../editor/editor.feature.md), ADR-008): a Langium language server in [`apps/vscode`](../../../../apps/vscode) with diagnostics, navigation, completion, rename and quick fixes |
| Running statements | `define`, `execute` and `query` on the interpreter and on `SqliteEngine`, with `beginTransaction`, `commitTransaction` and `rollbackTransaction` |
| Answers | `query()` returns `rows` of `TypeDBLiteValue` cells; a `fetch` returns `documents` as JSON |
| Execution facts and refusals | Returned as a report ([ADR-004](../../../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md)) |
| Statement classification | In [`apps/cli/src/session.ts`](../../../../apps/cli/src/session.ts), chooses define, read or write. Needs to move somewhere shared |
| Extension side | The extension has no notebook API use, no webview, and never loads the runtime |
| Embedded Markdown | The Markdown preview already highlights TypeQLite fences in the editor's colours ([ADR-010](../../../architecture/adr-010-the-markdown-preview-highlights-typeqlite-in-the-editor-s-colours.md)). A notebook's Markdown cells can reuse that |

## What the engine host gives it, and what it adds

The notebook runs on the [engine host](../engine-host/engine-host.feature.md): open a database, run
a statement in a transaction, return rows, facts and refusals, in a **session** that keeps one store
open across statements. The host's session is the notebook's kernel. Where the engine runs is the
host's decision, not this feature's.

The notebook adds, on top of the host:

- **Cells map to a session.** Each notebook gets one session. Restart drops it and re-creates an
  in-memory store, or reopens the file.
- **One statement or many per cell**, and what a cell prints when a later statement fails after an
  earlier one committed (open question 6).

## 🔴 The invariants every phase is bound by

**1. A cell runs through TypeQLite, and only through it.** Each code cell is run by the same
engine entry points the CLI uses. There is no SQL against the store and no execution path private
to the notebook. A cell's output could be reproduced by pasting the cell into the REPL.

**2. The notebook changes nothing about the engine's answers.** It adds no runtime behaviour. Any
runtime change it does need goes through the usual path, and the conformance run stays at **1742
of 1756** ([ADR-005](../../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).

**3. Nothing is written to a real store by surprise.** A notebook runs against an in-memory store
by default. Opening a file store is an explicit choice, shown in the notebook's status, and a write
to it commits only in the mode the user picked. Saving a notebook never writes to a store.

**4. A notebook file is plain text a person can diff.** Cells are stored in a format that reads
sensibly in a pull request, and that records **no outputs by default**, so that running a notebook
does not dirty the file. Storing outputs is a choice the user makes.

**5. The extension still never defines TypeQLite** (the editor's invariant 2). Cell highlighting,
diagnostics and completion come from the language server. Statement classification and value
rendering come from the runtime and the language library.

**6. Output is bounded.** A cell that returns 200,000 rows renders a page of them and says how many
it did not show, so the editor does not freeze.

## Goals

1. **A notebook file type** with Markdown cells and TypeQLite cells, opened in VS Code's notebook
   editor.
2. **The `.tql` editing experience inside a cell**: diagnostics, completion, hover, go to
   definition and rename, **across cells**. A schema defined in cell 1 resolves in cell 3.
3. **Run a cell, run all, run above and below, restart.** One store, kept between cells.
4. **Outputs**: a table of rows, JSON for a `fetch`, execution facts, and a refusal shown as an
   error on the cell with its location.
5. **Open a store**: in-memory by default, or a file the user picks.
6. **Export** to a `.tql` script (code cells only) and to Markdown (cells with fenced `typeql`
   blocks).

## Definition of done

Each item names where it is to be proven. "e2e" means `nx run typeqlite-vscode:e2e` against the
packaged `.vsix`.

- [ ] The serializer round-trips: parse then serialize gives the same bytes for a fixture notebook,
      and records no outputs by default. *Spec, without VS Code.*
- [ ] A cell runs through the engine host, and a later cell sees what an earlier cell defined and
      inserted. *Host spec, without VS Code.*
- [ ] A schema defined in one cell resolves in another, in diagnostics and in completion. *Language
      server spec, and e2e.*
- [ ] Restart gives an empty store, and a cell that needs the schema fails with the engine's own
      refusal. *Host spec.*
- [ ] A refusal shows on the cell with its message and location; execution facts show in the
      output. *e2e.*
- [ ] Output past the row limit reports how many rows it did not show.
- [ ] The notebook's guides can be run: the five-minute tour converted to a notebook runs to
      completion and its answers match the tour's. *Spec.*
- [ ] 🔴 The conformance run is unchanged at **1742 of 1756**.
- [ ] `AGENTS.md`, the README and the project overview memory name the notebook.
- [ ] Build, typecheck and test are green for everything touched, from a clean tree.

## Out of scope

- **Other languages in a notebook.** Cells are Markdown or TypeQLite. No Python, no TypeScript.
  (A "TypeScript cell using the runtime" is attractive, and is deferred, not refused.)
- **Jupyter compatibility as a goal.** Reading or writing `.ipynb` is an open question, not a
  commitment. A Jupyter kernel is a different product.
- **A graph view.** Cell output is a table or JSON. The graph view belongs to the
  [Graph Explorer](../graph-explorer/graph-explorer.feature.md); if both ship, the notebook can
  embed it as an output renderer.
- **Debugging a cell.** That is the [Debugger](../debugger/debugger.feature.md)'s work.
- **Hosting notebooks on the website or in the playground.** VS Code first. The renderer and host
  protocol should not forbid it later.
- **Connecting to a TypeDB server.** This runs TypeDBLite stores.

## Open questions for Phase 00

These are for the founder.

1. **Is this the intended meaning?** A VS Code notebook for TypeQLite, as described here, or
   something else (a notebook in the playground, a Jupyter kernel, a Markdown-based runnable
   guide)?
2. **File format.** A new extension (such as `.tqlnb`) in a plain-text format of our own, a
   Markdown file whose `typeql` fences are cells, or `.ipynb`. The recommendation is Markdown-like
   text, for invariant 4. Decide with the guides in mind.
3. ~~**Where the engine runs.**~~ Decided by the [engine host](../engine-host/engine-host.feature.md).
4. **Cross-cell language services.** Does the language server see the notebook as one document
   (concatenated cells) or as many? This decides how rename and go-to-definition cross cells.
5. **Default store.** In memory only, or remember the last file per notebook? And one store per
   notebook, or a picker per cell?
6. **Should a cell be one statement or many?** A cell with several statements and a `match` after
   an `insert` needs a rule for what it prints, and for what happens when the second statement
   fails after the first committed.

## How this gets proven

**The format is proven without a screen**: serialize and parse are pure functions with specs over
fixture notebooks.

**The session is proven without VS Code**, as a protocol driven from plain Node, the way
`server.test.ts` drives the language server.

**The editor integration is proven in the e2e**, which installs the packaged `.vsix`, opens a
fixture notebook, runs its cells and asserts the outputs. Pixel tests are not used.

## Phase Plan

| # | Phase | Status | Summary |
| - | ----- | ------ | ------- |
| 00 | Scope, the file format, the shared engine host, and the ADR | Not started | |
| 01 | ~~Engine host with a session~~ — now the [engine-host feature](../engine-host/engine-host.feature.md), built first | Moved | |
| 02 | Format: the serializer and the notebook type | Not started | |
| 03 | Run: the controller, run all, restart, outputs for rows, JSON, facts and refusals | Not started | |
| 04 | Language services across cells | Not started | |
| 05 | Store choice, output bounds, export | Not started | |
| 06 | Packaging, e2e, a guide as a notebook, docs | Not started | |

## Phase Intent

This is a forward plan. Each phase's checklist is written when that phase starts.

**00 — Scope and the ADR.** Answer the open questions. Check whether `node:sqlite` is in VS Code's
Electron Node. Settle the file format and the engine host with the explorer's and the debugger's
documents.

**01 — Moved.** The engine host is its own feature, built first. This phase is kept so the
numbers below stay stable.

**02 — Format.** A notebook serializer and parser, with no outputs stored by default, and the
notebook type registered in the extension.

**03 — Run.** A controller that runs a cell, run all, run above and below, and restart. Outputs:
a table, JSON, execution facts, and refusals as cell errors.

**04 — Language services across cells.** Diagnostics, completion, hover, definition and rename see
the whole notebook's schema, in the way phase 00 chose.

**05 — Store, bounds and export.** Open a file store, with the mode shown. The row limit with the
count of rows not shown. Export to `.tql` and to Markdown.

**06 — Packaging.** The e2e cases. The five-minute tour as a runnable notebook. The README and
`AGENTS.md`.

## Deferred

Anything a phase defers is recorded here, not only in a commit message.

- *(none yet)*

## Key Documents

- [TypeQLite Editor](../../editor/editor.feature.md) and
  [ADR-008](../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md):
  the extension this builds on
- [TypeQLite Graph Explorer](../graph-explorer/graph-explorer.feature.md) and
  [TypeQLite Debugger](../debugger/debugger.feature.md): the other proposed features that need an
  engine host
- [ADR-004](../../../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md):
  execution facts, which become cell output
- [ADR-010](../../../architecture/adr-010-the-markdown-preview-highlights-typeqlite-in-the-editor-s-colours.md):
  TypeQLite highlighting in Markdown
- [The TypeQLite language](../../../guides/typeqlite-language.md) and
  [the five-minute tour](../../../guides/five-minute-tour.md): the guides a notebook could make
  runnable
- [VS Code Notebook API](https://code.visualstudio.com/api/extension-guides/notebook): the
  serializer, controller and renderer this would use
