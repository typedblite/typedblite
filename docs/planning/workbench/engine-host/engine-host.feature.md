---
kind: feature
status: in-progress
decided-by: [adr-011]
title: TypeQLite Engine Host (a standalone NestJS CQRS app)
feature: engine-host
branch: feat/engine-host
initiative: workbench
depends-on: [editor]
---

# TypeQLite Engine Host — Feature Doc

> **Status:** 🚧 Phase 00 in progress (opened 2026-11-19) · **Written:** 2026-11-17 · **Branch:** `feat/engine-host`,
> from `main` · **Depends on:** [TypeQLite Editor](../../editor/editor.feature.md)
> (complete) · **First feature of:** the [Workbench initiative](../workbench.initiative.md) ·
> **Governed by:** [ADR-011](../../../architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md)
>
> Request, 2026-11-17: *an initiative covering the graph explorer, debugger and notebook, with the
> engine host and its session construct.*
>
> Decided by the founder, 2026-11-17, after this document was first written: **the engine host is a
> standalone NestJS CQRS app, with the four standard transports (CLI, REPL, sidecar, HTTP) and a
> fifth, an MCP server.** It is an app in `apps/`, not a library and not part of the language
> server. Phase 00 records this in an ADR and settles what is left open below.
>
> The [graph explorer](../graph-explorer/graph-explorer.feature.md), the
> [debugger](../debugger/debugger.feature.md) and the [notebook](../notebook/notebook.feature.md)
> each need to run TypeQLite from the editor. This feature builds that once, as a process they talk
> to. Its consumers are not built here.

## Process

Per the [Multi-Phase Lifecycle Standard](../../../standards/governance/multi-phase-lifecycle-standard.md).
`feat/engine-host` is cut from `main` when Phase 00 starts. Each phase branch,
`phase/engine-host/<NN>-<slug>`, is cut from it and merges back into it. Each phase's checklist is
written when that phase starts. Questions for the founder are asked in Phase 00.

## Motivation

The editor never loads the runtime. It is a language server: it reads `.tql` and says what is wrong
with it. Running a statement is a different job, with a database, transactions and a lifetime.
Three planned features each need that job, and each document had a paragraph saying so. Building it
three times would decide a statement's meaning in three places.

## The shape: one application, five transports

The shape is the one a downstream application already uses for each of its bounded contexts: a
**NestJS application over a CQRS core**. A caller sends a **command** (changes state) or a **query**
(reads it) and gets JSON back. The transports are thin adapters over one dispatch path. An operation
behaves identically however it is reached, and no transport reimplements it.

| Transport | How | Use it when |
| --------- | --- | ----------- |
| **CLI** | `typedblite-host <operation> [--key value]` | One-off or scripted use. One shot, an exit code to branch on |
| **REPL** | `typedblite-host --repl` | Exploring by hand, with tab completion and `help <operation>` |
| **Sidecar** | `typedblite-host --sidecar` | A long-lived driver sending newline-delimited JSON on stdio. **This is how the editor talks to it** |
| **HTTP** | `typedblite-host` (no mode flag) | A UI, a webview's backend, or a caller in another process |
| **MCP** | `--mcp` (stdio), `--mcp-http` (loopback) | An agent connects to the host's operations as tools |

Names and flags above are a first guess for Phase 00 to settle. Three lessons from that downstream
application are taken as requirements here:

- **HTTP is generic dispatch over the operation list**, not a route per operation, so each input
  shape is declared once.
- **An unrecognised mode flag is refused by name.** A mistyped flag must not fall through and start
  a long-lived server that a script waits on forever.
- **MCP exposes tools only, reads by default.** Writes are opt-in, and HTTP MCP is loopback only
  until authentication exists.

## The session construct

A **session** is one open store with a lifetime. It is the thing a notebook calls a kernel, the
explorer calls a connection, and the debugger calls a launch. In the CQRS core it is an aggregate,
and these are its operations, as a first sketch:

