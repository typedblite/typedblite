---
kind: adr
status: accepted
date: 2026-11-12
decision-owners: [Founder, TypeDBLite maintainers]
extends: [adr-002]
---

# ADR-008: The TypeQLite editor is a Langium language server in this repository, and nothing it knows reaches the runtime

- **Status:** Accepted on 2026-11-12. The founder took Decisions 3, 4 and 7 in
  [Phase 00](../planning/editor/phases/00-scope-and-adr/summary.md) of the
  [TypeQLite Editor](../planning/editor/editor.feature.md) feature, each as recommended. The rest are
  measurements, and the evidence for each is below. **Amended on 2026-11-13** in D8: row 3 (the
  TextMate grammar scopes keywords by kind) and row 14 (the extension has an icon).
- **Date:** 2026-11-12
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-002](adr-002-typeql-engine-as-a-port.md). Its Decision 7 makes the Langium validator the
  middle of three failure layers, and this ADR is about keeping editor features out of that layer.

---

## Context

`@typedblite/language` holds a grammar, a validator, a scope provider, a formatter and semantic
tokens, and none of them reaches an editor from this repository. A downstream application ships an extension
that stands up these services, but it also bundles a database client for that application's own store
app. That store is why the extension stayed in that application's repository when the engine moved here.

Measured on 2026-11-12, before deciding:

| Fact | Consequence |
| ---- | ----------- |
| The interpreter calls `LangiumParser.parse` and then `validateSync`, on `EmptyFileSystem`. It never builds a `LangiumDocument`, never links, and never runs `DocumentValidator` | The linker, the scope provider, the index, every LSP provider and `DocumentValidator` are **invisible to the runtime**. `ValidationRegistry` is not |
| `DefaultScopeComputation` exports only the root's direct children. TypeQLite's root children are clauses, which have no name | **Nothing is in the global index today**, so no reference resolves across files |
| Cross-references exist only in schema statements: `sub`, `owns`, and the role in `plays` | A type label in a pipeline (`isa person`, `has name`, `links (employee: $x)`) is a plain `ID` |
| The runtime reads those pipeline properties as strings in about 390 lines across 12+ files of `libs/runtime/src` (13.7k lines) | Turning them into cross-references would change the runtime's input type in hundreds of places, for an editor-only benefit |
| `langium@4.3.1` depends on `vscode-languageserver ~10.0.1`, and `@typedblite/language` pins `~9.0.1` | Two copies are installed. Upstream's own extension pairs `vscode-languageclient ~10.0.0` with `vscode-languageserver ~10.0.0` |
| Langium's `DefaultWorkspaceManager` already skips dot-folders, `node_modules` and `out` | Upstream's ignore-pattern subclass only adds configurability |

## Decision

**D1. The extension lives at `apps/vscode/`.** Its Nx project is `typeqlite-vscode`. Its npm
package is private and named `typeqlite`, because VS Code builds the id from `publisher.name`. Its
extension id is `typedblite.typeqlite`, with the display name *TypeQLite*
(renamed *TypeDBLite* on 2026-11-25; and on 2026-11-26, still before first publication, the package was
renamed `typedblite-workbench`, so the id is `typedblite.typedblite-workbench`).
That id cannot be mistaken for the downstream extension's id. It depends on
`@typedblite/language` only, never on the runtime: `vscode → language`.

**D2. 🔴 Nothing the editor knows reaches the runtime.** Every editor feature is built from services
the runtime's parse path never runs: `ScopeComputation`, the scope provider, the index, the LSP
providers, and `DocumentValidator`. **An editor-only diagnostic is produced by a `DocumentValidator`
subclass, never by a check in `ValidationRegistry`.** `validateSync` runs every registered check, so
a registered check is a runtime rule (ADR-002 D7). The proof, at every phase close, is the conformance
run unchanged: 1742 of 1756, with `baseline.json` untouched.

**D3. One workspace is one schema.** Every TypeQLite file Langium's workspace manager indexes
contributes its definitions to a single global scope. Phase 02 overrides `ScopeComputation` to export
each definition inside a `define` clause. Re-opens resolve across files too. If two independent
schemas in one workspace define the same label, navigation resolves to the first one found. That is
an accepted, documented limit. **A project file that splits a workspace into several schemas is
deferred until a real workspace needs it** (caller-first).

**D4. The extension claims `.typeqlite` and `.tql`, and `langium-config.json` is the only source of
that list.** The manifest is generated or checked from it, never edited by hand. TypeDB's own TypeQL
extension also claims `.tql`. A user with both installed chooses through VS Code, or through
`files.associations`. `.typeql` is not claimed.

**D5. Pipeline labels stay plain `ID`s, and the grammar does not change.** Labels in queries resolve
editor-side: one label-resolution service reads the D3 index and serves definition, references,
hover, semantic tokens, completion and rename. Turning them into cross-references was considered and
rejected on the measured cost in the runtime (Context, row 4), for no runtime benefit.

**D6. An unknown pipeline label is a warning, and only when the workspace holds a schema.** In TypeDB
the schema lives in the database, so a query file whose workspace defines no types at all may be
perfectly correct, and says nothing. When the workspace defines at least one type, a label it does not
define is a warning, reported by the D2 `DocumentValidator`. It is never an error, because the
database may know types the workspace does not.

