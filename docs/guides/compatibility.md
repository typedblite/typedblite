# Versions and compatibility

What a TypeDBLite version number promises: which changes can break your code or your data, and where
to read about them before you upgrade.

> **Status: proposed, not yet published.** No version of TypeDBLite is on npm yet. This policy takes effect
> with the first release, `0.1.0`.

## The packages are versioned together

`@typedblite/runtime`, `@typedblite/language`, `@typedblite/content-revision` and the `typedblite` CLI are
released together, at one version number, and each depends on the others at exactly that version. Install
them at the same version. The VS Code extension is versioned separately, on its own marketplace.

## Semantic Versioning, before and after 1.0

TypeDBLite follows [Semantic Versioning](https://semver.org).

**Before 1.0** (`0.y.z`, where TypeDBLite is now):

- A **minor** version (`0.1.0` → `0.2.0`) **may break** things: the API, the language, or what a store
  accepts. Every breaking change is listed, under **Changed** and marked **Breaking**, in
  [CHANGELOG.md](../../CHANGELOG.md), with what to do about it.
- A **patch** version (`0.1.0` → `0.1.1`) does not break. It fixes bugs and adds things without
  changing what already works.
- So `~0.1.0` is a safe range, and `^0.1.0` is too, because npm treats a `0.y` caret range as `~`.

**From 1.0:** a breaking change needs a new major version.

A **prerelease** (`0.1.0-rc.1`) is published under npm's `next` tag, so `npm install @typedblite/runtime`
never installs one by accident. Ask for it by version, or by `@next`.

## What counts as a breaking change

These are the public surface. Changing them in a way that can stop working code from working is breaking:

| Surface | What is covered |
| --- | --- |
| **The API** | What the packages' entry points export (`@typedblite/runtime`, `@typedblite/runtime/wasm`, `@typedblite/language`, `@typedblite/content-revision`), and its TypeScript types: the API reference (`npm run docs:api`). A file that is not an entry point is not public, even though it is in the package: package.json `exports` blocks importing it |
| **The language** | A TypeQLite statement that runs in one version runs in the next, with the same meaning. Rejecting a statement that was accepted is breaking, unless it was accepted by mistake: then it is a fix, and the changelog says so |
| **Diagnostic codes** | The `DiagnosticCode` values, and which condition each one names ([ADR-004](../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md)). A new code is not breaking. Renaming or reusing one is. The wording of a message is not covered |
| **Stores** | A store written by one version opens in every later version: see [Stores and upgrades](#stores-and-upgrades) |
| **Revisions** | A revision identifier is derived from content. The same content gives the same revision in every version, so stores on different versions converge rather than conflict. Changing that is breaking, and needs an amendment to [ADR-003](../architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md) |
| **The CLI's flags** | `--repl`, `--file`, `--exec`, `--database` and `--help`, and their meaning |
| **Requirements** | Raising the minimum Node.js version, or narrowing the supported SQLite WASM versions, is breaking |

These are **not** covered and may change in any release:

- The CLI's output. It is written for people to read. Don't parse it: embed the runtime instead.
- The SQL that a query is translated to, and the query plan. Only the answers are covered.
- Performance, except a regression large enough to be a bug.
- The wording of error messages. Use the diagnostic code.
- An export or member whose documentation marks it `@internal`. These are public in JavaScript only so the
  engine's own modules, or this repository's conformance suite, can reach them: `attachDiagnostic`,
  `canonicalTemporal`, `instantOf`, and three methods of `TypeDBLiteInterpreter`. They are left out of the API
  reference. An `@experimental` mark, which nothing has yet, would let an export ship before its shape is
  settled.
- Anything in the repository that is not published: the conformance suite, the demos and the playground.

## Stores and upgrades

A store is the SQLite file TypeDBLite writes. Its tables are generated, never written by hand, and the
rules for changing them are in [AGENTS.md](../../AGENTS.md#schema-and-data):

- **A newer version opens an older store.** When it needs a new table, column or index, it adds it when
  the store is opened. An existing table's shape is never changed in place.
- **When a store's layout must change, opening it migrates it**, once, in one transaction. The move to one
  row per attribute ([ADR-006](../architecture/adr-006-an-attribute-is-stored-once-per-type-and-value.md))
  is the example.
- ⚠️ **A migration is one way.** After a newer version has opened a store, an older version may not be
  able to read it. **Back up a store before you upgrade**, if you might go back. Every release that
  migrates stores says so in the changelog.
- A store written by a newer version is not guaranteed to open in an older one.

## Replication between versions

A hub and its spokes exchange change records over HTTP ([Replication and
search](replication-and-search.md)). Before 1.0, that exchange has no version negotiation. **Run the same
minor version on a hub and every spoke.** A patch release does not change the exchange. A minor release that
changes it says so in the changelog.

## Requirements

- **Node.js 22.16 or later**, the `engines` range of every package. See [Known
  limitations](known-limitations.md#platforms-and-requirements) for why. Raising it is breaking.
- **SQLite WASM**, for the browser build, is an optional peer dependency: `@sqlite.org/sqlite-wasm`. Its
  range names only the SQLite versions TypeDBLite has been tested with. Today that is any build of 3.54.1:
  `>=3.54.1-build1 <3.54.2`. Every version of that package has a `-buildN` suffix, which semver treats as a
  prerelease, so a range such as `^3.54.0` matches none of them. Widening the range to a newly tested
  version is a patch release.

## Deprecation

Before something public is removed, a release marks it deprecated, in its documentation and in the
changelog, and names what replaces it. Before 1.0, the removal can come in the next minor version.
