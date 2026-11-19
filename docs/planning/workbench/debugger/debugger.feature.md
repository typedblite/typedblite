---
kind: feature
status: in-progress
decided-by: [adr-014]
title: TypeQLite Debugger
feature: debugger
branch: feat/debugger
initiative: workbench
depends-on: [editor, engine-host]
---

# TypeQLite Debugger — Feature Doc

> **Status:** 🚧 In progress (2026-11-19): phases 00–04 complete; [ADR-014](../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)
> accepted · **Written:** 2026-11-12 · **Branch:** `feat/debugger`, from `main`
> (`4fa6d8d`), cut 2026-11-19 · **Depends on:** [TypeQLite Editor](../../editor/editor.feature.md) (complete),
> [engine host](../engine-host/engine-host.feature.md) (complete) · **Governed by:**
> [ADR-014](../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md).
> This document first named ADR-009, a number the WASM decision has since taken
>
> Request, 2026-11-12: *a debugger for TypeQLite, as a future feature. "I believe we should be able
> to use the Interpreter to make this possible."*
>
> **A feature in the [Workbench initiative](../workbench.initiative.md).** It has one deliverable:
> a debug adapter, plus the runtime hook that feeds it. It runs statements, so it depends on the
> [engine host](../engine-host/engine-host.feature.md), which the initiative builds first and
> shares with the [graph explorer](../graph-explorer/graph-explorer.feature.md) and the
> [notebook](../notebook/notebook.feature.md). The initiative document holds the sequencing.

## Process

Per the [Multi-Phase Lifecycle Standard](../../../standards/governance/multi-phase-lifecycle-standard.md).
`feat/debugger` is cut from `main` when Phase 00 starts. Each phase branch,
`phase/debugger/<NN>-<slug>`, is cut from `feat/debugger` and merges back into it. Each phase's
checklist is written when that phase starts. Questions for the founder are asked in Phase 00.

## Motivation

The most common TypeQLite failure is not an error: it is **a query that returns no rows**. Today
the engine reports this only after the fact, and only partly. When a projection comes back empty,
`runQuery` reports `typedblite.no-candidates` with two counts for each constraint, such as
"matched 5 candidate(s) before the constraints on `$p`, and 0 after". It cannot tell you *which*
pattern removed the rows, and the code's own comments explain why: four review rounds were spent
trying to make that one fact name the cause.

A debugger answers the question directly. Step through the pipeline and watch the row count at
each stage, and at each pattern inside a `match`, and stop at the first point where it reaches
zero. The same applies to writes: see the rows an `insert` or `delete` runs over, one row at a
time, in a `:memory:` store that no real database ever sees.

## Why the interpreter makes this possible

You are right that the interpreter can carry this. Verified on disk on 2026-11-12:

1. **It already runs in discrete steps, with rows passed between them.**
   [`runStages`](../../../../libs/runtime/src/interpreter.ts) is one loop over a pipeline's stages.
   Each stage turns an `Array<Record<string, Binding>>` into another one. **A stage boundary is a
   step, and the rows array at that boundary is the Variables view.**
2. **It already marks the steps inside a `match`.** `combinations()` calls `note(stage)` after
   each step it takes: `types`, `thing $x`, `relation $r early filter`, `relation $r bind`,
   `attribute $a`, `disjunction`, `optional`, and `negation`. Each call records how many
   combinations survive. These are the step-into points inside a `match`, and they already have
   names.
3. **There is precedent for a hook that costs nothing when it is off.** `QueryTrace` is off by
   default, and each of its hooks is a single `undefined` check (`if (!this.trace) return`). A
   debug hook can follow the same pattern.
4. **Every step has a source range.** Stages and patterns are Langium nodes, and `rangeOf(node)`
   is already used for every diagnostic. So a stop can show the right line, and a line breakpoint
   can be matched to a step.
5. **Functions and `fetch` sub-queries go back through `runStages`.** `callFunction` plans the
   function body and runs it with `runStages`, and a fetch sub-query does the same from one parent
   answer. **Those are nested stack frames**, and each uses the same step points as the top-level
   pipeline.
