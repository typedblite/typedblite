# Changelog

All notable changes to TypeDBLite are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org). Before 1.0, a minor version may include breaking changes;
they are listed here.

## [Unreleased]

### Changed
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
  changed: a pushed revision is still stored as given (see the replication guide's Security section).
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