| Kind | Operation | Meaning |
| ---- | --------- | ------- |
| Command | `session.open` | On a location: `:memory:` (optionally with the workspace schema applied) or a file. Returns a session id |
| Command | `session.run` | One statement in the session's store. Returns **rows**, execution **facts** ([ADR-004](../../../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md)) and a **refusal** if the engine refused, never a thrown internal |
| Command | `session.begin`, `session.commit`, `session.rollback` | Manual transactions. In **auto** mode (the default) a transaction per statement, its kind found by the classifier |
| Command | `session.restart` | Drops the store and opens again from the same location |
| Command | `session.close` | Releases the file. A closed session refuses every run |
| Query | `session.get`, `session.list` | The state of one session, or of all: location, mode, whether there are uncommitted changes |
| Query | `schema.get` | The `schemaSnapshot()` of a session's store |
| Query | `statement.classify` | What the classifier says a statement is, without running it |

A **session id** lets the host hold several at once (two notebooks, a notebook and a debug launch)
without them sharing a store.

🔴 **A session lives in the host process's memory.** That suits the REPL, the sidecar, HTTP and MCP,
which are long-lived. It does **not** suit the **CLI**, which is one shot: a session opened by one
invocation is gone when the process exits. Over the CLI, `session.run` takes a location directly and
opens, runs and closes in one call. State across CLI invocations is the file, not the session.

**This generalises something that exists.**
[`TypeDBLiteSession`](../../../../apps/cli/src/session.ts) is the piece the REPL and the CLI share.
It has a location, a `run`, a textual classifier and `splitStatements`, and returns an `Outcome` of
rows, ok or error. It has no transactions, no facts, no restart, no id and no dispatch. Phase 00
decides whether the host's session core replaces it (the CLI then uses it) or wraps it. Either way
the `typedblite` CLI's behaviour does not change.

## What already exists — verify before relying on it

This is load-bearing. It was written on 2026-11-17 from the other feature documents and a read of
`session.ts`. Check it again when Phase 00 starts.

| Thing | State |
| ----- | ----- |
| CLI session | [`apps/cli/src/session.ts`](../../../../apps/cli/src/session.ts): `TypeDBLiteSession`, `Outcome`, `splitStatements`. Classification is textual on the leading keyword, deliberately |
| Transactions | `beginTransaction`, `commitTransaction`, `rollbackTransaction` on the interpreter; `SqliteEngine` wraps them and the async `define`, `execute` and `query` |
| Execution facts | Returned as a report (ADR-004) |
| SQLite in Node | Only [`node-sqlite.ts`](../../../../libs/runtime/src/node-sqlite.ts) imports `node:sqlite`. The workspace's Node is ≥ 22.16. **Whether the extension host's Electron Node has `node:sqlite` is not verified** |
| SQLite outside Node | `SqliteDatabase` is an interface, and ADR-009's WASM binding exists, so a worker is possible |
| Extension | [`apps/vscode`](../../../../apps/vscode) never loads the runtime, and has no host, webview or protocol |
| NestJS | **Not in this repository.** Nothing here depends on `@nestjs/*` today. See invariant 7 |
| Dependency rule | `vscode` depends on `language` only. A host app depends on `runtime`, which changes the graph in [AGENTS.md](../../../../AGENTS.md). The extension would reach the host over a transport, not by importing it |

## 🔴 The invariants every phase is bound by

**1. The host runs statements through TypeQLite, and only through it.** No SQL against the store
and no path private to a consumer. Every statement a consumer runs is one a user could paste into
the REPL.

