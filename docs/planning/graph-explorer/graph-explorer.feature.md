---
kind: feature
status: proposed
decided-by: []
title: TypeQLite Graph Explorer
feature: graph-explorer
branch: feat/graph-explorer
depends-on: [editor]
---

# TypeQLite Graph Explorer — Feature Doc

> **Status:** 📋 Proposed, not started · **Written:** 2026-11-12 · **Branch:** `feat/graph-explorer`,
> from `main`, not yet cut · **Depends on:** [TypeQLite Editor](../editor/editor.feature.md)
> (complete) · **Governed by:** an ADR that Phase 00 writes
>
> Request, 2026-11-12: *a graph explorer, modelled after TypeDB Studio.*
>
> 🔴 **This is the feature that the two earlier documents said would justify an initiative.** The
> editor's feature document placed "result tables, browsing a live store's schema, transactions and
> a graph view" out of scope, describing them as a database IDE, and said an initiative earns its
> place once that is taken on ([Out of scope](../editor/editor.feature.md#out-of-scope)). The
> [debugger](../debugger/debugger.feature.md) said the same about building alongside it. This
> document and the debugger now share a piece of work that neither owns: **a host that runs the
> engine for the editor** (see [Shared with the debugger](#shared-with-the-debugger)). It is written
> as a feature, as requested. **Once either feature is scheduled, write an initiative over both,**
> and make that host its first feature.

## Process

Per the [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md).
`feat/graph-explorer` is cut from `main` when Phase 00 starts. Each phase branch,
`phase/graph-explorer/<NN>-<slug>`, is cut from it and merges back into it. Each phase's checklist
is written when that phase starts. Questions for the founder are asked in Phase 00.

## Motivation

The editor shows what a schema *says*. Nothing in this repository shows what a store *holds*.
Today, the only way to look at data is to type a query into the CLI's REPL and read the rows it
prints as text. A thing prints as `entity:person:#3`, and a relation's role players cannot be seen
unless the query asks for each one.

TypeQLite describes a graph: things linked by relations through roles, with attributes owned by
type and value. Reading one as a graph shows the structure, and lets you explore it by expanding a
node instead of writing the next query. TypeDB users already know this from TypeDB Studio.

## The model: TypeDB Studio

Studio is TypeDB's own IDE. It is a web application written in Angular, with a desktop build made
with Tauri, and is licensed under MPL-2.0. Researched on 2026-11-12 from
[the Studio manual](https://typedb.com/docs/manual/studio) and
[its repository](https://github.com/typedb/typedb-studio). Re-check it before Phase 00, because
the web app always serves the latest release.

| Studio | What it does | Here |
| ------ | ------------ | ---- |
| **Connection** | Address and credentials, or a connection string, to a TypeDB server's HTTP endpoint | **Different by nature.** TypeDBLite is embedded: there is no server to connect to. "Connecting" means opening a database file, or an in-memory store with the workspace schema applied |
| **Database menu** | Select, create or delete a database; load a sample dataset | Open, create or close a database file. Sample datasets are deferred |
| **Transaction control** | *Auto*: one transaction per query, its type found from the query. *Manual*: read, write or schema; Open, Commit, Rollback, Close; a `*` marks uncommitted changes | Both modes. `beginTransaction`, `commitTransaction` and `rollbackTransaction` exist. Auto mode needs the CLI's statement classification, moved somewhere shared |
| **Query tool** | A schema pane, an editor with tabs, results, and history. Run with Ctrl+Enter. A row limit of 10 to 100,000, defaulting to 100 | The editor already exists: the `.tql` file. Add **Run** on a statement (a command, a CodeLens and Ctrl+Enter) and a results panel |
| **Results: Log, Table, Graph, Raw** | Log is console text. Table shows one row per answer, or a fetch's top-level keys. Graph is for `match` without `fetch`, and for `insert`. Raw is the JSON response | **The same four views.** Log shows execution facts (ADR-004). Table shows rows. Graph shows concepts. Raw shows the engine's report as JSON |
| **Graph visualisation** | Entity: rounded rectangle. Relation: diamond. Attribute: ellipse. Role: grey. Edges for `has`, `links` (labelled with the role), `isa`, `sub`, `owns`, `relates` and `plays`. Zoom, pan, drag; click to highlight a node's neighbourhood; search by iid, value, type or label | The same shape conventions, which TypeDB users already read, in this project's own theme |
| **Expand** | Right-click a node: *Load relations*, *Load links* or *Load attributes*, either for this node or for every node of its type | **The core of exploring.** Each expansion is a TypeQLite query pinned by `iid` |
| **Schema tool** | Draws types and only their *declared* `sub`, `owns`, `relates` and `plays` edges; inherited ones are not drawn | `schemaSnapshot()` already returns exactly these edges |
| **Schema pane** | A tree with find, expand and collapse all, flat or hierarchical view, view the schema as text, and refresh | A native VS Code tree view |
| **Data explorer** | Browse instances in tables and detail views, and follow connections without writing queries | Browse by type. A detail view of one thing. Following a connection is an expansion |
| **History and saved queries** | History is kept in memory for the session. Saved queries are stored locally | Both |
| **Export** | Copy or download as JSON or CSV; save the graph as PNG | JSON and CSV first. PNG later |
| Agent mode, user manager | Natural language to TypeQL using OpenAI; server user accounts | **Out of scope** |

**This is modelled on Studio, not a copy of it.** It does not reuse Studio's name, code, assets or
theme. Under MPL-2.0, any file copied from Studio would have to stay MPL-licensed, so Phase 00
records that nothing is copied. The shape conventions are TypeDB's visual vocabulary, not Studio
artwork.

## What already exists — verified on disk 2026-11-12

This is load-bearing. Check it again before relying on it.

| Thing | State |
| ----- | ----- |
| Answers | `query()` returns `rows` of `TypeDBLiteValue` cells. An entity or relation carries its `iid` and its actual `type`. An attribute carries its `type` and value. A `fetch` returns `documents` (JSON). **A thing cell is already a node** |
| Attribute identity | Stored once per type and value ([ADR-006](../../architecture/adr-006-an-attribute-is-stored-once-per-type-and-value.md)) and has **no iid**. Its node key is `(type, value)` |
| Pinning by iid | The grammar admits `$x iid 0x…` (`typeqlite.langium`, at line 639) and `iid($x)`. So "expand this node" can be written as a query |
| Role names in answers | **Not verified.** For a `links` edge to carry its role label, a query must be able to return the role a player plays. Phase 00 checks whether a role-type variable works in TypeQLite. If it does not, the graph is a real caller for that construct ([AGENTS.md](../../../AGENTS.md), caller-first) |
| Schema | `schemaSnapshot()` returns `types`, `relations`, `attributes`, `owns`, `parents`, `valueTypes`, `roles`, `plays` and `annotations`. **This is the schema graph, already as data** |
| Reading a thing | `attributesOf(iid, attribute)` is public. Reading a relation's role players, or the relations a thing plays in, goes through a query |
| Transactions | `beginTransaction`, `commitTransaction` and `rollbackTransaction` on the interpreter. `SqliteEngine` wraps them, and the async `define`, `execute` and `query` |
| Statement classification | [`apps/cli/src/session.ts`](../../../apps/cli/src/session.ts) chooses between define, read and write by the leading keyword and the write stages. It lives in the CLI, and the [debugger](../debugger/debugger.feature.md) needs it too |
| Live changes | The change log and change stream (ADR-003) publish every write as a revision over SSE. **A graph could refresh when the store changes**, but nothing uses them for that yet |
| SQLite outside Node | `SqliteDatabase` is an interface. The runtime README says "a WASM SQLite binding running synchronously inside a Web Worker satisfies this interface", so **the engine could run inside a browser** |
| Extension | [`apps/vscode`](../../../apps/vscode) has no webview, no tree view, no commands besides the language server's, and never loads the runtime |

## Shared with the debugger

Both features need the same thing, and neither should build it alone:

- **An engine host.** Something on the editor's side that opens a database, runs a statement in a
  transaction, and returns rows, facts and refusals. It has to answer **where the engine runs**:
  in the extension host (which depends on `node:sqlite` being in Electron's Node, not yet
  verified), in a separate Node process, or in a worker running WASM SQLite.
- **One statement classifier** for define, read and write, moved out of the CLI and shared.
- **Not shared: the rule for writes.** The debugger avoids the question by always running in
  `:memory:` ([its invariant 4](../debugger/debugger.feature.md#-the-invariants-every-phase-is-bound-by)).
  The explorer opens real stores, so it keeps its own rule (invariant 3 below). If copying a store
  into memory is built for the debugger, the explorer could reuse it for a "scratch copy" mode.

If both features are scheduled, these become the first feature of an initiative. If only this one
is scheduled, they are its Phase 01.

## 🔴 The invariants every phase is bound by

**1. The explorer reads through TypeQLite, and only through it.** Every table, graph, expansion
and detail view comes from `query()` or `schemaSnapshot()`. There is no SQL against the store
and no read path private to the explorer. This makes every expansion a query the user could have
typed, so the **Log** view shows it, and a bug in the explorer can be reproduced in the REPL. If
the explorer needs something TypeQLite cannot ask, that is a grammar question, decided
caller-first.

**2. The explorer changes nothing about the engine's answers.** It adds no runtime behaviour. Any
runtime change it does need (an export, a role-variable construct) goes through the usual path,
and the conformance run stays at **1742 of 1756**
([ADR-005](../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).

**3. Nothing is written unless the user chose to write.** In auto mode a write commits, as it does
in Studio. That is the user's choice, so the transaction control always shows which mode is on.
Manual mode shows uncommitted changes. Expanding a node is always a read.

**4. A graph is bounded.** Every query the explorer runs has a row limit (Studio's default is 100).
An expansion of "every node of this type" reports how many nodes it did not draw. A store with
200,000 things must not freeze the editor.

**5. The extension still never defines TypeQLite** (the editor's invariant 2). Statement
classification, value rendering and type kinds all come from the runtime and the language library.

## Goals

1. **Open a database** from the editor: a file, or an in-memory store with the workspace schema
   applied, with auto and manual transactions.
2. **Run a statement** from a `.tql` file and see its answers as **Log**, **Table**, **Graph** and
   **Raw**.
3. **A schema view**: a tree of types, plus a graph of their declared `sub`, `owns`, `relates` and
   `plays` edges.
4. **An answer graph**: things, relations and attributes as nodes, with `has` and `links` edges,
   roles labelled. Zoom, pan, drag, highlight a neighbourhood, and search.
5. **Exploring**: expand a node's relations, links or attributes, for that node or for every node of
   its type. Browse the instances of a type, and open the detail of one thing.
6. **History, saved queries and export** to JSON and CSV.

## Definition of done

Each item names where it is to be proven. "e2e" means `nx run typeqlite-vscode:e2e` against the
packaged `.vsix`.

- [ ] Engine-host specs, run without VS Code: open, define, write, read, commit, roll back, close;
      auto mode classifies statements the same way the CLI does.
- [ ] A read run from a `.tql` file shows its rows in the Table view and its facts in the Log view.
      *e2e.*
- [ ] Answers become a graph model (nodes and edges) through a pure function with its own specs.
      Each entity, relation and attribute gives one node; attributes are keyed by `(type, value)`;
      each role player gives a `links` edge labelled with its role.
- [ ] Each expansion is a spec'd TypeQLite query, and the Log view shows the query it ran.
- [ ] The schema graph from `schemaSnapshot()` matches a fixture schema's declared edges exactly,
      and draws no inherited edges.
- [ ] An expansion past the row limit reports how many nodes it did not draw.
- [ ] A write in manual mode is gone after Rollback, and present after Commit. *e2e.*
- [ ] The webview renders a graph from a fixture store, and expanding a node adds its neighbours.
      *e2e, asserted through the webview's message protocol rather than pixels.*
- [ ] 🔴 The conformance run is unchanged at **1742 of 1756**.
- [ ] `AGENTS.md`, the README and the project overview memory name the explorer.
- [ ] Build, typecheck and test are green for everything touched, from a clean tree.

## Out of scope

- **Agent mode** (natural language to TypeQL) and the **user manager**. TypeDBLite has no server
  and no accounts.
- **Connecting to a TypeDB server.** This explores TypeDBLite stores. TypeDB has Studio.
- **A standalone web or desktop app.** VS Code first. The graph UI is a plain web bundle talking to
  the engine through a message protocol, so it *could* be hosted in a page with WASM SQLite later.
- **Editing data through the graph** (drag to link, delete a node). Writes are statements the user
  writes.
- **Sample datasets.** Deferred until there is a dataset worth shipping.
- **downstream-app's store app.** It has its own client. Exploring that store is downstream-app's
  work, built on this feature's host protocol.

## Open questions for Phase 00

These are for the founder.

1. **Initiative or feature?** The recommendation is an initiative over this feature and the
   debugger, with the engine host as its first feature, once either is scheduled.
2. **Where the engine runs:** in the extension host, in a separate Node process, or in a worker
   with WASM SQLite. This is shared with the debugger, and the two must agree.
3. **Graph library.** Candidates: Sigma.js with Graphology (WebGL, built for large graphs),
   Cytoscape.js (rich layouts and styling), or vis-network. Choose on the size bound
   (invariant 4) and licence. Which library Studio uses was not confirmed.
4. **The UI's framework inside the webview:** none (plain DOM), or a small one. Studio uses
   Angular, which would be heavy here.
5. **Live refresh:** should a graph update when the store changes, using the change log (ADR-003)?
   Or only when asked?

## How this gets proven

**The data is proven without a screen.** Answers to graph model, snapshot to schema graph, and
node to expansion query are each pure functions with specs over fixture stores. Rendering then has
little logic left to break.

**The host is proven without VS Code**, as a protocol driven from plain Node, the way
`server.test.ts` drives the language server.

**The webview is proven through its messages.** The e2e opens the panel, posts the protocol's
messages, and asserts the model it reports. Pixel tests are not used.

## Phase Plan

| # | Phase | Status | Summary |
| - | ----- | ------ | ------- |
| 00 | Scope, the Studio mapping, the shared engine host, and the ADR | Not started | |
| 01 | Engine host: open, transactions, run, a shared classifier (moves to the initiative if one is written) | Not started | |
| 02 | Run and results: Run on a statement, and the Log, Table and Raw views | Not started | |
| 03 | Schema: the type tree and the schema graph | Not started | |
| 04 | Answer graph: the graph model, rendering, highlight, search | Not started | |
| 05 | Exploring: expansions, browse by type, thing detail, size bounds | Not started | |
| 06 | History, saved queries, export | Not started | |
| 07 | Packaging, e2e, docs | Not started | |

## Phase Intent

This is a forward plan. Each phase's checklist is written when that phase starts.

**00 — Scope and the ADR.** Answer the open questions. Re-check Studio against its current manual.
Check whether a role-type variable works in TypeQLite, and whether `node:sqlite` is in VS Code's
Electron Node. Choose the graph library and the webview stack.

**01 — Engine host.** A process or module that opens a database and runs statements in auto or
manual transactions, behind a message protocol, with specs run without VS Code. The CLI's
classifier moves somewhere shared. If an initiative is written, this phase becomes its first
feature, and the debugger uses it too.

**02 — Run and results.** A **Run** command, a CodeLens and Ctrl+Enter on a statement in a `.tql`
file. A results panel with the Log, Table and Raw views. A transaction control in the status bar.

**03 — Schema.** A tree view of types in the sidebar. A schema graph from `schemaSnapshot()` with
declared edges only.

**04 — Answer graph.** The pure graph model. The Graph view: shapes by kind, roles labelled, zoom,
pan, drag, highlight a neighbourhood, search by iid, value or label.

**05 — Exploring.** Expand a node's relations, links or attributes, for this node or for every node
of its type, each as an iid-pinned query shown in the Log view. Browse instances by type. A detail
view of one thing. The size bound, with what was left undrawn reported.

**06 — History, saved queries and export.** Session history. Saved queries in workspace state.
Copy or download as JSON or CSV. PNG if the graph library makes it cheap.

**07 — Packaging.** The webview bundle in the `.vsix`. The e2e cases. The README and `AGENTS.md`.

## Deferred

Anything a phase defers is recorded here, not only in a commit message.

- *(none yet)*

## Key Documents

- [TypeQLite Editor](../editor/editor.feature.md) and
  [ADR-008](../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md):
  the extension this builds on
- [TypeQLite Debugger](../debugger/debugger.feature.md): the other proposed feature that needs an
  engine host
- [ADR-003](../../architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md): the change
  log, for live refresh
- [ADR-004](../../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md):
  execution facts, which become the Log view
- [ADR-006](../../architecture/adr-006-an-attribute-is-stored-once-per-type-and-value.md): why an
  attribute node is keyed by type and value
- [`libs/runtime/README.md`](../../../libs/runtime/README.md): the `SqliteDatabase` interface, and
  WASM SQLite
- [TypeDB Studio manual](https://typedb.com/docs/manual/studio) and
  [repository](https://github.com/typedb/typedb-studio)