6. **Failures are already typed.** A refusal goes through `refuse(code, message, range)` and
   carries a stable `DiagnosticCode`. An empty write gets a fact (`typedblite.empty-match`). Both
   fit a debugger's exception breakpoints, for example "break on refusal" and "break when a stage
   empties".
7. **An in-memory store is the default.** Both `TypeDBLiteInterpreter` and `SqliteEngine` take
   `location = ':memory:'` unless given a path, and `applyJournalMode` already skips `:memory:`.
   A debug session therefore never needs to open a database file, so it **cannot change an
   existing database** (invariant 4).

### 🔴 The one obstacle, and three ways around it

The editor's feature document gave this as the reason a debugger was out of scope: *"The
interpreter executes eagerly against SQLite. Nothing in it suspends and resumes."* That is still
true. It is **synchronous by design**. The runtime README explains that making it async "would
require rewriting the interpreter throughout", and `SqliteDatabase` is synchronous all the way
down. A debugger has to work around this without rewriting the interpreter:

| | Approach | How it pauses | Cost | Gains |
| - | -------- | ------------- | ---- | ----- |
| **A** | **Record, then replay.** Run the statement to completion with the hook recording every step, then let the user step through the recording. | It never pauses. The adapter serves stops from the recording. | The smallest change to the runtime: the hook appends events to an array. Large row sets must be capped (see invariant 5). Nothing can be changed mid-run. | **Stepping backwards comes for free** (DAP `supportsStepBack`). It suits the main question, "where did my rows go?", since that question is about looking back. Every query is deterministic. |
| **B** | **A worker that blocks.** The interpreter runs in a `worker_threads` worker. At a stop, the hook calls `Atomics.wait` on a `SharedArrayBuffer` until the adapter signals it to continue. | Truly live: the synchronous call stack waits at the hook. | Messages between the worker and the adapter. `node:sqlite` is opened inside the worker. Harder to test. | The debug console can query the transaction's live state at the point of the stop. Works for statements too large to record. |
| C | Rewrite the interpreter as generators so it can yield at each step. | Yields. | 6,060 lines, every caller, and the synchronous engine contract. | Nothing that A or B does not already give. **Rejected.** |

**Recommendation: A first, with the hook shaped so that B can be added later without changing
it.** Both consume the same sequence of step events. A only stores them, while B blocks on each
one. Phase 00 settles this in ADR-014 (B1 recommends A, one statement at a time).

### 🔴 What the interpreter makes harder — found in Phase 00, 2026-11-19

The list above holds. Reading `combinations()` again found four things this plan did not account for. Each has a
recommended answer in ADR-014.

1. **A `match` does not run in source order.** It runs by kind: type variables, then one step per thing
   *variable* (merging every pattern on it), then relations, attribute reads, `let`s and comparisons, `or` and
   `try`, and last `is` and `not`. Relation filters move earlier when `planJoins` is on. One step can consume
   several lines, and a later line can run first. `ThingConstraint.range` holds only the first pattern's range.
   *(B6)*
2. **Some steps have no `note()`:** attribute reads, `let`s, comparisons and `is`. A comparison is one of the
   likeliest places for rows to disappear. *(B6)*
3. **A `match` runs once per incoming row**, and a `fetch` sub-query once per parent answer, so each inner step
   repeats N times. *(B7)*
4. **A thing's type and attributes are read when asked.** Under replay they would show the store after the
   statement, not as it was at the stop. *(B8)*

## What already exists — verified on disk 2026-11-12, re-verified 2026-11-19

This is load-bearing. Check it again before relying on it.