**2. The host adds no engine behaviour.** The conformance run stays at **1742 of 1756**
([ADR-005](../../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).
Anything it needs from the runtime goes through the usual path.

**3. One classifier.** It moves out of the CLI and is used by the CLI and the host. It stays
textual unless a real case forces more, for the reason `session.ts` already gives.

**4. A session owns its store.** Two sessions never share a store handle, even on one file. What
two sessions on the same file may do is a Phase 00 decision, not an accident.

**5. One dispatch path.** Every transport sends the same command or query through the same bus. An
operation is declared once, with an input schema, and the CLI, REPL, sidecar, HTTP and MCP all read
that declaration. A transport that implements an operation itself has failed this invariant.

**6. The extension still never defines TypeQLite, and never imports the host.** It starts the host
as a process and sends it operations. Rendering of values and type kinds comes from the runtime and
the language library.

**7. NestJS stays out of the engine.** `@typedblite/runtime` and `@typedblite/language` take no
dependency on NestJS, and TypeDBLite stays embeddable with no server and no native binary. The host
is a development tool in `apps/`, depends on the runtime, and is never a dependency of it. It is
**not** published as part of the runtime, and whether it is published at all is a Phase 00 decision.

**8. MCP is read-only unless told otherwise.** The MCP transport exposes reads by default, and a
write tier is opt-in. A host that holds real stores must not let an agent write to one by default
([the same rule as the explorer's invariant 3](../graph-explorer/graph-explorer.feature.md#-the-invariants-every-phase-is-bound-by)).

## Goals

1. **A session** with the lifecycle above, as a CQRS core that is proven without any transport.
2. **A statement classifier** shared with the CLI, and the CLI moved onto it.
3. **Five transports** over the one dispatch path: CLI, REPL, sidecar, HTTP and MCP.
4. **A decision on how the editor reaches it**, with the evidence: the sidecar over stdio is the
   expected answer, and it needs a `node` the extension can launch.
5. **A thin client in `apps/vscode`** that starts the host and exposes its operations to the
   consumers. No UI.

## Definition of done

- [ ] Core specs, run with no transport and no VS Code: open, define, write, read, commit, roll back,
      restart, close; a closed session refuses; two sessions keep separate stores.
- [ ] Auto mode classifies statements the same way the CLI did before the move: the CLI's existing
      specs pass unchanged.
- [ ] A write in manual mode is gone after rollback and present after commit.
- [ ] Facts and refusals come back as data, with the engine's own message.
- [ ] **One operation, five transports:** a parity spec sends the same operation through each
      transport and asserts the same answer.
- [ ] An unrecognised mode flag exits 2 and names the flag. It never starts a server.
- [ ] MCP lists only operations that declare an input schema, exposes reads by default, refuses a
      write unless the write tier is on, and HTTP MCP refuses a non-loopback host.
- [ ] The decision on where the engine runs, and on adding NestJS to the repository, is an ADR.
- [ ] The extension starts the host over the sidecar and a smoke test reaches it. *e2e against the
      packaged `.vsix`.*
- [ ] 🔴 The conformance run is unchanged at **1742 of 1756**, and `@typedblite/runtime` has no new
      dependency.
- [ ] `AGENTS.md` (including its layout and dependency graph), the README and the project overview
      memory name the host.
- [ ] Build, typecheck and test are green for everything touched, from a clean tree.

## Out of scope

- Any UI: results, graphs, notebooks and debug views belong to the consumers.
- Authentication and a non-loopback HTTP or MCP listener. Loopback only, until a feature adds it.
- Putting NestJS into the runtime or the language library.
- The debugger's step hook, which lives in the runtime and belongs to the debugger.
- Connecting to a TypeDB server.
- Anything that changes an answer the engine gives.

## Open questions for Phase 00

**All nine were answered on 2026-11-19 in [ADR-011](../../../architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md)** (D1 to D9, in this order). The text below is kept as asked. One check is left: `node:sqlite` in the desktop Electron's Node (Phase 05).

1. ~~**Where the engine runs.**~~ **Largely decided 2026-11-17: a separate process, the host.** What
   remains is **how the editor launches it.** The extension needs a `node` on the user's PATH, or
   Electron's own Node run as a plain Node (`ELECTRON_RUN_AS_NODE`), and in the second case whether
   `node:sqlite` is present is not verified. A packaged binary is another option.
2. **NestJS in a repository that has none.** It adds a dependency tree, decorators and
   `reflect-metadata`, to a project whose reason to exist is to be small and embedded. Invariant 7
   fences it into one app. Confirm that this is the trade, and decide whether the host is published.
3. **Replace or wrap** the CLI's `TypeDBLiteSession`, and whether the `typedblite` CLI becomes the
   host's CLI transport or stays separate.
4. **Names.** The app, its package (`@typedblite/engine-host`?), the binary, and the operation
   names. The names above are guesses.
5. **Two sessions on one file.** Refuse the second, allow read-only, or let SQLite arbitrate? A
   store may take an exclusive lock, which would make the HTTP server and a REPL on one file
   mutually exclusive. Check it.
6. **Several statements in one `session.run`.** One statement, or a source the host splits? What
   happens when the third fails after the first two committed?
7. **The debugger.** Its step hook lives in the runtime. How does a debug run reach it through the
   host: an operation such as `session.trace`, or the adapter loading the runtime itself? Settle it
   with the debugger's execution model, which may need a worker inside the host.
8. **The MCP tool set.** Which operations are tools. Running a statement is the useful one and also
   the dangerous one, so it needs the most thought.
9. **Is the operation set public API?** A downstream application loads the runtime's `out/` folder,
   so anything exported becomes something that project can depend on.

## How this gets proven

**With no transport.** The CQRS core is a module, and its handlers are specs. Nearly all of the
behaviour is proven here.

**Through the transports.** A parity spec sends the same operations through each one, so a transport
cannot drift from the core. The sidecar and CLI are driven as child processes from plain Node.

**In the e2e**, only that the packaged extension starts the host and reaches it.

## Phase Plan

| # | Phase | Status | Summary |
| - | ----- | ------ | ------- |
| 00 | Scope, the NestJS and launch decisions, operation names, and the ADR | In progress | [checklist](phases/00-scope-and-adr/checklist.md) |
| 01 | The core: the session aggregate, its commands and queries, the shared classifier | Not started | |
| 02 | The host on `@devx-micro/app-*`: operations declared once, CLI, REPL and sidecar entry points, and the parity spec | Not started | |
| 03 | HTTP through `app-http`, as generic dispatch | Not started | |
| 04 | MCP transport: tools, the read-only default, the write tier. **Where it lives is deferred** (host or a new `app-mcp`) | Not started | |
| 05 | The client in `apps/vscode`, packaging, e2e smoke test, docs | Not started | |

## Phase Intent

This is a forward plan. Each phase's checklist is written when that phase starts.

**00 — Scope and the ADR.** Answer the open questions. Check `node:sqlite` in the editor's Electron
Node, and whether a store takes an exclusive lock. Decide how the editor launches the host, and
whether NestJS enters the repository. Write the ADR.

**01 — The core.** The app skeleton, the session aggregate, the command and query handlers, and the
classifier moved out of the CLI. The `typedblite` CLI moves onto them with no change to its specs.
No transport yet: the specs call the bus.

**02 — CLI, REPL and sidecar.** Built on `@devx-micro/app-main`, `app-runtime`, `app-cli`, `app-repl` and `app-sidecar` (ADR-011 D10), so the work is declaring the operations and composing them. The three transports that need no server. The sidecar is what the
editor will use, so it comes first. The unknown-mode-flag refusal and the parity spec land here.

**03 — HTTP.** One generic dispatch route over the operation list, through `app-http`.

**04 — MCP.** Stdio and loopback Streamable HTTP. Tools only, reads by default, the write tier
opt-in, and a spec that a non-loopback host is refused.

**05 — The client.** `apps/vscode` starts the host over the sidecar and exposes the operations.
Packaging, the e2e smoke test, `AGENTS.md` and the README.

## Deferred

Anything a phase defers is recorded here, not only in a commit message.

- **Where MCP lives**, in the host or as `app-mcp` in devx-micro: decided at Phase 04 (2026-11-19).
- **Publishing `@devx-micro/app-*`**: `app-main` is not on the local registry yet, and none is on npmjs.org. A public `npm ci` of this repository needs them (ADR-011 D10). Phase 01 needs the local ones only.

## Key Documents

- [Workbench initiative](../workbench.initiative.md): the sequencing and what the host owns
- [Graph explorer](../graph-explorer/graph-explorer.feature.md),
  [debugger](../debugger/debugger.feature.md) and [notebook](../notebook/notebook.feature.md): the
  consumers
- [TypeQLite Editor](../../editor/editor.feature.md) and
  [ADR-008](../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
- [ADR-004](../../../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md):
  execution facts
- [ADR-009](../../../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md): the WASM
  binding, which makes a worker possible
- [`libs/runtime/README.md`](../../../../libs/runtime/README.md): the `SqliteDatabase` interface
- [`apps/cli/src/session.ts`](../../../../apps/cli/src/session.ts): the session the host generalises
