# Changelog

All notable changes to TypeDBLite are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org). Before 1.0, a minor version may include breaking changes;
they are listed here.

## [Unreleased]

### Added
- **`@typedblite/session`, a fifth published package**: a session over the engine (`Session`: run, begin, commit, rollback, restart, close, schema) and the statement classifier the CLI used to hold (`classifyStatement`, `splitStatements`). A statement's refusal is returned as data, with a `reason` to branch on (`engine`, `no-schema`, `locked`, `closed`, `transaction`). The `typedblite` CLI now runs through it, with its behaviour unchanged. It has no dependency but `@typedblite/runtime`.
- **The TypeQLite engine host** (`apps/engine-host`, private; ADR-011): a NestJS CQRS app that runs statements in sessions, over five transports from one declaration of its twelve operations: CLI, REPL, sidecar, HTTP and MCP. HTTP and HTTP MCP answer loopback only (peer, `Host` and `Origin`); MCP serves a read tier unless `--mcp-write`. The extension bundles it and starts it as a process, with a `node` it checks first (`typedblite.host.node`), and features reach it through the command `typedblite.host.request`.
- **TypeQLite notebooks in the VS Code extension** (ADR-012): a Markdown file whose `typeql` fences are code cells. `*.tql.md` opens as a notebook, and any `*.md` by "Open With". An unedited notebook is written back byte for byte, an edit changes only its cell's lines, and outputs are never saved. Cells run on the engine host against one in-memory store per notebook, and show a table, JSON, execution facts, or the engine's own refusal with its line and column; a long answer shows a page of rows and counts the rest (`typedblite.notebook.maxRows`). Run All, Run Above, Run Below and Restart work. The language features work across the cells of a notebook. A notebook runs in memory until the user chooses a store file, picks when its writes become permanent (hold changes until Commit, or commit each statement), and sees both in the status bar; the choice is never saved in the notebook or remembered. A notebook exports as a `.tql` script of its code cells and as Markdown.
- **`@typedblite/language`: a notebook is a schema of its own** (`schemaOwnerOf`, `sameSchema`, `NOTEBOOK_CELL_SCHEME`, `WORKSPACE_OWNER`). A `vscode-notebook-cell:` document sees its notebook's cells and no other document, and a file sees no cell, in scoping, completion, rename, hover and the unknown-label check. `createTypeQLiteServices` takes an optional second argument, shared services to replace, so a host can supply its own `LanguageServer`.
- **The sync demo runs in a browser page, hub included**, and the website shows it at `/sync-demo/`. One page owns the hub (a TypeDBLite store on WASM SQLite and OPFS in a dedicated Worker) and embeds three devices, each with its own store and a Disconnect / Reconnect switch; the hub can be killed and brought back on the store it left. `npm run demo:browser` serves it locally. The hub's logic is `apps/sync-demo/src/browser-hub/hub-core.ts`, and a test runs one scenario against it and against the Node hub and checks they end in the same place. A hub cannot be a SharedWorker: Chromium has no synchronous OPFS handles there. Only one tab can own the stores at a time, and the page says so.
- **Each device in the in-browser demo has its own colour** (cyan, rose, olive) on its card, on the chip that says where a task was made, and in the hub's list, in light and dark. The colours are at least 100° of hue apart and clear of the green, red and amber that mean online, offline and waiting, and `browser-hub-build.test.ts` holds their contrast and hue distance. The highlight that fades on a change a sync has just brought in takes the colour of the device that made the change (a task added on A, checked on B, unchecked on C), not that of the task's maker. The demo's task schema gained `edited-by`, written in the same transaction as the change so that it replicates with it; older stores keep working and read each task as last edited by its maker. `DemoDevice.setDone` no longer writes when the task is already in the state asked for.

