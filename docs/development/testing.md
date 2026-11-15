# Testing

TypeDBLite is tested at four levels. Specs test the language library, tests test the engine, the
conformance report card measures the engine against TypeDB's own specification, and an end-to-end
suite tests the editor inside a real VS Code. This page says what each suite proves and when to run
it.

- [Running the tests](#running-the-tests)
- [The suites](#the-suites)
- [The clean-tree gate](#the-clean-tree-gate)
- [The conformance report card](#the-conformance-report-card)
- [The TypeDB oracle](#the-typedb-oracle)
- [The editor's end-to-end suite](#the-editors-end-to-end-suite)
- [The engine on WASM SQLite](#the-engine-on-wasm-sqlite)
- [The full-text parity oracle](#the-full-text-parity-oracle)
- [Writing tests](#writing-tests)

## Running the tests

From the repository root:

```bash
npm test                                         # every project's test target
npm exec nx -- run typedblite-runtime:test       # one project
npm exec nx -- run typedblite-runtime:test -- interpreter   # files matching a name
```

The Nx project names are `typeqlite-language`, `content-revision`, `typedblite-runtime`,
`typedblite-conformance`, `typedblite` (the CLI), `typeqlite-vscode`, `sync-demo` and `playground`.

Every suite runs on [Vitest](https://vitest.dev), with a 30-second timeout per test. Set `CI=true`
to collect coverage into `coverage/<project>/`, with an 80% floor on statements, lines and functions
in every project.

**What the floor leaves out, and why.** A file is excluded only by name, in its project's
`vitest.config.ts`, and only when it runs inside a host the unit runner does not provide: VS Code's
extension host, a browser or its workers, Electron, a live TypeDB server, or a separate process. Each
entry says where that code IS run (the e2e suite, `sync-demo:test-browser`, `playground:test-browser`, the differential oracle).
Code that can be unit-tested is tested, not excluded. vscode's modules that import `vscode` are tested
against `test/fakes/vscode.ts`.

## The suites

| Project | Files | What it proves |
| ------- | ----- | -------------- |
| `typeqlite-language` | `libs/language/test/*.spec.ts` | The grammar parses what it should; the validator refuses what it should; formatting, highlighting, scope, navigation, completion and rename behave. `spec-backgrounds.spec.ts` parses every Background of TypeDB's specification, and `production-schemas.spec.ts` parses the schemas in `test-fixtures/schemas/` |
| `content-revision` | `libs/content-revision/src/lib/*.spec.ts` | Revisions are deterministic, and the canonical encoding cannot be forged |
| `typedblite-runtime` | `libs/runtime/test/*.test.ts` | The engine: schema rules, writes, every query construct, transactions, diagnostics, storage migration, the change log, replication, and full-text search |
| `typedblite-conformance` | `libs/conformance/test/*.test.ts` | The [report card](#the-conformance-report-card) has not regressed, plus the harness itself |
| `typedblite` | `apps/cli/test/*.test.mts` | The CLI. `repl.test.mts` spawns the real binary and pipes input into it |
| `typeqlite-vscode` | `apps/vscode/test/*.test.ts` | The manifest matches the language library, and the bundled language server answers over stdio |
| `playground` | `apps/playground/test/`, `apps/playground/test-browser/` | The browser playground. The unit tests run `runProgram` on `node:sqlite`, the examples, share links, the runner's timeout, the static server's path-traversal guard, and the **language server over the real LSP** in Node. `test-browser` runs the page in Chromium: the engine in a worker, nothing requested from another origin, a program's text shown as text, and the Monaco editor driven by the language server. Names coloured by what they resolve to, squiggles, completion, hover and formatting each fail if the LSP client is switched off (keyword colours need no server, and are checked without one) |
| `sync-demo` | `apps/sync-demo/test/smoke.test.ts` | The sync demo's story with headless devices, a real hub process and the real switchboard: convergence after every network event. `test-browser` adds the PWA in Chromium, the Electron app, and the whole story headless |

## The clean-tree gate

Before you open a pull request, run the full gate **from a clean tree**:

```bash
npm run gate            # everything below
npm run gate -- --quick # the first six steps only
```

`tools/gate.mjs` runs, in order, and stops at the first failure: **clean** (every `out/`, every
`*.tsbuildinfo`, `coverage/`), **build**, **typecheck**, **package contents** (what `npm publish` would ship,
`npm run check-packages`), **API** (the API reference builds cleanly and every type it mentions is exported,
`npm run check-api`), **test** with `CI=true` (so the 80% coverage floor and the conformance report card
both apply), the **WASM** suite, the engine's **browser** suite, the **playground** in Chromium, the **VS Code
e2e**, and the **clean-room install** (`npm run clean-room`: the npm tarballs installed in an empty directory
and used; see [Releasing](releasing.md#the-checks-a-package-must-pass)). It sets `NX_SKIP_NX_CACHE`, so no
task is replayed from a cache. The last five are skipped by `--quick`. The browser suites need Playwright's
Chromium, the e2e a display, and the clean room the npm registry, for the packages' dependencies.

**GitHub Actions is off for now**, so this is the only check. It covers the one Node and OS you run it on;
CI used to cover Node 22.16, 22 and 24 on Linux and Node 24 on Windows and macOS. For a change that touches
paths, child processes, file handles or Node-version behaviour, try it on another if you can.

🔴 **Why clean.** `build` is `tsc -b`, which is incremental. A library whose sources did not change
is not rebuilt, so the packages that depend on it are checked against stale type declarations, even
with `--skip-nx-cache`. A dependency upgrade once hid a real type error for a whole phase of work in
exactly this way. After any change to dependencies or to a public type, a clean build is the only
build you can trust.

## The conformance report card

`libs/conformance` vendors [TypeDB's behaviour specification](https://github.com/typedb/typedb-behaviour)
(its `query/language` features, pinned in `spec/PIN`) and runs every scenario against the engine
([ADR-005](../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).

```bash
npm exec nx -- run typedblite-conformance:test     # fails on any regression
npm exec nx -- run typedblite-conformance:report   # prints the full card and a digest of failures
```

Each scenario has one of four outcomes: **pass**, **fail**, **deviation** (declared in
`deviations.yaml`, with an owner), or **not applicable** (declared in `not-applicable.yaml`). The
current numbers are in [CONFORMANCE.md](../../CONFORMANCE.md).

**`baseline.json` is a floor.** It records the passing count for each feature file.
- **A count below its floor fails the run.** Fix the regression. Never lower the floor to make a
  change pass.
- **A count above its floor also fails `test`**, with `⬆ above baseline — raise it`. Raise the
  number in `baseline.json` by hand, in the same commit as the improvement. That way the floor
  always reflects what `main` actually achieves.
- **A deviation that starts passing** is reported as `✅ deviation now passing`. Remove its entry in
  the same commit.

**Declaring a deviation** needs an owner: an ADR, or a defect record. Declare one only once the
scenario's Background passes and the deviation is the real reason it fails. The rules are in the
[TypeDBLite Conformance Standard](../standards/governance/typedblite-conformance-standard.md) and
the [conformance README](../../libs/conformance/README.md).

**Never edit the vendored `.feature` files.** To move to a newer specification, re-vendor at a new
commit, update `PIN`, and re-run the whole card.

## The TypeDB oracle

When it is unclear what TypeDB does, ask TypeDB. The oracle runs the same Cucumber steps against a
live TypeDB server and prints where the two disagree:

```bash
docker run -d --name typedb-oracle --restart always -p 8000:8000 typedb/typedb:3.10.4
cd libs/conformance
npx tsx --tsconfig ../../tsconfig.base.json src/oracle.ts match:948 fetch
```

Arguments filter by feature, or by feature and line. `TYPEDB_URL` overrides the default
`http://localhost:8000`. A scenario that TypeDB itself fails is a deviation owned by
[ADR-007](../architecture/adr-007-a-scenario-typedb-itself-fails-is-a-deviation.md), not a bug in
TypeDBLite. The oracle needs a server, so it is never part of the routine run.

## The editor's end-to-end suite

```bash
npm exec nx -- run typeqlite-vscode:e2e
```

This packages the extension and the TypeQLite Theme Bridge as `.vsix` files, downloads VS Code,
installs both into a fresh profile, and runs the cases in `apps/vscode/e2e/suite.ts` inside the real editor. It needs a
display: use `xvfb-run` on a headless machine. Run it whenever you change something an editor sees.
That includes any change to the language library's providers.

## The engine on WASM SQLite

[ADR-009](../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) makes WASM SQLite
a supported binding. Two targets prove it:

| Target | What it proves |
| ------ | -------------- |
| `typedblite-runtime:test-wasm` | The whole runtime suite on `@typedblite/runtime/wasm`, in Node. The interpreter's `#default-opener` is aliased to the WASM opener, and no test is edited. Tests that need a real file on a real disk are excluded **by name, with the reason**, in `vitest.wasm.config.ts`: a second connection inspecting the file, another process on the same file, and WAL |
| `typedblite-runtime:test-browser` | The engine in a real Chromium, on OPFS. A store survives closing the whole browser, a duplicate key is refused with `[CNT9]`, and 🔴 **every revision the browser computes equals the one Node computes** for the same writes. Needs Playwright's Chromium (`npx playwright-core install chromium`) |

Run both after any change to the binding interface, `wasm.ts`, or `content-revision`.

## The full-text parity oracle

`typedblite-runtime:test-oracle` compares full-text search with an external search index, the one
a documentation-store project used. It needs that index running, so it is not part of the routine run.

🔴 **Nothing compares the change log's conflict semantics with CouchDB's any more.** A CouchDB
revision-tree parity suite once lived in that configuration, and was removed in 2026-09. Treat
changes to `change-log.ts` and `content-revision` with corresponding care, and cover them with
runtime tests. The revision *hash* is pinned: `sha256.spec.ts` proves it identical to the
`node:crypto` digest every existing store was written with.

## Writing tests

- **Put the test where the behaviour lives.** Grammar and validator rules go in `libs/language/test`,
  engine behaviour in `libs/runtime/test`.
- **File names:** `*.spec.ts` in the language library, `*.test.ts` in the runtime, conformance and
  extension, and `*.test.mts` in the CLI.
- **Assert on diagnostic codes, not messages.** Codes are stable API; messages are for people and
  will be improved.
- **Test the refusal, not just the success.** Every construct has inputs it must refuse. Fail-loud
  is the design ([Architecture](architecture.md#failing-loudly-three-layers)), so test it.
- **A multi-document language test** uses the harness in `libs/language/test/workspace.ts`, which
  builds several files into one workspace with an in-memory file system.
- **Shared schemas** for several suites live in `test-fixtures/schemas/`.
- **Prove a test can fail.** For a new provider or rule, briefly disable it and confirm the test goes
  red. A test that cannot fail proves nothing.
- **Differential tests** compare two implementations that must agree. For example,
  `relation-join-planning-differential.test.ts` runs the planned and unplanned engines and asserts
  the same rows in the same order. Prefer this shape whenever you add an optimisation.
- **Count work, do not time it.** To guard performance, assert on `lastQueryTrace()` counts, as in
  `query-trace.test.ts`. Timings are flaky; counts are not. When the cost is a scan the trace does
  not count, assert on SQLite's own plan, as `full-text-key.test.ts` does with `EXPLAIN QUERY PLAN`.
  Timings belong to the load test, `nx run typedblite-runtime:bench`
  ([Performance](performance.md)), which writes them to a results file.