| Thing | State |
| ----- | ----- |
| Interpreter | [`interpreter.ts`](../../../../libs/runtime/src/interpreter.ts), 6,280 lines (6,060 when this was written), holding `TypeDBLiteInterpreter`. Its public entry points are `define(text)`, `execute(text, given?)` and `query(text, given?)`, plus `beginTransaction`, `commitTransaction` and `rollbackTransaction` |
| Stage loop | `runStages(pipeline, scopes, start)` has one `switch` per stage type: match, insert, put, delete, update, select, sort, offset, limit, distinct, require and reduce. The rows array is replaced after each stage |
| Stage plan | `planStages` returns one `StreamScope` per stage boundary, giving the variables `available`, their `kinds` and their `valueTypes`. **That is the static half of the Variables view**: what each variable is, as well as its value |
| Steps inside a `match` | `combinations()` and its `note()` calls, from line 3968 (2026-11-19). They run by kind, not in source order, and some steps have none: see *What the interpreter makes harder* above |
| Trace precedent | `QueryTrace` and `lastQueryTrace()`, enabled by the `trace` option or `TYPEDBLITE_TRACE=1`, and tested in [`query-trace.test.ts`](../../../../libs/runtime/test/query-trace.test.ts) |
| Differential precedent | [`relation-join-planning-differential.test.ts`](../../../../libs/runtime/test/relation-join-planning-differential.test.ts) runs `planJoins: false` and `planJoins: true` and asserts that the two produce the same rows in the same order. **This is the shape of test that proves the debug hook changes nothing** |
| Execution facts | [`diagnostics.ts`](../../../../libs/runtime/src/diagnostics.ts) (ADR-004): facts are returned, never emitted, have stable codes, and are capped at `MAX_DIAGNOSTICS = 50` |
| Statement classification | **Moved since this was written:** `classifyStatement` and `splitStatements` live in [`@typedblite/session`](../../../../libs/session/src/classify.ts), shared by the CLI, the engine host and the playground. Invariant 6's prerequisite is met |
| Engine host | [`apps/engine-host`](../../../../apps/engine-host) (ADR-011): sessions, `session.run` of exactly one statement, `statement.split`, `statement.classify`. ADR-011 D7 leaves the debugger's route to this feature |
| SQLite | Only [`node-sqlite.ts`](../../../../libs/runtime/src/node-sqlite.ts) imports `node:sqlite`. The workspace's Node is ≥ 22.16. VS Code 1.146's Electron Node **has** `node:sqlite` (measured in the engine-host feature) |
| Extension | [`apps/vscode`](../../../../apps/vscode) depends on `@typedblite/language`, `@typedblite/notebook` and the sidecar client, and starts the engine host through its `HostClient`. It contributes no `debuggers` and no `breakpoints` |

## 🔴 The invariants every phase is bound by