**D7. Editor features are proven in a real VS Code through `@vscode/test-electron`.** Tests run in the
extension host and assert through the `vscode.execute*Provider` commands, not by scraping a
rendered page. CI, when it exists, needs a virtual display (`xvfb`).

  *Corrected 2026-11-12, in Phase 01.* As accepted, this decision said the development host needed
  `libatk-bridge2.0-0` and `libsecret-1-0` installed. That was a bad measurement. The search pattern
  could not match the library's real name, `libatk-bridge-2.0.so.0`, which is installed. `libsecret`
  is absent, but VS Code runs without it, because it is only for the keychain. The e2e runs on this
  host as it is.

**D8. Upstream is the specification: `langium-vscode` at `v4.3.0`.** This repository pins
`langium@4.3.1` and `langium-cli@4.3.0`, and there is no `v4.3.1` tag. The diff:

| # | Upstream (`packages/langium-vscode`) | Here |
| - | ------------------------------------ | ---- |
| 1 | `main: out/extension.cjs`, `type: module`, activation `onLanguage:<id>` | **Adopted** |
| 2 | `languages` entry with a `configuration` file | **Adopted.** `language-configuration.json`: `#` line comments, brackets `()` `[]` `{}`, auto-closing `"` and `'` |
| 3 | `grammars` from the generated TextMate file | **Adopted.** It is copied from `libs/language/syntaxes/` by an Nx target, and is never hand-written or committed. **Amended 2026-11-13:** Langium's generator gave every keyword one scope, so themes drew `define`, `entity`, `string` and `@key` alike. `libs/language/scripts/generate-textmate.mts` now writes the file instead. It takes the keywords from the Langium grammar, as Langium's generator does, and scopes each by kind (`typeqlite-textmate.ts`), with the scopes TypeDB's TypeQL grammar uses, so a theme colors both alike. A keyword with no scope fails generation. A second, hand-written grammar injects it into Markdown fences, for the Markdown editor |
| 4 | Two esbuild entries (extension and language server), CommonJS, `external: ['vscode']`, sourcemaps unless minified | **Adopted.** `target` follows VS Code's Node rather than upstream's `ES2017` |
| 5 | Client over `TransportKind.ipc`, with a debug server on `--inspect=6009` (`DEBUG_BREAK`, `DEBUG_SOCKET`) | **Adopted** |
| 6 | `documentSelector: [{ scheme: 'file', language }]` | **Adopted** |
| 7 | `deactivate()` stops the client | **Adopted** |
| 8 | Server: `createConnection(ProposedFeatures.all)`, `NodeFileSystem`, `startLanguageServer(shared)` | **Adopted**, over `createTypeQLiteServices` |
| 9 | `vscode-languageclient ~10.0.0`, `vscode-languageserver ~10.0.0`, `@types/vscode ~1.91.0`, `engines.vscode ^1.91.0`, `@vscode/vsce ~3.9.2`, `esbuild ~0.28.1` | **Adopted.** `@typedblite/language` and `@typedblite/runtime` (for ADR-004's `Diagnostic` type) both move to `vscode-languageserver ~10.0.1`, the version `langium@4.3.1` uses, so there is one copy |
| 10 | `vsce.dependencies: false` and a `.vscodeignore` | **Adopted.** The bundle is self-contained |
| 11 | `WorkspaceManager` subclass and a `build.ignorePatterns` setting | **Deferred.** The default already skips `node_modules`, `out` and dot-folders |
| 12 | Railroad-diagram command and webview | **Declined.** TypeQLite is not a grammar language |
| 13 | `jsonValidation` for `langium-config.json`, and the config handler | **Declined.** Nothing here has a configuration file to validate |
| 14 | Icon, gallery banner, publisher metadata | **Icon adopted** on 2026-11-13, once the TypeDBLite logo existed (`docs/brand/`): VS Code shows it in the Extensions view and on the extension's page, with no marketplace release. The gallery banner and publisher metadata stay **declined** while there is no marketplace release |

## Consequences

### Positive

- An editor for TypeQLite exists where the language is defined, and every rule it shows comes from
  `@typedblite/language`.
- D2 makes "does this editor feature change the runtime?" a question with a mechanical answer: is it
  registered in `ValidationRegistry`?
- The downstream extension can depend on this one through `extensionDependencies` and drop its own
  language server. That is its own work, not this ADR's.

### Negative / Constraints

- 🔴 **D3's limit is real.** A workspace holding two independent schemas that share a label resolves
  that label to whichever definition it finds first. The project file that would fix it is deferred
  rather than built.
- **D6 is a heuristic.** A workspace that holds part of a schema warns on labels from the part it
  lacks.
- **D7 needs a display.** On a headless CI machine, that is a virtual one.
- **Two extensions may claim `.tql`** (D4), and the user resolves it, not the extension.

## References

- [ADR-002](adr-002-typeql-engine-as-a-port.md) Decision 7: the three failure layers
- [ADR-005](adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md): the
  conformance run that proves D2 at every phase close
- [TypeQLite Editor](../planning/editor/editor.feature.md): the feature this ADR governs
- Upstream: `eclipse-langium/langium`, `packages/langium-vscode` and `examples/domainmodel` at `v4.3.0`
