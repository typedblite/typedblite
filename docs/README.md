# TypeDBLite documentation

TypeDBLite is a TypeScript implementation of the TypeDB graph database engine, backed by SQLite. It
runs **TypeQLite**, a dialect of TypeQL 3.x, inside your own process: no server and no native
binary.

Choose your starting point by what you want to do.

## Use TypeDBLite

| Guide | What it covers |
| ----- | -------------- |
| [Getting started](guides/getting-started.md) | Build from source, run your first schema and queries from the CLI, then from code |
| [Five-minute tour](guides/five-minute-tour.tql.md) | A notebook that keeps a reading list in one SQLite file, then uses the same file from the command line and a Node program. Open it in VS Code, or read it as a transcript. Every cell, command and answer is tested |
| [Embedding the runtime](guides/embedding-the-runtime.md) | The engine API: `define`, `execute`, `query`, result values, transactions, diagnostics and refusals, options, custom SQLite bindings |
| [The TypeQLite language](guides/typeqlite-language.md) | What TypeQLite supports: schema, annotations, pipelines, patterns, expressions, functions, `fetch`, and the known gaps |
| [Versions and compatibility](guides/compatibility.md) | What a version number promises: what counts as breaking, stores and upgrades, replication between versions, requirements |
| [When to use TypeDBLite, and when not](guides/why-not-x.md) (draft) | TypeDB, plain SQLite, a graph library or a document database with sync: when each is the better choice |
| [Known limitations](guides/known-limitations.md) | What TypeDBLite does not do or does differently, each gap with its source, and what is still open |
| [Replication and search](guides/replication-and-search.md) | The change log, revisions, one-shot and hub-and-spoke replication, conflicts, compaction, full-text search |
| [CLI](../apps/cli/README.md) | The `typedblite` REPL, file runner and one-shot executor |
| [Sync demo](../apps/sync-demo/README.md) | A browser, a desktop app and a phone, each with its own store, syncing through a hub: setup, the story, and how to run it |
| [VS Code extension](../apps/vscode/README.md) | The TypeQLite editor: diagnostics, navigation, completion, rename, quick fixes |
| [Conformance status](../CONFORMANCE.md) | How closely TypeDBLite matches TypeDB, measured against TypeDB's own behaviour specification |

## Work on TypeDBLite

| Guide | What it covers |
| ----- | -------------- |
| [Contributing](../CONTRIBUTING.md) | Setup, the workflow, the checks a change must pass, and how a pull request is reviewed |
| [Architecture](development/architecture.md) | The packages and their dependency rule, how a query runs, the storage model, and the design rules that hold it together |
| [Testing](development/testing.md) | Every test suite, what it proves, and when to run it. Also the conformance report card, the oracles, and the clean-tree gate |
| [Adding a TypeQLite construct](development/adding-a-construct.md) | The step-by-step path from grammar to engine to conformance |
| [Releasing](development/releasing.md) | What is published, the checks a package must pass, the one-time setup, and how a release is made |
| [The website](development/website.md) | How the `typedblite.dev` site is built from these documents, checked and published |
| [Performance](development/performance.md) | What the engine costs on real schemas and data, the load test that measures it, what it found, and what is still open |
| [AGENTS.md](../AGENTS.md) | The same rules, condensed, for AI agents and automated tools |

## Package references

The API reference is generated from the source: `npm run docs:api` writes it to `dist/api`. The website
builds the same reference as pages of the site at `/api/` (see [The website](development/website.md)); it is not live yet.

| Package | README |
| ------- | ------ |
| `@typedblite/language` | [libs/language](../libs/language/README.md) |
| `@typedblite/runtime` | [libs/runtime](../libs/runtime/README.md) |
| `@typedblite/content-revision` | [libs/content-revision](../libs/content-revision/README.md) |
| `typedblite-conformance` | [libs/conformance](../libs/conformance/README.md) |

## Decisions and standards

- [Architecture decision records](architecture/) explain *why* the code is shaped the way it is. Source
  comments cite them by number, for example "ADR-004 Decision 3".
- [Standards](standards/governance/) set the rules for conformance claims and for multi-phase work.
- [Planning](planning/) holds feature documents, both complete and proposed.
- [Brand](brand/) holds the logo files, the colours and type, and how to use them.
