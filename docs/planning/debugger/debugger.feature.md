---
kind: feature
status: proposed
decided-by: []
title: TypeQLite Debugger
feature: debugger
branch: feat/debugger
depends-on: [editor]
---

# TypeQLite Debugger — Feature Doc

> **Status:** 📋 Proposed, not started · **Written:** 2026-11-12 · **Branch:** `feat/debugger`, from
> `main`, not yet cut · **Depends on:** [TypeQLite Editor](../editor/editor.feature.md) (complete) ·
> **Governed by:** ADR-009, which Phase 00 writes
>
> Request, 2026-11-12: *a debugger for TypeQLite, as a future feature. "I believe we should be able
> to use the Interpreter to make this possible."*
>
> **A feature, not an initiative.** It has one deliverable: a debug adapter, plus the runtime hook
> that feeds it. Its only dependency is the editor, which is already complete. The editor's feature
> document said an initiative would be needed if a surface that *runs queries* were planned
> ([Out of scope](../editor/editor.feature.md#out-of-scope)). A debugger does run queries, but it
> needs no results grid and no live store browser. If that database IDE is taken on alongside this
> feature, both share the question of where the runtime executes, and that is the point to write
> an initiative over both. That database IDE is now proposed as the
> [Graph Explorer](../graph-explorer/graph-explorer.feature.md), which sets out the work the two
> features share.

## Process

Per the [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md).
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
zero. The same applies to writes: see the rows an `insert` or `delete` will run over, one row at a
time, before anything is committed.

## Why the interpreter makes this possible

You are right that the interpreter can carry this. Verified on disk on 2026-11-12:

1. **It already runs in discrete steps, with rows passed between them.**
   [`runStages`](../../../libs/runtime/src/interpreter.ts) is one loop over a pipeline's stages.
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
7. **Writes can be undone.** `beginTransaction` and `rollbackTransaction` exist, so a debug
   session can run writes and then discard them.

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
one. Phase 00 settles this in ADR-009.

## What already exists — verified on disk 2026-11-12

This is load-bearing. Check it again before relying on it.

| Thing | State |
| ----- | ----- |
| Interpreter | [`interpreter.ts`](../../../libs/runtime/src/interpreter.ts), 6,060 lines, holding `TypeDBLiteInterpreter`. Its public entry points are `define(text)`, `execute(text, given?)` and `query(text, given?)`, plus `beginTransaction`, `commitTransaction` and `rollbackTransaction` |
| Stage loop | `runStages(pipeline, scopes, start)` has one `switch` per stage type: match, insert, put, delete, update, select, sort, offset, limit, distinct, require and reduce. The rows array is replaced after each stage |
| Stage plan | `planStages` returns one `StreamScope` per stage boundary, giving the variables `available`, their `kinds` and their `valueTypes`. **That is the static half of the Variables view**: what each variable is, as well as its value |
| Steps inside a `match` | `combinations()` and its `note()` calls, at lines 3811–3968 |
| Trace precedent | `QueryTrace` and `lastQueryTrace()`, enabled by the `trace` option or `TYPEDBLITE_TRACE=1`, and tested in [`query-trace.test.ts`](../../../libs/runtime/test/query-trace.test.ts) |
| Differential precedent | [`relation-join-planning-differential.test.ts`](../../../libs/runtime/test/relation-join-planning-differential.test.ts) runs `planJoins: false` and `planJoins: true` and asserts that the two produce the same rows in the same order. **This is the shape of test that proves the debug hook changes nothing** |
| Execution facts | [`diagnostics.ts`](../../../libs/runtime/src/diagnostics.ts) (ADR-004): facts are returned, never emitted, have stable codes, and are capped at `MAX_DIAGNOSTICS = 50` |
| Statement classification | [`apps/cli/src/session.ts`](../../../apps/cli/src/session.ts) chooses between `define`, `query` and `execute` by the statement's leading keyword, and whether it has a write stage. This is textual, and deliberately so. **This logic lives in the CLI, so a debugger cannot reuse it yet** |
| SQLite | Only [`node-sqlite.ts`](../../../libs/runtime/src/node-sqlite.ts) imports `node:sqlite`. The workspace's Node is ≥ 22.12. Whether the extension host's Electron Node includes `node:sqlite` is **not verified** |
| Extension | [`apps/vscode`](../../../apps/vscode) depends on `@typedblite/language` only. It contributes no `debuggers` and no `breakpoints`, and its language server never loads the runtime |

## 🔴 The invariants every phase is bound by

**1. Debugging never changes an answer.** The same statement against the same store returns the
same rows in the same order, with the same facts and the same refusals, whether the hook is on or
off. This is proven two ways: by a differential test in the shape of the join-planning one, and by
**the conformance run with the hook switched on**, which must match the run with it off at **1742
of 1756** ([ADR-005](../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).

**2. When the hook is off, it costs nothing.** Every hook point is one `undefined` check, as with
`QueryTrace`. The replication and oracle suites run thousands of queries each. Making them pay
for a feature they do not use has hung them before: see the comment on the empty-projection
diagnosis in `runQuery`.

**3. The runtime knows nothing of the Debug Adapter Protocol.** The hook is a plain TypeScript
interface that receives plain data: a step kind, a range, the rows, and the scope. The runtime
does not depend on `@vscode/debugadapter` and does not know about stack frames. This follows
ADR-004's rule ("returned, never emitted") and keeps the runtime usable wherever it is used now.
That includes downstream-app, which loads the runtime's `out/` folder.

**4. Writes are discarded unless the user asks to keep them.** A debug session runs inside a
transaction and rolls it back at the end. Committing is an explicit launch setting. A debugger
that silently writes to a real store is a hazard, not a feature.

**5. A recording is bounded.** A single `match` has produced more than 200,000 combinations
before (the Skills-catalog defect `QueryTrace` was built for). The step counts are always
recorded. The rows are recorded up to a cap per step, and when rows are dropped the recording
says how many, just as `MAX_DIAGNOSTICS` does.

**6. There is no second parser and no second classifier.** The debugger runs statements through
the interpreter's own entry points. If it needs the CLI's choice between define, read and write,
that logic moves somewhere both can import. It is not copied.

## What a TypeQLite debug session looks like

How DAP's concepts map onto TypeQLite. Phase 00 confirms or changes this table.

| DAP | TypeQLite |
| --- | --------- |
| Program | A `.tql` or `.typeqlite` file, run from top to bottom: `define` blocks, then write pipelines, then reads |
| Thread | One. The interpreter is single-threaded |
| Stack frames | Statement › stage › step inside the `match`. A function call or a `fetch` sub-query pushes a frame and runs its own stages |
| Step over | The next stage, or the next statement when on a statement |
| Step into | Into a `match`, one constraint at a time. Into a function body. Into a fetch sub-query |
| Step out | Back to the enclosing stage or statement |
| Step back / reverse continue | From the recording (approach A) |
| Variables | **Rows**: the current row set, paged, where each row expands to its bindings and each concept to its type, iid and attributes. **Scope**: the `StreamScope` at this boundary, giving each variable's kind and value type. **Written**: things, attributes and roles written so far |
| Line breakpoints | On a stage or a pattern, matched by range |
| Conditional breakpoints | On the row count, for example `rows == 0` |
| Exception breakpoints | *On refusal* (with its `DiagnosticCode`), and *when a stage empties* |
| Debug console | Execution facts as output, as they are recorded. Evaluating expressions is a later phase |
| Run Without Debugging | Free with DAP's `noDebug`: the file runs and its facts and rows go to the console |

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
5. **Writes are safe by default:** rolled back unless the launch configuration says otherwise
   (invariant 4).
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
- [ ] A query whose rows disappear at the third pattern of its `match` stops there under "break
      when a stage empties". Asserted in the adapter specs **and** in the e2e.
- [ ] A write pipeline run under the debugger leaves the store unchanged unless `commit: true`.
- [ ] The e2e starts a session with `vscode.debug.startDebugging` on a fixture file, hits a
      breakpoint, reads the variables, steps, and the session ends cleanly.
- [ ] `AGENTS.md`'s layout and dependency graph, the README, and the project overview memory name
      the debugger.
- [ ] Build, typecheck and test are green for everything touched, from a clean tree.

## Out of scope

- **A results grid, a live schema browser, or a graph view.** That is the database IDE that the
  editor feature also left out.
- **Debugging against downstream-app's store.** That store lives in its own app. Attaching to it is
  downstream-app's work, built on this feature's adapter.
- **Changing a variable's value mid-run** (DAP `setVariable`). Under approach A it is impossible;
  under B it raises the question of what a changed binding means for the rows already produced.
- **Data breakpoints**, for example "break when this attribute is written".
- **Debugging the SQL.** The debugger works at the level of TypeQLite steps. `QueryTrace` already
  counts statements for anyone working on performance.

## Open questions for Phase 00

These are for the founder.

1. **Execution model:** A (record, then replay), B (a worker that blocks), or A now and B later.
   The recommendation is A, then B if a real case needs it.
2. **Which database a launch runs against:** a fresh in-memory store with the workspace schema
   applied (the editor's one-schema rule, ADR-008 D3), a file named in `launch.json`, or both.
3. **Where the adapter runs:** in-process in the extension host (which needs `node:sqlite` in
   Electron's Node, not yet verified), or as a separate Node process (`DebugAdapterExecutable`),
   which needs a `node` on the user's PATH.
4. **Where the adapter lives:** a new `libs/debugger` that `apps/vscode` bundles, or inside
   `apps/vscode`. A library can be tested without VS Code and reused by downstream-app.
5. **Is the hook public API of `@typedblite/runtime`?** downstream-app loads the runtime's `out/`
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
| 00 | Scope, the DAP mapping, and ADR-009 | Not started | |
| 01 | The step hook: events, the recording, the cap, and proof that it is harmless | Not started | |
| 02 | Adapter shell: launch a file, statement-level steps, output, Run Without Debugging | Not started | |
| 03 | Stages and rows: stage steps, the Rows and Scope variables, line breakpoints | Not started | |
| 04 | Inside a `match`: constraint steps, function and fetch frames, `or`/`not`/`try` | Not started | |
| 05 | Breakpoints that answer "where did my rows go?": conditions, empty stage, refusal, step back | Not started | |
| 06 | The editor: the debug type, launch snippets, breakpoints in `.tql`, e2e, packaging | Not started | |

## Phase Intent

This is a forward plan. Each phase's checklist is written when that phase starts.

**00 — Scope, the DAP mapping, and ADR-009.** Answer the open questions. Fix the mapping table.
Settle the execution model, where the adapter runs and where it lives. Choose the debug-adapter
library and its version, and decide whether there is upstream code to diff against, as ADR-008 D8
did for the editor.

**01 — The step hook.** 🔴 This is the only phase that touches the interpreter, and the only one in
which invariants 1 and 2 can break. Add the hook interface. Call it at stage boundaries, at
`combinations()`'s existing `note()` points, and around `callFunction` and fetch sub-queries. Add a
recorder that implements it, with the cap. Exit: the differential spec, conformance with the hook
on, and the performance suites unchanged with it off.

**02 — Adapter shell.** A DAP session that launches a file, splits it into statements, and runs
each through the interpreter: define, read or write, using classification shared with the CLI
(invariant 6). It stops on entry and steps over statements. Facts go to the console. Run Without
Debugging works. Writes run in a transaction that is rolled back.

**03 — Stages and rows.** Steps at stage boundaries. The Rows variables, paged, with concepts
expanded through `attributesOf` and `typeOfThing`. The Scope variables from `StreamScope`. Line
breakpoints matched to stages by range.

**04 — Inside a `match`.** Step into a `match`, one constraint at a time, with the combination
count at each step. Nested `or`, `not` and `try` blocks. A function call or a fetch sub-query
pushes a frame.

**05 — Breakpoints that matter.** Conditional breakpoints on the row count. Exception breakpoints
for a stage that empties and for a refusal, carrying its code. Step back and reverse continue, if
Phase 00 chose approach A.

**06 — The editor.** `apps/vscode` contributes the `typeqlite` debug type, its launch snippets,
and breakpoints in TypeQLite files. The adapter is bundled into the `.vsix`. The e2e drives a
session through `vscode.debug.startDebugging`.

## Deferred

Anything a phase defers is recorded here, not only in a commit message.

- *(none yet)*

## Key Documents

- [TypeQLite Editor](../editor/editor.feature.md), the feature this one builds on, and
  [ADR-008](../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
- [ADR-004](../../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md):
  facts are returned, never emitted. The hook follows the same rule
- [ADR-005](../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md):
  the conformance pass count may never go down. It is this feature's regression oracle, with the
  hook on
- [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md)
- [`libs/runtime/README.md`](../../../libs/runtime/README.md): why the engine is synchronous
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/specification)