**1. Debugging never changes an answer.** The same statement against the same store returns the
same rows in the same order, with the same facts and the same refusals, whether the hook is on or
off. This is proven two ways: by a differential test in the shape of the join-planning one, and by
**the conformance run with the hook switched on**, which must match the run with it off at **1742
of 1756** ([ADR-005](../../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).

**2. When the hook is off, it costs nothing.** Every hook point is one `undefined` check, as with
`QueryTrace`. The replication and oracle suites run thousands of queries each. Making them pay
for a feature they do not use has hung them before: see the comment on the empty-projection
diagnosis in `runQuery`.

**3. The runtime knows nothing of the Debug Adapter Protocol.** The hook is a plain TypeScript
interface that receives plain data: a step kind, a range, the rows, and the scope. The runtime
does not depend on `@vscode/debugadapter` and does not know about stack frames. This follows
ADR-004's rule ("returned, never emitted") and keeps the runtime usable wherever it is used now.
That includes a downstream application, which loads the runtime's `out/` folder.

**4. A debug session runs against `:memory:` and never opens an existing database.** Decided by
the founder on 2026-11-12. The adapter opens a `:memory:` session on the engine host, runs the
`schema` files and then the `seed` files that the launch names, in order, and then runs the program
(ADR-014 B9; there is no implicit workspace schema). 🔴 The host refuses `session.debug` on any
session that is not at `:memory:` (B2), so this holds where the store is opened. Writes in the program
behave as they would anywhere else, including commits, because they land in a store that
disappears when the session ends. This needs no rollback rule and no `commit` setting, and it is
not possible for a debugger to write to a real store by accident.

**5. A recording is bounded.** A single `match` has produced more than 200,000 combinations
before (the Skills-catalog defect `QueryTrace` was built for). The step counts are always
recorded. The rows are recorded up to a cap per step, and when rows are dropped the recording
says how many, just as `MAX_DIAGNOSTICS` does.

**6. There is no second parser and no second classifier.** The debugger runs statements through
the interpreter's own entry points. If it needs the CLI's choice between define, read and write,
that logic moves somewhere both can import. It is not copied.

## What a TypeQLite debug session looks like

How DAP's concepts map onto TypeQLite. Settled in Phase 00 as
[ADR-014](../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md) B11.

| DAP | TypeQLite |
| --- | --------- |
| Program | `program`, a `.tql` or `.typeqlite` file run statement by statement, after the launch's `schema` and `seed` files (B9), in a fresh `:memory:` session on the engine host |
| Thread | One. The interpreter is single-threaded |
| Stack frames | Statement › stage › `match` step. A function call site or a `fetch` sub-query pushes a frame (B7) |
| Step over | The next stage, or the next statement |
| Step into | Into a `match`, one step at a time **in execution order, not source order** (B6); into a function or a `fetch` sub-query |
| Step out | To the enclosing stage or statement |
| Step back, reverse continue | Over every statement recorded so far (B1) |
| Variables | **Rows** (paged; each row's bindings; each thing's type, iid and attributes **as at the step**, B8). **Scope** (`StreamScope`: kinds and value types). **By incoming row** (B7). **Dropped** (rows the cap left out, B10) |
| Line breakpoints | On a stage, or on each `match` step that consumes the line (B6) |
| Conditional breakpoints | On the step's row counts: `rowsIn`, `rowsOut` |
| Exception breakpoints | *On refusal*, carrying its `DiagnosticCode`; *when a step empties* (`rowsIn > 0 && rowsOut == 0`) |
| Debug console | Execution facts, in order. Evaluating expressions is out of scope (B1) |
| Run Without Debugging | `noDebug`: each statement goes through `session.run`, not `session.debug` |

## Goals

1. **A step hook in `@typedblite/runtime`.** It reports stage boundaries, steps inside a `match`,
   and function and sub-query frames, each with its range, rows and scope. It costs nothing when
   off (invariant 2) and changes nothing when on (invariant 1).
2. **A debug adapter** that runs a TypeQLite file against a database and serves DAP: launch,
   threads, stack trace, scopes, variables, stepping, breakpoints and output.
3. **Rows you can see.** At every stop, the current rows, each binding, and each concept's type,
   iid and attributes are shown, paged when large.
4. **Breakpoints that answer "where did my rows go?"**: line breakpoints on stages and patterns,
   row-count conditions, break when a stage empties, and break on refusal.
5. **No existing database is touched:** every session runs in a fresh `:memory:` store, built from
   the `schema` and `seed` files the launch names (invariant 4, ADR-014 B9).
6. **The editor gains a debugger.** `apps/vscode` contributes the `typeqlite` debug type, launch
   configuration snippets, and breakpoints in `.tql` and `.typeqlite` files. F5 on a file runs it
   under the debugger.

## Definition of done

Each item names where it is to be proven. "e2e" means `nx run typeqlite-vscode:e2e` against the
packaged `.vsix`.

- [ ] The hook's differential spec: hook on and hook off give the same rows, documents, facts and
      refusals, over the join-planning corpus and the pipeline-stage tests.
- [ ] 🔴 The conformance run with the hook on scores **1742 of 1756**, the same as with it off, and
      `baseline.json` is untouched.
- [ ] Adapter specs over DAP (`@vscode/debugadapter-testsupport` or an equivalent client): launch,
      stop on entry, step over, into and out across a function call, Variables at a stage
      boundary, and a breakpoint hit by line.
- [ ] A query whose rows disappear at a comparison in its `match` stops at that comparison's step
      under "break when a step empties", with the comparison's range highlighted. Asserted in the
      adapter specs **and** in the e2e.
- [ ] The adapter only ever constructs its engine at `:memory:`. A spec asserts this, and a session
      whose program writes and commits leaves every file in the workspace byte-for-byte unchanged.
- [ ] The e2e starts a session with `vscode.debug.startDebugging` on a fixture file, hits a
      breakpoint, reads the variables, steps, and the session ends cleanly.
- [ ] `AGENTS.md`'s layout and dependency graph, the README, and the project overview memory name
      the debugger.
- [ ] Build, typecheck and test are green for everything touched, from a clean tree.

## Out of scope

- **A results grid, a live schema browser, or a graph view.** That is the database IDE that the
  editor feature also left out.
- **Debugging against a downstream application's store.** That store lives in its own app. Attaching to it is
  that application's work, built on this feature's adapter.
- **Changing a variable's value mid-run** (DAP `setVariable`). Under approach A it is impossible;
  under B it raises the question of what a changed binding means for the rows already produced.
- **Data breakpoints**, for example "break when this attribute is written".
- **Debugging the SQL.** The debugger works at the level of TypeQLite steps. `QueryTrace` already
  counts statements for anyone working on performance.

## Open questions for Phase 00

These are for the founder. **Each has a recommended answer in
[ADR-014](../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md),
accepted 2026-11-19:** 1 → B1; 2 → B9 (seed and schema files only; copying a store deferred); 3 → B2 and B3 (the
engine runs in the host, the adapter inline in the extension host); 4 → B4 (`libs/debugger`); 5 → B5 (a
`@typedblite/runtime/debug` subpath only, internal).

1. **Execution model:** A (record, then replay), B (a worker that blocks), or A now and B later.
   The recommendation is A, then B if a real case needs it.
2. ~~**Which database a launch runs against.**~~ **Decided 2026-11-12: `:memory:`** (invariant 4).
   What remains is **how data gets in**. Seed files of `insert` statements are the plan. Should a
   launch also be able to **copy an existing store into memory**, so you can debug against real
   data without touching it? `node:sqlite` exposes `backup()` and `DatabaseSync#deserialize` on the
   Node 24 used here, but their availability on the workspace's minimum Node (22.16) is not
   verified. Either would also need the `SqliteDatabase` binding to accept something other than a
   location.
3. **Where the adapter runs** (the engine host decides where the *engine* runs; this is about the adapter): in-process in the extension host (which needs `node:sqlite` in
   Electron's Node, not yet verified), or as a separate Node process (`DebugAdapterExecutable`),
   which needs a `node` on the user's PATH.
4. **Where the adapter lives:** a new `libs/debugger` that `apps/vscode` bundles, or inside
   `apps/vscode`. A library can be tested without VS Code and reused downstream.
5. **Is the hook public API of `@typedblite/runtime`?** A downstream application loads the runtime's `out/`
   folder, so anything exported becomes something that project can depend on.

## How this gets proven

**The hook is proven harmless before anything uses it.** Phase 01 ends with the differential spec
and the conformance run with the hook on. No adapter work starts until both pass.

**The adapter is proven over DAP without VS Code.** It is driven by a protocol client in plain
Node, just as `apps/vscode/test/server.test.ts` drives the language server over stdio.

**Editor claims are proven by running the editor**, through the same e2e harness, against the
packaged `.vsix`.

## Phase Plan

| # | Phase | Status | Summary |
| - | ----- | ------ | ------- |
| 00 | [Scope, the DAP mapping, and ADR-014](phases/00-scope-and-adr/summary.md) | Complete | ADR-014 accepted, B1–B11 |
| 01 | [The step hook: events, the recording, the cap, and proof that it is harmless](phases/01-step-hook/summary.md) | Complete | Conformance with the hook on: 1742 of 1756, byte-identical |
| 02 | [Adapter shell: launch a file, statement-level steps, output, Run Without Debugging](phases/02-adapter-shell/summary.md) | Complete | `session.debug`, `statement.locate`, `libs/debugger` |
| 03 | [Stages and rows: stage steps, the Rows and Scope variables, line breakpoints](phases/03-stages-and-rows/summary.md) | Complete | Stage stops, paged rows, line breakpoints |
| 04 | [Inside a `match`: constraint steps, function and fetch frames, `or`/`not`/`try`](phases/04-inside-a-match/summary.md) | Complete | Steps in execution order; the splitter fixed |
| 05 | Breakpoints that answer "where did my rows go?": conditions, empty stage, refusal, step back | Not started | |
| 06 | The editor: the debug type, launch snippets, breakpoints in `.tql`, e2e, packaging | Not started | |

## Phase Intent

This is a forward plan. Each phase's checklist is written when that phase starts.

**00 — Scope, the DAP mapping, and ADR-014.** Answer the open questions. Fix the mapping table.
Settle the execution model, where the adapter runs and where it lives. Choose the debug-adapter
library and its version, and decide whether there is upstream code to diff against, as ADR-008 D8
did for the editor.

**01 — The step hook.** 🔴 This is the only phase that touches the interpreter, and the only one in
which invariants 1 and 2 can break. Add the hook interface, exported from `@typedblite/runtime/debug`
only (B5). Call it at stage boundaries, at `combinations()`'s existing `note()` points, at the new
points B6 names (attribute reads, `let`s, each comparison, `is`), and around `callFunction` and fetch
sub-queries. Each `match` step carries every range it consumes (B6). Add a recorder that implements
it: totals per step across incoming rows (B7), things described when recorded (B8), and the caps
(B10), whose numbers this phase measures. `@typedblite/session` gains a way to run one statement with
the recorder. Exit: the differential spec with `planJoins` on and off, conformance with the hook on,
and the performance suites unchanged with it off.

**02 — Adapter shell.** The engine host gains `session.debug` (B2), refused on any session not at
`:memory:`. `libs/debugger` (B4) serves a DAP session that launches a file, runs the launch's `schema`
and `seed` files (B9), splits the program with `statement.split`, and records one statement at a time
(B1). It stops on entry and steps over statements. Facts go to the console. Run Without Debugging
goes through `session.run`.

**03 — Stages and rows.** Stops at stage boundaries from the recording. The Rows variables, paged,
with each thing's type and attributes as recorded (B8). The Scope variables from `StreamScope`. Line
breakpoints matched to stages by range.

**04 — Inside a `match`.** Step into a `match`, one execution step at a time, with rows in and rows
out summed over incoming rows (B7), and every range of the step highlighted (B6). Line breakpoints on
the steps that consume a line. Nested `or`, `not` and `try` blocks. A function call site or a fetch
sub-query pushes a frame.

**05 — Breakpoints that matter.** Conditional breakpoints on `rowsIn` and `rowsOut`. Exception
breakpoints for a step that empties and for a refusal, carrying its code. Step back and reverse
continue across every statement recorded (B1).

**06 — The editor.** `apps/vscode` contributes the `typeqlite` debug type, its launch snippets,
and breakpoints in TypeQLite files. The adapter is bundled into the `.vsix`. The e2e drives a
session through `vscode.debug.startDebugging`.

## Deferred

Anything a phase defers is recorded here, not only in a commit message.

- **Copying an existing store into memory** (Phase 00, ADR-014 B9). `deserialize` is absent at the
  Node 22.16 minimum, `backup()` writes to a path, and either one opens an existing database, which
  invariant 4 rules out. Revisit when the Node minimum has `deserialize`, and decide then whether
  opening a store read-only to copy it breaks invariant 4.
- **A `with fun …` preamble is torn from its pipeline by the splitter** (Phase 04). A statement beginning with `with`
  ends at its first `;`, in the CLI's `--file`, the notebook and the debugger alike. Fixing it means deciding where a
  preamble ends, in `@typedblite/session`. Until then, a function to debug is defined in a schema file.
- **Evaluating expressions in the debug console** (Phase 00, ADR-014 B1). It needs a store that is
  still at the stop, which only a blocking worker (approach B) gives.
- **Streaming a recording in parts** (Phase 00, ADR-014). Phase 01 measured the largest realistic recording at
  2.1 MB (a 6,000-row join), an eighth of the 16 MB ceiling, so one JSON line is enough. Revisit only if a real
  program passes the ceiling.

## Key Documents

- [TypeQLite Editor](../../editor/editor.feature.md), the feature this one builds on, and
  [ADR-008](../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
- [ADR-004](../../../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md):
  facts are returned, never emitted. The hook follows the same rule
- [ADR-005](../../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md):
  the conformance pass count may never go down. It is this feature's regression oracle, with the
  hook on
- [Multi-Phase Lifecycle Standard](../../../standards/governance/multi-phase-lifecycle-standard.md)
- [`libs/runtime/README.md`](../../../../libs/runtime/README.md): why the engine is synchronous
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/specification)
