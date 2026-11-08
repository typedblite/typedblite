# TypeDBLite — Project Overview

Canonical reference for AI agents and automated tools. Keep this in sync with the repo as it evolves; it is the source of truth for project context across sessions.

---

## What it is

TypeDBLite is a TypeScript implementation of the [TypeDB](https://typedb.com) graph database engine backed by SQLite. It parses and executes **TypeQLite** — a dialect of TypeQL 3.x — and stores results in a SQLite database that can be opened with `node:sqlite`, a WASM build in a browser, or any binding that satisfies the `SqliteDatabase` interface.

## Libraries and apps

| Path | npm name | Role |
|---|---|---|
| `libs/language/` | `@typedblite/language` | Langium grammar, AST, language services |
| `libs/runtime/` | `@typedblite/runtime` | interpreter, SQLite generator, change log |
| `libs/content-revision/` | `@typedblite/content-revision` | revision identifiers |
| `libs/conformance/` | `typedblite-conformance` | TypeDB behaviour spec vendored as Cucumber features |
| `apps/cli/` | `typedblite-cli` | REPL and file runner |

## Key architectural invariants

- **SQLite boundary** — only `node-sqlite.ts` imports `node:sqlite`; all other code uses the `SqliteDatabase` interface (`libs/runtime/src/sqlite-database.ts`)
- **Sync interpreter** — the `SqliteDatabase` interface is synchronous by design; no async in the interpreter's inner loop
- **Revision parity** — `computeRevision` in `@typedblite/content-revision` must not be duplicated; proven against CouchDB 3.4.3 oracle
- **Caller-first grammar** — a TypeQLite construct is added to the grammar only when a real caller needs it ("find the caller first")
- **Conformance oracle** — `libs/conformance/` vendors TypeDB's `typedb/typedb-behaviour` spec (MPL-2.0); pass count per feature may never go down (ADR-005)

## Self-containment rules

The repo is completely self-contained and self-referential:
- No broken links to `../planning/` paths (from the original parent monorepo — those docs no longer exist here)
- No "sibling repo" or "parent monorepo" language (this IS the repo)
- No `libs/core/*` paths (old monorepo layout; correct paths are `libs/*` and `apps/*`)
- No `@downstream/*` package names in comments (removed with the parent monorepo)
- No build artifacts (`.d.ts` files) in `src/` directories — gitignored under `libs/**/src/**/*.d.ts`
- **Appropriate exceptions**: explicit references to upstream TypeDB/TypeQL projects (`typedb.com`, `typedb/typedb-behaviour`, `typedb/typedb` on GitHub)

## ADRs

| ADR | Title |
|---|---|
| ADR-001 | Embedded TypeDB for graph persistence (historical — WASM adapter removed) |
| ADR-002 | TypeQL engine as a port, SQLite as one adapter |
| ADR-003 | Change log belongs to the engine; sync is a port; CouchDB wire protocol in scope |
| ADR-004 | Execution diagnostics are returned reports, not emitted events |
| ADR-005 | TypeDB's behaviour spec is TypeDBLite's conformance oracle |
