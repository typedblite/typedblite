# Known limitations and what is open

What TypeDBLite does not do, or does differently from TypeDB, and what is still open. Each item says where
it comes from. This page is a list of known gaps, **not a roadmap with dates**: nothing here is promised
for a release.

- [What it is, and is not](#what-it-is-and-is-not)
- [The language](#the-language)
- [Compatibility with TypeDB](#compatibility-with-typedb)
- [Performance and scale](#performance-and-scale)
- [Replication and the hub](#replication-and-the-hub)
- [Platforms and requirements](#platforms-and-requirements)
- [What is open](#what-is-open)

## What it is, and is not

TypeDBLite is an **embedded library**: a TypeScript implementation of TypeDB's data model and query
language, over SQLite, that runs inside your process. It is not a server, and it is not TypeDB. It is
an independent project, not affiliated with or endorsed by TypeDB Ltd. It speaks **TypeQLite**, a dialect
of TypeQL 3.x, and the [language guide](typeqlite-language.md) says what that dialect covers.

## The language

A construct TypeQLite does not support is refused by name (`typedblite.not-implemented`, or a parse error).
It is never silently skipped. From the [language guide](typeqlite-language.md#what-typeqlite-does-not-do-yet):

- **A function that returns things.** A function can return values and attributes, but not entities,
  relations or types.
- **Writing list values.** `owns tag[]` can be declared, but `has tag[] [ … ]` cannot be written.
- **Value-type conversion functions**, such as `double($a)`.
- **`let … in`** over anything but a function call.
- **`return check`**, and a `reduce` after a write stage.
- **Several reads in one `query()` call.** Run each separately.
- **Rules and inference.** TypeDB 3 removed them in favour of functions, and TypeDBLite follows.

### Annotations

Some annotations are accepted and **not enforced** on writes. An unenforced one never fails silently:
`define` may report it with a `typedblite.annotation-not-enforced` fact.

| Annotation | In TypeDBLite |
| --- | --- |
| `@key`, `@unique`, `@abstract`, `@regex` | Enforced |
| `@independent` | Honoured |
| `@doc` | Retained |
| `@card(min..max)` | **Partly.** It decides whether `fetch` returns a value or a list, and whether `update` may replace one. Bounds other than a key's are **not** enforced on writes |
| `@range`, `@values` | Arguments checked against the value type at `define`. **Not** enforced on writes |
| `@distinct`, `@cascade`, `@meta` | Parsed and accepted. **Not** enforced |

## Compatibility with TypeDB

Measured against TypeDB's own behaviour specification (cited run: 2026-11-12, spec pin
`typedb/typedb-behaviour@7d35851`, surveyed against TypeDB 3.10.4):

- **1,742 of 1,756 scenarios pass (99.2%).** 12 are deviations, scenarios that TypeDB 3.10.4 fails too,
  each owned by [ADR-007](../architecture/adr-007-a-scenario-typedb-itself-fails-is-a-deviation.md). 1 fails,
  and 1 is not applicable.
- **The one failure** is `update` L959. TypeDB treats an `owns` with no `@card` as `@card(0..1)` and
  enforces it at commit. TypeDBLite does not enforce that default, so a thing can hold several values
  where TypeDB would refuse the commit. This is **a product decision that is still open**: a
  consumer's stores rely on the current behaviour, and enforcing the default would refuse writes to things
  that already hold several values. See [CONFORMANCE.md](../../CONFORMANCE.md#the-one-failure) for the two
  ways forward.
- **The spec covers queries and schema (`query/language`).** The numbers say how closely TypeDBLite matches
  TypeDB on that. They say nothing about parts of TypeDB the spec does not cover, such as TypeDB's server and its drivers.

The full list, with the reason for each non-passing scenario, is in [CONFORMANCE.md](../../CONFORMANCE.md).

## Performance and scale

From the [load test](../development/performance.md#still-open), run on real stores of 2,390 to 46,690 things:

- **One writer at a time.** SQLite allows one writer, so write throughput does not grow with more processes.
  With four writers the 99th-percentile wait for the lock was 1.8 s, and 2.5 s with four readers alongside,
  under the 5 s `busy_timeout` but not far under it.
- **The planner has no cost model.** Thing variables are enumerated in the order they are written, and a
  variable no relation or literal reaches is enumerated whole.
- **Read paths run one SQL statement per row per binding.** A statement is cheap, but the count adds up.
- **The empty-answer count visits the whole type**, so it is linear in the type's size.
- **No change-log retention policy.** A consumer that rewrites large values grows the log without bound
  unless it calls `changeLog.compact()` and `vacuum()`. In one real store that took 967 MB down to 81 MB.

## Replication and the hub

- **The hub trusts everything that can reach it.** The change-stream handler has no authentication and no
  encryption, so you mount it behind your own, and it stores a pushed revision as given: a peer can claim
  any revision, and a live one with a high generation wins a conflict. It refuses non-JSON bodies, bodies
  over `maxBodyBytes`, and streams over `maxStreams`, applies a batch all or none, and does not echo internal
  errors. The [replication guide's Security section](replication-and-search.md#security) lists each case as
  verified and shows an authenticated mount. `serveChangeStream` binds `127.0.0.1` only.
- **Conflicts are kept, not resolved.** Different edits to the same thing are all kept, with a
  deterministic winner. Which losing revision matters is your application's decision.
- **Offline-first apps must treat a failed sync as offline.** A sync that did not happen fails; it never
  reports success.

## Platforms and requirements

- **Node.js 22.16 or later.** Node 22.12 has no `node:sqlite`, and 22.13 to 22.15 ship it without
  full-text search (FTS5), which the engine requires.
- **`node:sqlite` is still marked experimental by Node.** It prints an `ExperimentalWarning` the first time
  it is used.
- **In a browser,** TypeDBLite runs on a synchronous WASM SQLite inside a Web Worker
  ([ADR-009](../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md)). It is slower than
  `node:sqlite`.
- **Linux, macOS and Windows.** The test gate has passed on all three. GitHub Actions is currently off, so
  nothing re-checks that on every change; run `npm run gate` yourself.
- **The VS Code extension** is built from source and is not yet on a marketplace. In a remote window (WSL,
  SSH, a container), colouring Markdown previews in your theme needs the optional TypeQLite Theme Bridge,
  installed in your local VS Code.

## What is open

These are open in the repository's own records, in no order of priority:

- Whether to enforce TypeDB's default `@card(0..1)` (the one failing scenario above).
- Enforcing `@card` bounds, `@range`, `@values`, `@distinct` and `@cascade` on writes.
- Checking a pushed revision against its content, so a peer cannot forge one (needs its own tests and an
  amendment to ADR-003).
- A cost model for the query planner, and fewer SQL round trips per row.
- A change-log retention policy.
- The unsupported constructs listed under [The language](#the-language).

A `good first issue` is a good way in. The 14 non-passing conformance scenarios, and small constructs with a
real caller, are the natural source. See [CONTRIBUTING](../../CONTRIBUTING.md).