### Changed
- **`@typedblite/language`: `TypeQLiteLabels.workspaceHasSchema`, `resolve` and `candidates` take the document they are asked about** (an optional `context`, and `resolve`'s site already carries its `document`). Without one they answer for the workspace's schema, as before, and no longer count a notebook's cells in it.
- **The API reference's package pages are grouped by purpose and open with an overview.** Each package page lists its names under sections such as Engine, Replication and Validation, each with a description, instead of one alphabetical table per kind; the language package's generated syntax tree has a section of its own. The runtime, language, content-revision and WASM pages gained an introduction with a short example, and link the guides.
- **Each class and interface page in the API reference opens with a member summary**: a table per group (constructors, properties, accessors, methods) with each member's first sentence, linked to its detail below.
- **The API reference shows no maintainer notes, and describes the generated syntax tree's properties.** Notes marked `🔴` or `⚠️` on an exported name moved under `@privateRemarks`, which TypeDoc leaves out, and a few comments were reworded where the note was the only description. The properties of the generated node types (`EntityDef.name`, `OwnsTrait.ordered`, …) are described from their types and, for a flag, from the keyword the grammar writes. `check-api` fails on a `🔴` or `⚠️` note that would show.
- **Every name in the API has a doc comment**, and so has every member a class or interface declares itself, so the API
  reference describes everything it lists. `npm run check-api` now fails when one is missing. The generated syntax tree
  (`@typedblite/language`'s `src/generated/`) is documented by a step after `langium generate`
  (`libs/language/scripts/document-generated.mts`), because Langium writes those files without comments.
- **`@typedblite/language`: `EntityDef` and `RelationDef` hold their `sub` and `value` clauses in lists** (`superTypes`, `valueTypes`),
  not in `superType` and `valueType`. The grammar lets those clauses sit among a type's traits, so one could be written
  twice, and the second overwrote the first without a word (Langium warned of it on every build). A second `sub` or
  `value` on one entity or relation is now refused with `typedblite.repeated-clause`; TypeDB refuses it too (`DEX13`,
  checked on 3.10.4). `AttributeDef` and the re-open and redefine nodes are unchanged.
- The test fixtures are original: a project tracker (`tracker`, `people`, `sprint`, `documents`) replaces the schemas
  and example queries adapted from a downstream application, and the load test's `real-stores` suite is removed.
  The `growth`, `relations` and `concurrency` suites generate their own data, so the load test runs from this
  repository alone. The performance guide is rewritten on that data, and the old results files are renamed to
  match (their measurements of the private stores are removed).
- **Breaking for a hand-written client:** a store now checks a revision from a peer against its content, instead
  of storing the `rev` it is given (ADR-003, amended 2026-11-15). A revision must equal `computeRevision` of its
  state, parent and deleted flag, and a live one must carry its state. Otherwise `ChangeLog.applyRemote` throws with
  the new code `typedblite.revision-not-derived`, a batch is refused whole, and the hub answers 400 naming the
  change. Before, a peer could send `999999-deadbeef`, or a revision another store held with different content,
  which left the two stores split for good while each believed it was in sync. `TypeDBLiteReplicator` and
  `replicateOnce` send derived revisions and are unaffected. A peer that may write can still make its write win;
  authentication decides who may write.
- Vitest is now **5.1.0** (from 4.1), with `@vitest/coverage-v8` 5.1.0 beside it, as Vitest requires. No test or
  config needed a change: none of Vitest 5's breaking changes (`vi.mock` inside a function, `sequential`, the removed
  `vitest/*` entry points, unawaited `rejects`, browser mode) applies here. Every project runs the same test files.
- Nx is now **24.0.6** (from 23.3.0), with `nx migrate`'s migrations: `nx.json` gains `affected.legacy: true`,
  so `nx affected` keeps selecting whole projects (nothing here uses it; the gate runs every project). The other
  two migrations found nothing to change. Nx release's configuration is unchanged in 24, and its dry runs behave as
  before.
- **Breaking:** `@typedblite/runtime` exports less. Its entry points now name every export, and these are no
  longer among them: `generateSchema` and `SchemaSql` (the generated SQL, which the compatibility policy does not
  cover), `translateConstraintError`, `DiagnosticCollector`, `rangeOf` and `rangeFromOffset` (internal plumbing),
  and the re-exports of `@typedblite/content-revision`'s functions (`canonical`, `computeRevision`, `conflicts`,
  `digestOf`, `generationOf`, `winner`): import those from `@typedblite/content-revision`, where `latestOf` also
  is. Nothing in this repository, and no known consumer, used them from the runtime. Its types (`Revision`,
  `EntityState`, `Leaf` and the rest) are still re-exported, for the change log's signatures.
- `attachDiagnostic`, `canonicalTemporal`, `instantOf`, and `TypeDBLiteInterpreter`'s `evaluationContext`,
  `returned` and `segmentFor` are marked `@internal`: still there, for the engine's own modules and the
  conformance suite, but not part of the API and not in its reference.
- The CLI's npm package is now **`typedblite`**, not `typedblite-cli`, so that `npx typedblite` runs it. The
  command was already `typedblite`. Nothing had been published under either name.
