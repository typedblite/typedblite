<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/typedblite-logo-dark.svg">
    <img alt="TypeDBLite" src="docs/brand/typedblite-logo.svg" width="360">
  </picture>
</p>

# TypeDBLite

## Special Thanks to TypeDB!

**TypeDBLite exists because of [TypeDB](https://typedb.com).** The data model, the query language and
the behaviour that TypeDBLite implements are the work of [TypeDB Ltd](https://typedb.com) and the
TypeDB community.

Thank you to the team at TypeDB Ltd for an amazing product suite and ecosystem:
- a database whose type system makes modelling a domain a pleasure;
- a query language that reads like the domain it describes;
- tooling such as TypeDB Studio;
- and the generosity of publishing it all as open source.

**A special thank-you for the [TypeDB Behaviour Specification](https://github.com/typedb/typedb-behaviour).**
Its Cucumber scenarios are an executable definition of how TypeDB behaves. TypeDBLite runs 1,756 of
them as its conformance suite, and is built and tested against them. Without that suite, this project
could not say how closely it matches TypeDB, and could not have got as close as it has.

| Created by TypeDB Ltd | What it is | Links | How TypeDBLite uses it |
|---|---|---|---|
| **TypeDB™** | The polymorphic database | [typedb.com](https://typedb.com) · [GitHub](https://github.com/typedb/typedb) | TypeDBLite reimplements its data model and behaviour in TypeScript, over SQLite |
| **TypeQL™** | TypeDB's query language | [Reference](https://typedb.com/docs/typeql-reference/) · [GitHub](https://github.com/typedb/typeql) | TypeQLite is a dialect of TypeQL 3.x, and follows its syntax |
| **TypeDB Studio** | TypeDB's IDE | [Docs](https://typedb.com/docs/tools/studio) · [GitHub](https://github.com/typedb/typedb-studio) | The model for TypeDBLite's proposed [graph explorer](docs/planning/graph-explorer/graph-explorer.feature.md) |
| **TypeDB Behaviour Specification** | TypeDB's Cucumber conformance suite | [GitHub](https://github.com/typedb/typedb-behaviour) | Vendored unmodified in [`libs/conformance/spec/`](libs/conformance/spec/) as TypeDBLite's [conformance oracle](CONFORMANCE.md) |

**Trademarks.** TypeDB™ and TypeQL™ are trademarks of TypeDB Ltd. TypeDB Studio is a product of
TypeDB Ltd. These names are used here only to identify TypeDB Ltd's products, and to describe what
TypeDBLite is compatible with.

**Copyright.** TypeDB, TypeQL, TypeDB Studio and the TypeDB Behaviour Specification are copyright
TypeDB Ltd and their contributors, and are published under the
[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/). The specification files in
[`libs/conformance/spec/`](libs/conformance/spec/) are TypeDB Ltd's work. They keep their original
licence headers and [`LICENSE`](libs/conformance/spec/LICENSE).

**Independence.** TypeDBLite is an independent open-source project. It is not affiliated with,
sponsored by, or endorsed by TypeDB Ltd. For TypeDB itself, visit [typedb.com](https://typedb.com).

## About

TypeDBLite is a TypeScript implementation of the [TypeDB](https://typedb.com) graph database engine backed by SQLite. It parses and executes **TypeQLite** — a dialect of TypeQL 3.x — and stores the result in a SQLite database that can be opened with `node:sqlite`, a WASM build in a browser, or any binding that satisfies the `SqliteDatabase` interface.

## Why

TypeDB's native server is a standalone Rust binary. TypeDBLite brings the same polymorphic type model, schema-first design, and TypeQL query language to contexts where spinning up a separate server is impractical: edge processes, embedded applications, local developer tooling, and browser workers.

**How close is it to TypeDB?** On TypeDB's own behaviour specification, TypeDBLite passes 1,742 of 1,756 scenarios. Of the 14 that do not pass, 12 also fail on TypeDB itself. See [CONFORMANCE.md](CONFORMANCE.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/guides/getting-started.md) | From a fresh clone to your first schema and queries, in the CLI and in code |
| [Embedding the runtime](docs/guides/embedding-the-runtime.md) | The engine API: results, transactions, diagnostics, options |
| [The TypeQLite language](docs/guides/typeqlite-language.md) | What you can write, and what is not supported yet |
| [Replication and search](docs/guides/replication-and-search.md) | The change log, syncing stores, full-text search |
| [Contributing](CONTRIBUTING.md) | Setup, workflow, and the checks a change must pass |
| [All documentation](docs/README.md) | Including architecture and testing |

## Packages

| Package | Description |
|---|---|
| [`@typedblite/language`](libs/language/) | Langium grammar, generated AST, and language services for TypeQLite. Parsing, validation, formatting, semantic tokens, and scope resolution live here. |
| [`@typedblite/runtime`](libs/runtime/) | The engine: query interpreter, storage, schema changes, change log, replication and full-text search. The working database lives here. |
| [`@typedblite/content-revision`](libs/content-revision/) | Canonical state encoding and CouchDB-style generation-digest revision identifiers (ADR-003). Shared by the runtime's change log and external content-versioning consumers. |
| [`typedblite-conformance`](libs/conformance/) | TypeDB's own behaviour specification vendored as Cucumber features and run against TypeDBLite as a report card. The spec lives under `spec/`; `deviations.yaml` declares intentional gaps. |
| [`typedblite-cli`](apps/cli/) | Interactive REPL, file runner (`--file`), and one-shot executor (`--exec`) for TypeQLite statements. |
| [`typedblite-sync-demo`](apps/sync-demo/) | Offline-first sync, shown end to end: a browser, a desktop app and an Android phone, each with its own TypeDBLite store, replicating through a TypeDBLite hub. Cut any link or stop the hub, and watch them converge. |
| [`typeqlite` (VS Code extension)](apps/vscode/) | The TypeQLite editor: diagnostics, cross-file navigation, hover, completion, rename, quick fixes, formatting and semantic highlighting, from a Langium language server that runs the language library unchanged (ADR-008). |

## Quick start

```
node >=22.12
```

```bash
npm install
npm run build
```

Run a TypeQLite statement against an in-memory database:

```bash
node apps/cli/out/main.js --exec 'define entity person, owns name; attribute name, value string;'
```

Start the interactive REPL:

```bash
node apps/cli/out/main.js --repl
```

Package and install the editor:

```bash
npm exec nx -- run typeqlite-vscode:package
code --install-extension apps/vscode/dist/typeqlite-0.0.1.vsix
```

Run a `.typeqlite` file against a file-backed database:

```bash
node apps/cli/out/main.js --file schema.typeqlite --database my.db
```

## TypeQLite language

TypeQLite 3.x implements the TypeQL subset that real production schemas and the TypeDB behaviour specification require. The grammar lives at [libs/language/src/typeqlite.langium](libs/language/src/typeqlite.langium).

### Schema DDL

```typeql
define
  entity person, owns name @key, plays employment:employee;
  entity company, owns name @key, plays employment:employer;
  relation employment, relates employee, relates employer;
  attribute name, value string;
```

```typeql
define attribute email, value string; person owns email @card(0..1);
redefine person owns email @card(0..3);
```

```typeql
undefine owns email from person;
```

### Data DML

```typeql
insert $p isa person, has name "Alice";
```

```typeql
match $p isa person, has name $n;
select $n;
```

```typeql
match $p isa person, has name "Alice";
delete $p;
```

### Value types

`string`, `integer`, `long`, `double`, `decimal`, `boolean`, `date`, `datetime`, `datetime-tz`, `duration`

### Annotations

| Annotation | Effect |
|---|---|
| `@key`, `@unique` | Enforced: one owner per value. A key must also be held exactly once |
| `@abstract` | Enforced: the type cannot have instances of its own |
| `@regex` | Enforced on every write |
| `@independent` | Honoured: the attribute survives without an owner |
| `@doc` | Retained, and readable with `get_doc(type)` |
| `@card(min..max)` | Shapes `fetch` and `update`; bounds other than a key's are not enforced on writes |
| `@range`, `@values`, `@distinct`, `@cascade`, `@meta` | Accepted; not enforced on writes |

Nothing is silently dropped: see [The TypeQLite language](docs/guides/typeqlite-language.md#annotations) for the measured detail.

## SQLite binding

The runtime depends on a `SqliteDatabase` interface rather than `node:sqlite` directly. `node-sqlite.ts` satisfies it for Node.js ≥ 22.12. A WASM SQLite binding running inside a Web Worker satisfies the same interface as long as it is synchronous within the worker. See [`libs/runtime/src/sqlite-database.ts`](libs/runtime/src/sqlite-database.ts) for the full contract.

## Replication

TypeDBLite includes a hub-and-spoke replication model (ADR-003):

- Every write appends to a **change log** (`ChangeLog`) with a CouchDB-style `generation-digest` revision (`@typedblite/content-revision`).
- The **hub** exposes a Server-Sent Events stream and a POST endpoint for incoming changes.
- **Spokes** subscribe and replicate bidirectionally or in one direction (`push` / `pull` / `duplex`).
- Identical edits applied independently on two nodes produce the same revision, so they converge without conflict.

See it working: the [sync demo](apps/sync-demo/) runs a browser, a desktop app and an Android phone against one hub (`npm exec nx -- run sync-demo:demo -- --fresh`). TypeDBLite runs in the browser on WASM SQLite through `@typedblite/runtime/wasm` ([ADR-009](docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md)).

## Conformance

The `typedblite-conformance` package vendors TypeDB's own behaviour specification and runs every Cucumber scenario against the TypeDBLite runtime. The result is a report card — passes, failures, and declared deviations.

```bash
nx run typedblite-conformance:test
```

Intentional gaps are declared in [`libs/conformance/deviations.yaml`](libs/conformance/deviations.yaml) with an owner (an ADR number or defect record). Undeclared failures are plain failures.

## Development

```bash
# Build all packages
npm run build

# Run all test suites
npm run test

# Type-check all packages
npm run typecheck

# Build or test a single project
npm exec nx -- run typedblite-runtime:build
npm exec nx -- run typedblite-runtime:test
```

Nx project names: `typeqlite-language`, `content-revision`, `typedblite-runtime`, `typedblite-conformance`, `typedblite` (the CLI), `typeqlite-vscode` and `sync-demo`. Set `CI=true` to collect coverage into `coverage/`. [Contributing](CONTRIBUTING.md) and [Testing](docs/development/testing.md) cover the rest.

## Test fixtures

Shared TypeQLite schemas used across multiple test suites live in [test-fixtures/schemas/](test-fixtures/schemas/). These are production-grade schemas exercising the full range of TypeQLite constructs: `@key`, relations with role players, multi-valued attributes, and complex match patterns.

## Architecture decisions

TypeDBLite-specific ADRs and standards live in [docs/](docs/):

| ADR | Title |
|---|---|
| [ADR-001](docs/architecture/adr-001-typedb-for-graph-persistence.md) | TypeDB for Graph Persistence |
| [ADR-002](docs/architecture/adr-002-typeql-engine-as-a-port.md) | TypeQL Engine as a Port |
| [ADR-003](docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md) | TypeDBLite Change Log and Sync as a Port |
| [ADR-004](docs/architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md) | TypeDBLite Execution Diagnostics as a Returned Report |
| [ADR-005](docs/architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md) | TypeDB's Behaviour Specification is TypeDBLite's Conformance Oracle |
| [ADR-006](docs/architecture/adr-006-an-attribute-is-stored-once-per-type-and-value.md) | An Attribute Is Stored Once per Type and Value |
| [ADR-007](docs/architecture/adr-007-a-scenario-typedb-itself-fails-is-a-deviation.md) | A Scenario TypeDB Itself Fails Is a Deviation |
| [ADR-008](docs/architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md) | The TypeQLite Editor Is a Langium Language Server in This Repository |
| [ADR-009](docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) | TypeDBLite Runs in the Browser on WASM SQLite |

**Standards:** [TypeDBLite Conformance Standard](docs/standards/governance/typedblite-conformance-standard.md) · [Multi-Phase Lifecycle Standard](docs/standards/governance/multi-phase-lifecycle-standard.md)

References in source code link to `docs/architecture/adr-NNN-*.md` using relative paths — they resolve to this repo's `docs/` tree.

## License

[Mozilla Public License 2.0](LICENSE), the licence TypeDB, TypeQL and TypeDB's behaviour
specification are published under. The specification files vendored in
[`libs/conformance/spec/`](libs/conformance/spec/) are TypeDB's, under the same licence, with their
headers intact.
