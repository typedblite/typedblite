# TypeDBLite

TypeDBLite is a TypeScript implementation of the [TypeDB](https://typedb.com) graph database engine backed by SQLite. It parses and executes **TypeQLite** — a dialect of TypeQL 3.x — and stores the result in a SQLite database that can be opened with `node:sqlite`, a WASM build in a browser, or any binding that satisfies the `SqliteDatabase` interface.

## Why

TypeDB's native server is a standalone Rust binary. TypeDBLite brings the same polymorphic type model, schema-first design, and TypeQL query language to contexts where spinning up a separate server is impractical: edge processes, embedded applications, local developer tooling, and browser workers.

## Packages

| Package | Description |
|---|---|
| [`@typedblite/language`](libs/language/) | Langium grammar, generated AST, and language services for TypeQLite. Parsing, validation, formatting, semantic tokens, and scope resolution live here. |
| [`@typedblite/runtime`](libs/runtime/) | SQLite generator, query interpreter, schema mutation engine, change log, replication, and the `TypeDBLiteDatabase` adapter. The working database lives here. |
| [`@typedblite/content-revision`](libs/content-revision/) | Canonical state encoding and CouchDB-style generation-digest revision identifiers (ADR-003). Shared by the runtime's change log and external content-versioning consumers. |
| [`typedblite-conformance`](libs/conformance/) | TypeDB's own behaviour specification vendored as Cucumber features and run against TypeDBLite as a report card. The spec lives under `spec/`; `deviations.yaml` declares intentional gaps. |
| [`typedblite-cli`](apps/cli/) | Interactive REPL, file runner (`--file`), and one-shot executor (`--exec`) for TypeQLite statements. |

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
redefine entity person owns name @card(0..);
```

```typeql
undefine owns name from person;
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
| `@key` | Generates a UNIQUE index; enforced at write time |
| `@unique` | Parsed; semantics tracked on the conformance report card |
| `@card(min..max)` | Parsed; not yet enforced at write time |
| `@abstract` | Parsed; no instances of the type itself may be inserted |
| `@independent` | Parsed; attribute may exist without an owner |
| `@regex`, `@values`, `@range` | Parsed; not yet enforced |
| `@doc`, `@meta` | Parsed; metadata stored in the runtime |

Annotations that are parsed but not yet enforced are reported by `define` as a diagnostic, not silently dropped.

## SQLite binding

The runtime depends on a `SqliteDatabase` interface rather than `node:sqlite` directly. `node-sqlite.ts` satisfies it for Node.js ≥ 22.12. A WASM SQLite binding running inside a Web Worker satisfies the same interface as long as it is synchronous within the worker. See [`libs/runtime/src/sqlite-database.ts`](libs/runtime/src/sqlite-database.ts) for the full contract.

## Replication

TypeDBLite includes a hub-and-spoke replication model (ADR-003):

- Every write appends to a **change log** (`ChangeLog`) with a CouchDB-style `generation-digest` revision (`@typedblite/content-revision`).
- The **hub** exposes a Server-Sent Events stream and a POST endpoint for incoming changes.
- **Spokes** subscribe and replicate bidirectionally or in one direction (`push` / `pull` / `duplex`).
- Identical edits applied independently on two nodes produce the same revision, so they converge without conflict.

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

# Build a single package
nx run @typedblite/runtime:build

# Test a single package
nx run @typedblite/runtime:test
```

Coverage is collected on CI (`CI=true npm run test`) and written to `coverage/`.

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
| [ADR-006](docs/architecture/adr-006-an-attribute-is-stored-once-per-type-and-value.md) | An Attribute Is Stored Once per Type and Value (Proposed) |

**Standard:** [TypeDBLite Conformance Standard](docs/standards/governance/typedblite-conformance-standard.md)

References in source code link to `docs/architecture/adr-NNN-*.md` using relative paths — they resolve to this repo's `docs/` tree.