- Every published package now declares Node **22.16** in `engines`, as the repository does.
  `@typedblite/language` said `>=20.10.0`, and `npm >=10.2.3`, neither of which anything tested.
- The runtime's optional peer `@sqlite.org/sqlite-wasm` is now `>=3.54.1-build1 <3.54.2`, the version the
  WASM suites run on. It was `^3.50.0`, which matches **no** published version: every one has a `-buildN`
  suffix, which semver treats as a prerelease, so `npm install @typedblite/runtime @sqlite.org/sqlite-wasm`,
  the runtime README's own command, failed with `ETARGET`. Found by the new clean-room test.
- The minimum Node.js version is now **22.16**, not 22.12. Node 22.12 has no `node:sqlite`, and 22.13 to
  22.15 ship it without FTS5, which the engine requires. Checked: `node:sqlite` and FTS5 probed on
  22.12 to 22.21; the full gate run on 22.13.0 (fails: no FTS5) and 22.16.0 (passes).
- `langium` and `langium-cli` are now `~4.4`, and `vscode-languageserver` `~10.1`.
- Windows is a supported platform: CI's Windows job (Node 24) is now blocking, like the Linux ones, after
  the build and every test passed there on two complete runs.

### Fixed
- A value read as an attribute is refused, as TypeDB refuses it. `given $t: string; match $b isa book, has title $t;`
  matched nothing and said so only in an `empty-match` fact; it now throws `typedblite.mixed-pattern` ("The variable
  't' cannot be declared as both a 'Value' and as a 'Attribute'"), the words TypeDB uses and TypeDBLite already used
  for a `let` in the same match. A `reduce` result used that way is refused now too. `has title == $t` is the form
  that compares a value, and works on both. A `given` of an attribute type (`given $t: title`) is still an attribute and still joins.
  Found by running the five-minute tour on a live TypeDB 3.10.4. **A query that relied on the empty answer now fails.**
- An empty answer that joins through a relation no longer reads every relation of the type to explain itself.
  A project's sub-projects took 0.8 ms when it had one and 21 ms (3,000 projects) when it had none, because the
  explanation, and `relationHolds`, read all rows to learn whether there were any. They now stop at the first.
  Found by the load test on the new generated data. `QueryTrace` gains `relationRows`.
- The extensions' `package` and `e2e` targets named `0.0.1` in their commands, so the first version bump would have
  broken both. `vsce` now names each package from its manifest, and `e2e --packaged` finds them the same way.
  The e2e runner also found a companion's id by splitting its path on `/`, which fails on Windows.
- `@typedblite/runtime` and `@typedblite/content-revision` would have been published **without their
  JavaScript**. They had no `files` list, so npm fell back to `.gitignore`, which excludes `out/`: they would
  have shipped their TypeScript sources, tests, bench and configs instead. Every published package now has a
  `files` allowlist, its `LICENSE`, declaration maps, and `repository`, `bugs`, `homepage` and `keywords`.
- The change-stream hub (`createChangeStreamHandler`, `serveChangeStream`) is hardened. It refuses a POST that
  is not `application/json` (415), which closes the door a web page had to write to a hub on `127.0.0.1`
  cross-origin with no CORS preflight; refuses a body over `maxBodyBytes`, default 64 MiB (413), before
  reading it when its length is declared and while reading it when not; refuses a stream past `maxStreams`,
  default 256 (503, `retry-after`); applies a pushed batch **all or none** (`ChangeLog.applyRemoteBatch`)
  instead of half; and answers a malformed batch with a 400 that names the problem, and an internal failure
  with a 500 and no detail, reporting the real error to a new `onError` option. **Breaking for a hand-written
  client** that posts without `content-type: application/json`; `TypeDBLiteReplicator` already sends it. Not
  changed by that work: a pushed revision was still stored as given. It is now checked against its content (the entry under **Changed**).
- The `typedblite` CLI now runs on Windows, and through its npm `bin` link (`npx typedblite`, a global
  install) everywhere. Its entry check compared the script's file name, split on `/`, with the module's
  URL. On Windows the path has no `/`, and through the `bin` link the name is `typedblite`, so `main()`
  never ran and the CLI exited 0 having printed nothing; the REPL tests failed on the Windows CI runner
  for that reason. It now compares real paths. `out/main.js` also gains the `#!/usr/bin/env node` line
  the `bin` link needs. Without it, a POSIX shell ran the file as a shell script.
- The language server no longer loses a document's diagnostics when several files are opened at once.
  Langium 4.4 could cancel the build between validating a document and publishing its diagnostics, and
  never revisit it, so the first of a burst of `didOpen`s sometimes showed no diagnostics until it was
  edited (about 3 runs in 10 for five documents). `TypeQLiteDocumentBuilder` now publishes a validated
  document's diagnostics regardless of cancellation.
- `npm run build` no longer fails on Node 24.22 and later. `langium generate` (langium-cli 4.3.0) threw
  `TypeError: Invalid URL` there, because its `jsonschema` dependency resolved schema references against
  an opaque-path base URL that newer Node versions reject. langium-cli 4.4 does not hit it.
- `package-lock.json` no longer resolves 336 packages from a local registry (`localhost:4873`), which
  made `npm ci` fail for everyone but the machine that committed it.

### Added
- **Publishing the VS Code extensions**, written and not yet run: `release-extension.yml` publishes TypeQLite (tag
  `typeqlite-v<version>`) or the Theme Bridge (`typeqlite-theme-v<version>`) to the Visual Studio Marketplace and
  Open VSX after the e2e and an approval, and [Releasing](docs/development/releasing.md#the-vs-code-extensions) has
  the one-time setup. The Theme Bridge gains a changelog and the marketplace metadata the extension has.
- **An API reference**, generated by TypeDoc from the four entry points: `npm run docs:api` writes it to
  `dist/api`. `npm run check-api`, now in the gate and CI, fails on a TypeDoc warning and on a public signature
  that mentions a type the package does not export. It found `db.changeLog`'s type, `ChangeLog`, and
  `ChangeRecord`, which nothing exported, and source comments linking to documents one directory too high, or to
  ADRs of the monorepo the engine came from.
- `@typedblite/runtime` exports the change log's types: `ChangeLog`, `ChangeRecord`, `CompactionOptions`,
  `CompactionReport` and `EntityIdentity`. `@typedblite/language` exports `TypeQLiteLabelServices`, which its
  label-aware providers are constructed with.
- **Packaging and release.** A [compatibility policy](docs/guides/compatibility.md) for the first release and
  after; Nx release, configured to version the four npm packages as one group; a release workflow that
  publishes a tag with provenance (written while Actions is off, so it has never run); and
  [Releasing](docs/development/releasing.md), the process. Two checks join the gate: `npm run check-packages`,
  which reads what `npm publish` would ship and fails on a missing entry point, a test file, a missing LICENSE
  and more, and `npm run clean-room`, which installs the tarballs in an empty directory and uses the CLI, the
  runtime on `node:sqlite` and on WASM, the published types, and the browser entry. CI gains a clean-room job
  on Linux, macOS and Windows.
- `@typedblite/language` ships its TextMate grammar, as `@typedblite/language/typeqlite.tmLanguage.json`. Its
  README already said it did, but the file was in neither `files` nor `exports`.
- The VS Code extension has a changelog, keywords, a gallery banner, and `homepage` and `bugs` links, for its
  marketplace pages.
- The playground's editor is now **Monaco, with the real language server behind it over LSP**, in a worker: the
  server the VS Code extension runs. Errors are underlined as you type, with completion, hover, go to definition,
  references, rename, quick fixes, an outline, folding, formatting and names coloured by what they resolve to.
  `@typedblite/language` now exports `KEYWORD_SCOPES`, `grammarKeywords`, `typeqliteTextMate` and `TEXTMATE_OUT`
  (the table the VS Code grammar is generated from), so the editor's keyword colours come from the same table.
- **A browser playground**, `apps/playground`: write TypeQLite and run it in a browser with nothing to install.
  The engine is TypeDBLite on WASM SQLite in a Web Worker, each run starts from an empty in-memory database,
  and nothing leaves the page. Three examples, errors that name their line, results as tables or JSON, and a
  link that carries the whole program after `#code=`. Run it with `npm run playground`. It is not
  hosted yet.
- `npm run gate`: the whole check in one command, from a clean tree: build, type-check, tests with the 80%
  coverage floor, the WASM suite, the browser suite and the VS Code e2e (`-- --quick` skips the last three).
  GitHub Actions is off for now, so this is how a change is checked.
- Community files: `SECURITY.md`, issue forms, a pull request template, `CODEOWNERS`, Dependabot
  configuration, and continuous integration.
