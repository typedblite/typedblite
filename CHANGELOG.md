# Changelog

All notable changes to TypeDBLite are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org). Before 1.0, a minor version may include breaking changes;
they are listed here.

## [Unreleased]

### Changed
- The minimum Node.js version is now **22.16**, not 22.12. Node 22.12 has no `node:sqlite`, and 22.13 to
  22.15 ship it without FTS5, which the engine requires. Checked: `node:sqlite` and FTS5 probed on
  22.12 to 22.21; the full gate run on 22.13.0 (fails: no FTS5) and 22.16.0 (passes).
- `langium` and `langium-cli` are now `~4.4`, and `vscode-languageserver` `~10.1`.

### Fixed
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
- Community files: `SECURITY.md`, issue forms, a pull request template, `CODEOWNERS`, Dependabot
  configuration, and continuous integration.
