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
| `libs/session/` | `@typedblite/session` | A session over the engine (transactions, restart) and the statement classifier, shared by the CLI and the engine host |
| `libs/debugger/` | `@typedblite/debugger` (private) | The TypeQLite debug adapter (ADR-014): DAP over recordings of each statement, made by the engine host's `session.debug` in a `:memory:` session |
| `apps/cli/` | `typedblite` | The CLI: REPL and file runner |
| `apps/vscode/` | `typeqlite` (private) | VS Code extension: the TypeQLite editor, a Langium language server (ADR-008); it also bundles and starts the engine host, and provides TypeQLite notebooks (ADR-012) and the TypeQLite debugger (ADR-014) |
| `apps/engine-host/` | `@typedblite/engine-host` (private) | The workbench's NestJS CQRS host that runs statements in sessions, over the CLI, REPL, sidecar, HTTP and MCP (ADR-011) |
| `apps/sync-demo/` | `typedblite-sync-demo` (private) | Offline-first sync demo: PWA, Electron and Android devices and a TypeDBLite hub (ADR-009) |

## Key architectural invariants

- **SQLite boundary** — only `node-sqlite.ts` imports `node:sqlite`; all other code uses the `SqliteDatabase` interface (`libs/runtime/src/sqlite-database.ts`)
- **Sync interpreter** — the `SqliteDatabase` interface is synchronous by design; no async in the interpreter's inner loop
- **Revision parity** — `computeRevision` in `@typedblite/content-revision` must not be duplicated. The CouchDB oracle that once proved parity was removed (2026-09) and no suite re-checks it, so a change to the algorithm needs its own tests and an ADR-003 amendment; the hash itself is pinned to the `node:crypto` digest by `sha256.spec.ts`
- **NestJS stays in the host** — `apps/engine-host` is the only place that depends on NestJS; the runtime, the language library and `@typedblite/session` do not, and the extension never imports the host (it runs it as a process)
- **Caller-first grammar** — a TypeQLite construct is added to the grammar only when a real caller needs it ("find the caller first")
- **Conformance oracle** — `libs/conformance/` vendors TypeDB's `typedb/typedb-behaviour` spec (MPL-2.0); pass count per feature may never go down (ADR-005)

## Self-containment rules

The repo is completely self-contained and self-referential:
- No broken links to `../planning/` paths (from the original parent monorepo — those docs no longer exist here)
- No "sibling repo" or "parent monorepo" language (this IS the repo)
- No `libs/core/*` paths (old monorepo layout; correct paths are `libs/*` and `apps/*`)
- No package names from the parent monorepo in comments (removed when the engine moved out)
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
| ADR-006 | An attribute is stored once per type and value |
| ADR-007 | A scenario TypeDB itself fails is a deviation, and the oracle decides which |
| ADR-008 | The TypeQLite editor is a Langium language server in this repository; nothing it knows reaches the runtime |
| ADR-012 | The TypeQLite notebook is a Markdown file run on the engine host: a `typeql` fence is a cell, a notebook is a schema of its own, a store is the user's explicit choice and never saved |
| ADR-011 | The workbench runs TypeQLite in a separate engine-host process: NestJS fenced into `apps/engine-host`, built on `@devx-micro/app-*`, MCP read-only by default |
| ADR-009 | TypeDBLite runs in the browser on WASM SQLite: `@typedblite/runtime/wasm`, a browser entry, synchronous SHA-256 revisions |
| ADR-014 | The debugger replays a recording of each statement, made on the engine host by `session.debug` in a `:memory:` session; the runtime's step hook is internal (`@typedblite/runtime/debug`) and changes no answer |
