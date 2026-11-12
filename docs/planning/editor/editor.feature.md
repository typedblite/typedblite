---
kind: feature
status: complete
decided-by: [adr-008]
title: TypeQLite Editor
feature: editor
branch: feat/editor
---

# TypeQLite Editor — Feature Doc

> **Status:** ✅ Complete, 2026-11-12 · **Written:** 2026-11-12 · **Branch:** `feat/editor`, from `main` ·
> **Governed by:** [ADR-008](../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
>
> Request, 2026-11-12: *a Langium-powered TypeQLite editor in a VS Code extension.*
>
> **A feature, not an initiative.** An initiative exists to hold a dependency graph between
> features that no single feature document can state. This work has one deliverable — an extension
> and the language-service work it needs — and its dependencies run in a straight line, which a
> phase table states fine. The one candidate that would have made it a graph, a database surface
> that *runs* queries, is [out of scope](#out-of-scope); if it is ever taken on alongside this, that
> is the point to write an initiative over both.

## Process

Per the [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md).
`feat/editor` is cut from `main`. Each phase branch, `phase/editor/<NN>-<slug>`, is cut from
`feat/editor` and merges back into it. Each phase's checklist is written when that phase starts.

## Motivation

`@typedblite/language` already holds most of what an editor needs — a grammar, a validator, a
scope provider, a formatter and semantic tokens — and **none of it reaches an editor from this
repository**. There is no extension, no language-server entry point, and no client. The
`TextMate` grammar is generated and then never used here.

An editor is also how TypeQLite is read most. Schemas are hand-written `.typeqlite` files, and
today the only feedback an author gets is from running them.

## What already exists — verified on disk 2026-11-12

Load-bearing. Re-verify before relying on it.

| Thing | State |
| ----- | ----- |
| Grammar | [`typeqlite.langium`](../../../libs/language/src/typeqlite.langium) (766 lines) + `terminals.langium`. `langium@~4.3.1`, `langium-cli@~4.3.0`, `vscode-languageserver@~9.0.1` |
| Language id and files | [`langium-config.json`](../../../libs/language/langium-config.json): id `typeqlite`, extensions `.typeqlite` and `.tql` |
| Services | [`createTypeQLiteServices`](../../../libs/language/src/typeqlite-module.ts) registers `lsp.Formatter`, `lsp.SemanticTokenProvider`, `references.ScopeProvider`, and a `SyncValidationRegistry`. 🔴 **Registering an LSP service there is all it takes to reach an editor**: `startLanguageServer` advertises the capability and the client negotiates it |
| Validator | [`typeqlite-validator.ts`](../../../libs/language/src/typeqlite-validator.ts), with 12 stable codes in [`typeqlite-validation-codes.ts`](../../../libs/language/src/typeqlite-validation-codes.ts) |
| Cross-references | **Schema only**: `sub`, `owns`, and the `relation:role` of `plays`. 🔴 **A type label in a query (`$p isa person`, `has name`) is a plain `ID`, not a reference**, so nothing can navigate from a query to the schema |
| Scope | [`TypeQLiteScopeProvider`](../../../libs/language/src/typeqlite-scope.ts) scopes a role to its relation. Re-opens (`employment relates manager;`) are gathered **from the same document only**. Nothing in the language library resolves across files |
| Formatter | [`typeqlite-formatter.ts`](../../../libs/language/src/typeqlite-formatter.ts), an `AbstractFormatter`, with [`formatter.spec.ts`](../../../libs/language/test/formatter.spec.ts) |
| Semantic tokens | [`typeqlite-semantic-tokens.ts`](../../../libs/language/src/typeqlite-semantic-tokens.ts), with [`semantic-tokens.spec.ts`](../../../libs/language/test/semantic-tokens.spec.ts) |
| TextMate | `langium generate` writes `syntaxes/typeqlite.tmLanguage.json`, which is **gitignored as build output**. A second file, `syntaxes/typeql.tmLanguage.json`, is also present and gitignored, but **nothing in `langium-config.json` generates it**. It is stale |
| Extension | **None.** No `apps/vscode`, no `server.ts`, no `language-configuration.json`, no e2e harness |
| How the runtime uses the language | [`interpreter.ts`](../../../libs/runtime/src/interpreter.ts) calls `LangiumParser.parse` and then `validateSync`, on `EmptyFileSystem`. 🔴 **It never builds a `LangiumDocument` and never links**, so the scope provider, the linker and every LSP provider are invisible to it. The validator is not |
| Downstream | downstream-app ships its own `typeqlite-vscode`, which stands up `createTypeQLiteServices` in a language server beside a database client that talks to downstream-app's own store app. That store is why the extension did not move into this repository. It contributes the same language id, plus `.typeql` |

## 🔴 The invariants every phase is bound by

**1. The validator is shared with the runtime, so it is not an editor feature.**
[ADR-002](../../architecture/adr-002-typeql-engine-as-a-port.md) Decision 7 makes the Langium
validator the middle of three failure layers, and the interpreter runs every registered check
through `validateSync`. **A rule added to `TypeQLiteValidator` at `error` severity refuses that
construct in the runtime too.** So editor intelligence — workspace resolution, unknown-label
warnings, completion, navigation — belongs in services the runtime's parse path never runs: the
index, the scope provider, the linker and the LSP providers. It must not be a validator check. The
proof is the conformance run: **1742 of 1756, unchanged at every phase close**
([ADR-005](../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).

**2. The extension never defines TypeQLite.** No hand-written TextMate grammar, no second keyword
list, no editor-side validator. Everything the editor knows comes from `@typedblite/language`.
A second source of truth about what TypeQLite means would drift from the first, and nothing would
notice.

**3. Upstream is the specification.** Langium is bootstrapped: `packages/langium-vscode` is the
extension Langium generates for its own grammar language. For the manifest, the client, the
server bundle and the debug configuration, **copy that shape at the tag matching the pinned
`langium` version**, not at `main`. Where a phase departs from it, its summary cites the upstream
file and says why.

**4. Grammar scope is caller-first** ([AGENTS.md](../../../AGENTS.md)). The editor is a real caller
for *how* an existing construct resolves. It is not a caller for any new construct.

## Goals

1. **An extension in this repository** that runs the real `createTypeQLiteServices` as a language
   server. The existing diagnostics, formatting and semantic tokens reach the editor through
   capability negotiation alone.
2. **Workspace-aware schema.** A type defined in one `.typeqlite` file resolves from another: `sub`,
   `owns`, `plays`, and re-opens across files.
3. **Navigation.** Go to definition, find references, a document outline, folding, and hover. Hover
   shows a definition's kind, its supertype, what it owns and plays, and its `@doc`.
4. **Query-side labels.** A type label in a pipeline (`isa`, `has`, `links`, a role) resolves
   against the workspace schema. That gives it definition, references, hover, resolved highlighting
   and an unknown-label warning, while staying outside the validator (invariant 1, ADR-008 D2, D6).
5. **Completion.** Grammar keywords (Langium's default), type labels from the workspace schema,
   and roles scoped to their relation.
6. **Code actions and rename.** Mechanical quick fixes keyed on the validator's stable codes, and a
   type rename that is safe across the workspace.
7. **A packaged `.vsix`**, built by an Nx target, and installed into a real editor by an e2e
   harness that asserts each of the goals above.

## Definition of done

Each item, with where it is proven. "e2e" means `nx run typeqlite-vscode:e2e`: the packaged `.vsix`,
installed into VS Code 1.146.0, 16 of 16 passing.

- [x] The built extension, installed into a real editor, shows a validator diagnostic, formats a
      document, and returns semantic tokens. *e2e (Phase 01).*
- [x] A `sub`, an `owns` and a `plays` that name a type in another workspace file resolve. Deleting
      that file turns each into an unresolved-reference diagnostic. *`workspace-scope.spec.ts`; e2e
      deletes a file on disk (Phase 02).*
- [x] Definition, references, outline, hover and folding each have a language-service spec over a
      multi-document workspace, **and** an e2e assertion. *`navigation.spec.ts`; e2e (Phase 03).*
- [x] A query label resolves to its schema definition across files. Semantic tokens tell a resolved
      label from an unresolved one, asserted through `vscode.provideDocumentSemanticTokens` in the
      extension host. *`labels.spec.ts`; e2e (Phases 04 and 07).*
- [x] In a workspace that defines types, an unknown pipeline label is a warning. In a workspace that
      defines none, it reports nothing (ADR-008 D6). *`labels.spec.ts`; the warning in e2e (Phase 04).*
- [x] Completion offers, after `owns`, the workspace's attribute types; after `relation:`, only
      that relation's roles; and the grammar's keywords where a keyword fits. *`completion.spec.ts`;
      e2e (Phase 05).*
- [x] Each quick fix has a spec showing the fixed document re-validates clean. A rename across
      files leaves every file parsing and resolving. *`edits.spec.ts`; e2e (Phase 06).*
- [x] 🔴 The conformance run is unchanged, at **1742 of 1756** with `baseline.json` untouched, and
      the runtime and CLI suites are green. *Every phase, from a clean tree since Phase 02.*
- [x] `nx run typeqlite-vscode:package` produces a `.vsix`, and the e2e installs *that* artifact
      rather than a source tree. *Phase 07.*
- [x] `AGENTS.md`'s layout and dependency graph, and the project overview memory, name the new app.
      *Phases 01 and 07.*
- [x] Build, typecheck and test are green for everything touched. *1278 tests, from a clean tree.*

## Out of scope

- **Running queries.** Result tables, browsing a live store's schema, transactions and a graph view
  are a database IDE, not an editor. That is a different product surface with its own open
  questions, and the largest of them is where the runtime executes, given that `node:sqlite` would
  have to run inside the editor's own Node. It is the natural next feature, and it would depend on
  this one's extension shell. If it is taken on, **that** is when an initiative earns its place.
- **A debugger.** The interpreter executes eagerly against SQLite. Nothing in it suspends and
  resumes. Now proposed as its own feature, [TypeQLite Debugger](../debugger/debugger.feature.md),
  which works around this without making the interpreter suspend.
- **New grammar constructs.** See invariant 4.
- **Marketplace publishing.** This involves a publisher id, the extension's display name next to
  TypeDB's own TypeQL extension, and licence review. The `.vsix` is the deliverable here.
- **A browser (web-worker) build** for vscode.dev. Langium supports it and the services already run
  on `EmptyFileSystem`, but nothing has asked for it.
- **Migrating the downstream extension.** This feature makes it *possible* for downstream-app's
  extension to depend on this one (`extensionDependencies`) and drop its own language server. Doing
  that is downstream-app's work, in that repository.

## How this gets proven

**Language services are proven against a workspace, not a string.** Every new provider gets a
spec in `libs/language/test/` that loads **several documents** into one workspace, using Langium's
own test utilities (`langium/test`). Cross-file behaviour is the feature, so a single-document
spec proves nothing about it.

**Editor claims are proven by running the editor.** A provider can pass every unit spec and still
never reach a client, for example because a capability was never advertised or a bundle missed a
module. Every item in the Definition of Done that mentions the editor goes through the e2e harness,
using the packaged `.vsix`.

**The runtime is proven unchanged by the conformance run**, at every phase close and not only at
the end (invariant 1).

## Phase Plan

| # | Phase | Status | Summary |
| - | ----- | ------ | ------- |
| 00 | [Scope, the upstream diff, and the ADR](phases/00-scope-and-adr/summary.md) | Complete | [summary](phases/00-scope-and-adr/summary.md) |
| 01 | [Extension shell: client, server, bundle, e2e harness, and existing services in the editor](phases/01-extension-shell/summary.md) | Complete | [summary](phases/01-extension-shell/summary.md) |
| 02 | [Workspace schema: cross-file resolution of schema references](phases/02-workspace-schema/summary.md) | Complete | [summary](phases/02-workspace-schema/summary.md) |
| 03 | [Navigation: definition, references, outline, hover, folding](phases/03-navigation/summary.md) | Complete | [summary](phases/03-navigation/summary.md) |
| 04 | [Query-side labels: pipeline type labels resolve against the schema](phases/04-query-labels/summary.md) | Complete | [summary](phases/04-query-labels/summary.md) |
| 05 | [Completion](phases/05-completion/summary.md) | Complete | [summary](phases/05-completion/summary.md) |
| 06 | [Code actions and rename](phases/06-code-actions-rename/summary.md) | Complete | [summary](phases/06-code-actions-rename/summary.md) |
| 07 | [Packaging: the `.vsix` target, install path, and docs](phases/07-packaging/summary.md) | Complete | [summary](phases/07-packaging/summary.md) |

Phase 00 kept the numbering. The phases after it are still a forward plan, and each checklist is written when its phase starts.

## Phase Intent

**00 — Scope, the upstream diff, and the ADR.** Complete. Every question it held is answered in
[ADR-008](../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md):
the extension lives at `apps/vscode` as `typedblite.typeqlite` (D1); nothing the editor knows reaches
the runtime (D2); one workspace is one schema (D3); the extension claims `.typeqlite` and `.tql` (D4);
pipeline labels stay plain `ID`s and resolve editor-side (D5); an unknown label is a warning only
where the workspace holds a schema (D6); the e2e runs on `@vscode/test-electron` (D7); and the
row-by-row upstream diff (D8).

**01 — Extension shell.** This phase builds the client, the server entry point that stands up
`createTypeQLiteServices`, a bundler producing CommonJS for the extension host, a
`language-configuration.json` (comments, brackets, auto-closing), the generated TextMate grammar
copied in by a target rather than by hand, and the `@vscode/test-electron` harness. The exit is
diagnostics, formatting and semantic tokens asserted in a real editor. The one change to the language
library is its `vscode-languageserver` version, moved to the one Langium uses (ADR-008 D8, row 9).

**02 — Workspace schema.** This phase adds the index that Phases 03–06 read: exported symbols for
every definition, and cross-document scope for `sub`, `owns`, `plays` and re-opens, across the whole
workspace (ADR-008 D3). 🔴 This is the first phase that touches `libs/language`, and the first in which
invariant 1 can actually break.

**03 — Navigation.** Most of this phase is Langium's defaults, made correct by Phase 02's index.
Hover is the custom part, because it composes a definition from its traits, its supertype and its
`@doc`.

**04 — Query-side labels.** One label-resolution service over the Phase 02 index, with no grammar
change (ADR-008 D5), and the unknown-label warning from a `DocumentValidator` subclass (D2, D6). The
resolved-versus-unresolved semantic-token assertion belongs here.

**05 — Completion.** Contextual completion: attribute types after `owns`, a relation's roles after
`relation:`, entity and relation types after `isa`, and keywords from the grammar.

**06 — Code actions and rename.** Quick fixes only where the fix is mechanical and the code alone
identifies it: a repeated annotation, a duplicate `owns`, an annotation the position does not admit.
Rename runs across the Phase 02 unit.

**07 — Packaging.** This phase adds an Nx `package` target producing the `.vsix`, switches the e2e
to install that artifact, documents how to install it locally, and updates `AGENTS.md`.

## Deferred

Anything a phase defers is recorded here, not only in a commit message.

- **A project file that splits one workspace into several schemas.** Phase 00 (ADR-008 D3). Picked up
  when a real workspace holds two schemas that share a label.
- **A configurable ignore-pattern setting for workspace indexing.** Phase 00 (ADR-008 D8, row 11).
  Langium's default already skips `node_modules`, `out` and dot-folders.
- **Relinking only what a change affects.** Phase 04 (`TypeQLiteDocumentBuilder`). Every document
  holding labels relinks on any change. The narrower rule, relinking only when a changed document's
  exported definitions changed, waits for a workspace large enough to feel it.
- **CI.** The repository has none. When it gets one, the e2e needs a virtual display (ADR-008 D7).

## Key Documents

- [ADR-008](../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md):
  this feature's architecture, Phase 00's output
- [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md)
- [ADR-002](../../architecture/adr-002-typeql-engine-as-a-port.md) Decision 7: the three failure
  layers. It is why the validator is off-limits to editor-only rules
- [ADR-005](../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md):
  the conformance pass count may never go down, and it is this feature's regression oracle
- [AGENTS.md](../../../AGENTS.md): grammar scope discipline, and the steps for adding a construct
- [`libs/language/README.md`](../../../libs/language/README.md): what the language package already
  provides
