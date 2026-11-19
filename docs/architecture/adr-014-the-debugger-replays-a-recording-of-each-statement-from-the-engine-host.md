---
kind: adr
status: accepted
date: 2026-11-19
decision-owners: [Founder, TypeDBLite maintainers]
extends: [adr-004, adr-011]
---

# ADR-014: The TypeQLite debugger replays a recording of each statement, made on the engine host

- **Status:** Accepted on 2026-11-19. The founder accepted the eleven recommendations below as written.
- **Date:** 2026-11-19
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-004](adr-004-typedblite-execution-diagnostics-as-a-returned-report.md) (the recording is
  returned, never emitted) and [ADR-011](adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md)
  (this answers its D7: how the debugger reaches the step hook).
- **Feature:** [TypeQLite Debugger](../planning/workbench/debugger/debugger.feature.md). The feature document
  names "ADR-009" for itself; that number was taken by the WASM decision, so this is ADR-014.

The decisions are numbered **B1–B11** so they cannot be confused with ADR-011's D1–D10, which this ADR cites.

---

## Context

The feature document was written on 2026-11-12, before the engine host and the notebook existed. It leaves five
questions open and recommends recording a statement and replaying it (approach A) over a worker that blocks
(approach B). The interpreter cannot pause: it is synchronous all the way down to `node:sqlite`.

Measured on 2026-11-19, before deciding:

| Fact | Consequence |
| ---- | ----------- |
| [`runStages`](../../libs/runtime/src/interpreter.ts) replaces a whole array of rows after each stage | Every intermediate result already exists. A stage boundary is a stop, and its rows are the Variables view |
| 🔴 [`combinations()`](../../libs/runtime/src/interpreter.ts) does **not** run a `match`'s patterns in source order. It runs them by kind: type variables, then one step per thing **variable** (merging every pattern on it, with relation filters pushed down when `planJoins` is on), then relation bindings, attribute reads, `let`s and comparisons whose inputs are ready, `or` and `try`, the remaining `let`s and comparisons, and finally `is` and `not` | Stepping through a `match` cannot follow the source. One step can consume patterns on several lines, and a later line can run first |
| `ThingConstraint.range` holds the range of the **first** pattern that introduced the constraint | A step must carry every range it consumes, not one |
| `note()` marks the steps `types`, `thing $x`, `relation $r early filter`, `relation $r bind`, `attribute $a`, `disjunction`, `optional` and `negation`. **Nothing** marks reading `has name $n`, a `let`, a comparison, or `is` | A comparison such as `$age > 30` is one of the likeliest places for rows to disappear, and today it has no step |
| [`applyValueStatements`](../../libs/runtime/src/expressions.ts) evaluates comparisons one combination at a time and stops at the first that fails | Each dropped combination can be charged to the comparison that dropped it, **without changing the evaluation order** |
| `combinations()` runs **once per incoming row**; a `fetch` sub-query runs once per parent answer, and a function once per call | A second `match` after 500 rows runs each of its steps 500 times |
| A row binds a thing by iid, a type by label, a value inline. A thing's type and attributes are read from the store **when asked** (`typeOfThing`, `readAttributes`) | Read during replay, they would show the store as it is **after** the statement, not as it was at the stop. A write pipeline's early stop would show attributes written later |
| The engine host is built (ADR-011): sessions, `session.run` of exactly one statement (D6), `statement.split`, `statement.classify`, and a `HostClient` in the extension | The classifier the feature's invariant 6 needed now lives in `@typedblite/session`, shared by the CLI, the host and the playground |
| The initiative's rule: **a consumer never reaches around the host** | The debugger runs statements through the host or not at all |
| `node:sqlite` is present in VS Code 1.146's Electron Node (measured in the engine-host feature) | No longer a blocker for anything, but with B2 the adapter does not need it |
| Node 24.19 has `backup()`, `serialize()` and `deserialize()`. `serialize` and `deserialize` landed in Node in April 2026, so the workspace's minimum, 22.16, lacks them. `backup()` writes to a path, not into memory | Copying an existing store into memory is not available everywhere, and it would open an existing database (invariant 4) |
| `@vscode/debugadapter`, `@vscode/debugprotocol` and `@vscode/debugadapter-testsupport` are at **1.68.0** (2026-06-26), MIT | A maintained library and a protocol test client exist |
| TypeDB has no step debugger. Its [debugging guide](https://typedb.com/docs/guides/typeql/debugging-typeql/index.md) recommends commenting out half the constraints and running pipeline prefixes, with `reduce $count = count;` to count | There is no upstream code to diff against (unlike ADR-008 D8). The guide is the manual version of this feature's main question |

## Decision

**B1. Record, then replay, one statement at a time.** The adapter runs one statement with the recorder on, serves
every stop inside it from the recording, and runs the next statement only when the user steps past the last stop or
continues. Recordings already made are kept, so **step back** and **reverse continue** reach back into earlier
statements (DAP `supportsStepBack`). The hook is a plain callback that returns nothing, so a blocking worker
(approach B) can implement it later without changing it. Cost: the debug console cannot query the store as it was
at a stop. Rejected: approach B now (live, but harder to test, and nothing yet needs it); rewriting the interpreter
as generators (approach C, rejected by the feature document).

**B2. The recording is made on the engine host, by a new operation, `session.debug`.** It runs exactly one
statement, as `session.run` does (ADR-011 D6), with the recorder on, and returns the outcome together with the
recording. 🔴 **The host refuses `session.debug` on any session whose location is not `:memory:`**, so the feature's
invariant 4 is enforced where the store is opened, not only in the adapter. It is a command and **not an MCP
tool** (ADR-011 D8). Rejected: the adapter loading `@typedblite/runtime` itself, which ADR-011 D7 allowed. That
would be a second place where a statement's meaning is decided, which the initiative forbids.

**B3. The adapter runs inline in the extension host** (`vscode.DebugAdapterInlineImplementation`) and reaches the
engine through the extension's existing `HostClient`. It needs no `node:sqlite` and no process of its own.
Rejected: `DebugAdapterExecutable`, a second process that would need a second host connection.

**B4. The adapter lives in `libs/debugger` (`@typedblite/debugger`, private).** It speaks DAP through
`@vscode/debugadapter` and reaches the host through a narrow interface it declares itself, as
[`libs/notebook/src/host-types.ts`](../../libs/notebook/src/host-types.ts) does. It declares the recording's wire
shape too, so it does **not** depend on `@typedblite/runtime`. It is tested in plain Node, without VS Code, and
`apps/vscode` bundles it. The dependency graph gains `vscode -> debugger`.

**B5. The hook is not public API of `@typedblite/runtime`.** It is exported from a subpath,
`@typedblite/runtime/debug`, never from the package root, and is documented there as internal and unstable.
`@typedblite/session` gains a way to run one statement with a recorder, which the host's `session.debug` calls.
This is reviewed when the feature completes, in the same way as ADR-011 D9. Rejected: an option on the
interpreter's public options type, which would put it in the root's types, where a downstream application can
depend on it.

**B6. A step inside a `match` is one of the interpreter's own steps, in the order they run, not a source
pattern.** Each step is named (`types`, `thing $p`, `relation $r filter`, `relation $r bind`, `has $p → $n`,
`attribute $n`, `let $x`, `$age > 30`, `or`, `try`, `is`, `not`) and carries **every** range it consumes. A line
breakpoint inside a `match` is verified on each step that consumes a pattern on that line, and a line no step
consumes is shown unverified. A stop highlights all of its ranges. Phase 01 adds hook points where `note()` has none:
attribute reads, `let`s, each comparison (charging each dropped combination to the first comparison it failed),
and `is`. **Step order follows `planJoins`.** The recording shows whichever order ran, and the differential spec runs
with it on and off.

**B7. Steps that repeat for each incoming row are shown once, with totals.** A `match` step's stop shows the rows
that came in and the rows that survived, summed over every incoming row. The breakdown by incoming row is a variable
below it. A `fetch` sub-query and a function call are shown in the same way, as one frame per call site, with each
call reachable as a variable. This is the order a person asks "where did my rows go?" in, not the order the
interpreter ran. A recording can be presented in either order, which is one reason B1 fits. Rejected: one stop per
incoming row, which is faithful but buries a 500-row `match` under 500 copies of each step.

**B8. A thing is described when it is recorded.** For each row the recording keeps (B10), the recorder stores
each thing's type and attributes **as they are at that step**. It keeps them per iid and invalidates them after each
write stage, so a read pipeline reads each concept once. Step back (B1) therefore shows what was true at that point.
These reads happen only while the hook is on (invariant 2), are reads (invariant 1, checked by the differential
spec), and are counted against the cap. Rejected: describing at replay time and labelling it "as of the end of the
statement", which is cheaper but wrong for write pipelines.

**B9. Data gets in through files the launch configuration names.** A `typeqlite` launch has `program`,
`schema: string[]` and `seed: string[]`. The adapter opens a `:memory:` session, runs each schema file and then each
seed file in the order given, and then the program, whose own `define`s run like any other statement. **There is
no implicit "workspace schema."** The language server's index has no order, and ADR-012 N4 found its scope too wide
for one notebook. **Copying an existing store into memory is deferred:** `deserialize` is absent at the 22.16
minimum, `backup()` writes to a path, and either one opens an existing database, which invariant 4 rules out.
This changes the feature document, which planned to load "the workspace schema (ADR-008 D3)".

**B10. The recording is bounded twice.** Counts are always recorded. Rows are recorded up to a cap per step, and
calls up to a cap per call site. When rows or calls are dropped, the recording says how many, in the same way as
`MAX_DIAGNOSTICS`. The whole recording also has a byte ceiling, because it crosses the sidecar as one JSON line. The
provisional numbers are **1,000 rows per step, 50 calls per call site, 16 MB per statement**. Phase 01 sets the
final numbers by measuring recordings of the benchmark queries and the try-it notebook.

**B11. The DAP mapping, with the library pinned.** `@vscode/debugadapter` and `@vscode/debugprotocol` 1.68.0;
`@vscode/debugadapter-testsupport` 1.68.0 for the adapter specs. The feature document's mapping table becomes:

| DAP | TypeQLite |
| --- | --------- |
| Program | `program`, run statement by statement after `schema` and `seed` (B9), in a fresh `:memory:` session |
| Thread | One |
| Stack frames | Statement › stage › `match` step. A function call site or a `fetch` sub-query pushes a frame (B7) |
| Step over | The next stage, or the next statement |
| Step into | Into a `match`, one step at a time in execution order (B6); into a function or a `fetch` sub-query |
| Step out | To the enclosing stage or statement |
| Step back, reverse continue | Over every statement recorded so far (B1) |
| Variables | **Rows** (paged; each row's bindings; each thing's type, iid and attributes **as at the step**, B8). **Scope** (`StreamScope`: kinds and value types). **By incoming row** (B7). **Dropped** (rows the cap left out, B10) |
| Line breakpoints | On a stage, or on each `match` step that consumes the line (B6) |
| Conditional breakpoints | On the step's row counts: `rowsIn`, `rowsOut` |
| Exception breakpoints | *On refusal*, carrying its `DiagnosticCode`; *when a step empties* (`rowsIn > 0 && rowsOut == 0`) |
| Debug console | Execution facts, in order. Evaluating expressions is out of scope (B1) |
| Run Without Debugging | `noDebug`: each statement goes through `session.run`, not `session.debug` |

## Consequences

- The runtime gains a subpath export and hook points, and nothing else visible. Phase 01 is still the only phase
  that touches the interpreter, and must prove invariants 1 and 2 before anything uses the hook.
- `@typedblite/session` and the engine host each gain one entry point (B2, B5).
- A new library, `libs/debugger`, and a new edge, `vscode -> debugger`.
- `AGENTS.md`'s layout and dependency graph change when Phase 02 creates the library.
- Stepping inside a `match` will surprise anyone who expects source order. The stop's name and its highlighted
  ranges have to explain it, and the e2e must show both.
- A debug session can never see a real store's data until copying into memory is decided (B9).

## Not decided here

- The final cap numbers (B10). Phase 01 measures them.
- Whether `session.debug` streams a recording in parts instead of returning it whole. That decision waits until
  Phase 01's measurements show whether one JSON line is too large.
- Evaluating expressions in the debug console, which needs approach B.
