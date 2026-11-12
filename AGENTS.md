# AGENTS.md — Working in TypeDBLite

This file is for AI agents and automated tools working in this repository. It describes the layout, the invariants, and the conventions that must be respected when making changes.

---

## Repository layout

```
typedblite/
├── libs/
│   ├── language/          @typedblite/language   — grammar, AST, language services
│   ├── runtime/           @typedblite/runtime     — interpreter, SQLite generator, change log
│   ├── content-revision/  @typedblite/content-revision — revision identifiers
│   └── conformance/       typedblite-conformance  — TypeDB behaviour spec + report card
├── apps/
│   ├── cli/               typedblite-cli          — REPL and file runner
│   └── vscode/            typeqlite (extension)   — the TypeQLite editor: a Langium language server
├── test-fixtures/schemas/ — shared TypeQLite schema files used by multiple test suites
├── nx.json                — Nx task graph configuration
├── package.json           — workspace root (npm workspaces)
├── tsconfig.base.json     — shared TypeScript path aliases
└── vitest.shared.ts       — shared Vitest configuration helpers
```

## Dependency graph

```
cli → runtime → language
              → content-revision
conformance → runtime
vscode → language
```

Build order is enforced by Nx. `runtime` must build before `cli` and `conformance`. `language` and `content-revision` must build before `runtime`.

---

## Build and test commands

Always run from the workspace root.

```bash
# Build everything (respects dependency order)
npm run build

# Test everything
npm run test

# Type-check everything
npm run typecheck

# Single package — replace <target> with the package name from package.json
nx run <target>:build
nx run <target>:test
nx run <target>:typecheck
```

Package names:
- `@typedblite/language`
- `@typedblite/runtime`
- `@typedblite/content-revision`
- `typedblite-conformance`
- `typedblite-cli`
- `typeqlite` (the VS Code extension, Nx project `typeqlite-vscode`)

Coverage is enabled only on CI (`CI=true`). Test suites time out at 30 seconds per test.

---

## Language and grammar

The TypeQLite grammar is in [libs/language/src/typeqlite.langium](libs/language/src/typeqlite.langium). It is a [Langium](https://langium.org) grammar.

**To regenerate the AST after a grammar change:**

```bash
cd libs/language
npm run langium:generate
```

This regenerates `src/generated/ast.ts`, `src/generated/grammar.ts`, and `src/generated/module.ts`. `src/generated/` is gitignored: the `build`, `test` and `typecheck` targets regenerate it first (`langium-generate`), so commit the grammar, not the output.

**Grammar scope discipline.** A construct is added to the grammar only when a real caller needs it. The rule is "find the caller first". The TypeDB behaviour spec (`libs/conformance/spec/`) is a first-class caller — if the spec's Background steps require a construct, add it.

**Annotation admissibility.** Which annotations are valid on which positions is tracked in the validator's admissibility table (`typeqlite-annotations.ts`). `@key` is enforced at write time by the runtime. All other annotations parse successfully, but their runtime semantics are tracked scenario-by-scenario on the conformance report card.

---

## Runtime

### SQLite binding contract

The interpreter works through a `SqliteDatabase` interface (`libs/runtime/src/sqlite-database.ts`), not against `node:sqlite` directly. Only `node-sqlite.ts` imports `node:sqlite`. When adding a new SQLite operation, add it to the interface and implement it in `node-sqlite.ts`.

Key constraints:
- **Synchronous**. The interpreter runs ~250 SQLite calls inside transactions. No async binding satisfies the interface.
- **Named parameters without prefix.** `.all({ id })` binds `:id`. Adapters that require `{ ':id': id }` must translate.
- **`run()` must report `changes` exactly.** The change log uses `changes > 0` to decide whether a revision was new.
- **`exec` must handle multiple statements** in a single string (schema DDL uses this).

### Schema and data

The SQLite schema is generated from a TypeQLite `define` statement by `sqlite-generator.ts`. The interpreter in `interpreter.ts` translates TypeQLite queries to SQLite.

TypeQLite entities become rows in a table named after the entity type. Attributes become columns. Relations become junction tables. `@key` generates a `UNIQUE` index.

### Change log and replication

Every write appends to a change log. Revisions are `generation-digest` strings (`@typedblite/content-revision`). The revision is derived deterministically from content, so the same edit on two nodes produces the same revision and converges rather than conflicting.

The hub exposes Server-Sent Events for spokes to subscribe to. The `ChangeStream` interface (`change-stream.ts`) is the hub's side. `ChangeStreamClient` (`change-stream-client.ts`) is the spoke's side.

**Do not change the revision algorithm** in `content-revision/src/lib/revision.ts` without running the parity oracle (`nx run typedblite-runtime:test-oracle`). That oracle proves the semantics against real CouchDB 3.4.3.

---

## Conformance

`libs/conformance/` vendors the TypeDB behaviour specification as Cucumber `.feature` files under `spec/`. The test suite (`test/conformance.test.ts`) runs every scenario and compares against `baseline.json`.

### Deviations

Intentional failures are declared in `deviations.yaml`:
- Each entry needs an **owner**: an ADR number (`adr-NNN`) or a defect record id.
- An entry whose scenario starts passing is reported by the run as `deviationsNowPassing`. Remove it in the same commit that fixes the behaviour.
- Do not declare a deviation against a scenario that fails for a different reason (e.g. a Background step fails before the deviation is reached).

### Baseline

`baseline.json` records the last-known pass/fail count per feature file. The test fails if a scenario regresses below the baseline. Update the baseline when scenarios improve:

```bash
nx run typedblite-conformance:test
# If the run reports `unraised`, update baseline.json manually or via the CLI tool
nx run typedblite-conformance:cli -- --update-baseline
```

---

## Testing conventions

- Test files for `libs/language` live in `libs/language/test/` with `.spec.ts` extension.
- Test files for `libs/runtime` live in `libs/runtime/test/` with `.test.ts` extension.
- Test files for `apps/cli` live in `apps/cli/test/` with `.test.mts` extension.
- Test files for `apps/vscode` live in `apps/vscode/test/` (`.test.ts`, run by vitest against the built
  bundle). Its e2e (`nx run typeqlite-vscode:e2e`) packages the extension, installs the `.vsix` into a
  downloaded VS Code through `@vscode/test-electron`, and runs the cases there. It is off by default:
  run it when changing anything an editor sees. It needs a display (`xvfb-run` when headless).
- Language-service specs that involve more than one file use `libs/language/test/workspace.ts`, which
  builds several documents into one workspace with its own services and an in-memory file system.

## The editor

`apps/vscode` is a client plus a language server that runs `createTypeQLiteServices` unchanged
([ADR-008](docs/architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)).
🔴 **Nothing the editor knows may reach the runtime.** The interpreter runs every check registered in
`ValidationRegistry` (through `validateSync`), so a check registered there is a runtime rule. An
editor-only diagnostic belongs in a `DocumentValidator` subclass, which the runtime never runs. The
file extensions it claims come from `langium-config.json`, and a test fails if the manifest differs.

Labels in queries (`isa person`, `has name`, role players) are plain `ID`s, not cross-references, and
must stay so (ADR-008 D5). The editor resolves them through `TypeQLiteLabels`, whose position table
(`sitesOf`, and `LABEL_POSITIONS` for completion) must change whenever the grammar gains a position
that names a type. `nx run typeqlite-vscode:package` builds `apps/vscode/dist/typeqlite-0.0.1.vsix`.
- Shared TypeQLite schema fixtures used by multiple suites live in `test-fixtures/schemas/`.
- The runtime has an optional oracle test suite (`vitest.oracle.config.ts`) and a WASM test suite (`vitest.wasm.config.ts`), both off by default. Run them explicitly when changing the SQLite binding or the revision algorithm.

---

## Code style and conventions

- **TypeScript strict mode** throughout. No `any` without a reason documented inline.
- **ESM everywhere.** All packages use `"type": "module"`. Import paths in source use `.js` extensions (resolved to `.ts` by TypeScript's `bundler`/`NodeNext` strategy).
- **No default exports.** Named exports only.
- **No barrel re-exports of internal implementation.** Each package's `index.ts` exports only the public API.
- **Diagnostic codes** (`DiagnosticCode`) are the right way to report a schema or query problem from the runtime. Do not throw a plain `Error` for a user-visible condition that should produce a structured diagnostic.
- **Comments explain WHY, not WHAT.** A comment that restates what the code obviously does adds noise. A `🔴` marker in a comment means the note is non-obvious, was found through debugging or a spec reading, and would be easy to get wrong again.

---

## Adding a new TypeQLite construct

1. Add the production rule to `libs/language/src/typeqlite.langium`.
2. Run `npm run langium:generate` inside `libs/language/`.
3. Update the admissibility table in `typeqlite-annotations.ts` if the construct accepts annotations.
4. Add validation in `typeqlite-validator.ts` if the construct has parse-time constraints.
5. Add SQLite generation in `libs/runtime/src/sqlite-generator.ts`.
6. Add interpreter handling in `libs/runtime/src/interpreter.ts`.
7. Add tests in `libs/runtime/test/` covering the new behaviour.
8. Run the full conformance suite to check for regressions: `nx run typedblite-conformance:test`.

---

## Common mistakes to avoid

| Mistake | Why it matters |
|---|---|
| Importing `node:sqlite` outside `node-sqlite.ts` | Breaks the browser/WASM portability boundary |
| Using `async` in the interpreter's inner loop | The `SqliteDatabase` interface is synchronous by design |
| Hardcoding `:memory:` in a test | Use the fixture helpers; they create an isolated session per test |
| Declaring a deviation before the scenario's Background passes | The deviation isn't the real reason for failure yet |
| Changing revision semantics without running the parity oracle | CouchDB parity is not covered by the routine test suite |
| Editing the grammar without regenerating locally | Tools run from source (`tsx`, vitest aliases) read `src/generated/`, which only `langium-generate` refreshes |
| Adding a construct to the grammar with no caller | Grammar scope is measured, not guessed — find the caller first |
| Trusting a gate after a dependency bump without a clean build | `build` is `tsc -b`, which is incremental: a library whose sources did not change is not re-emitted, so its dependants are judged against stale declarations, even with `--skip-nx-cache`. Delete `out/` and `*.tsbuildinfo` first (the `vscode-languageserver` 10 bump hid a type error for a whole phase this way) |

---

## Working with Nx

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first — it has patterns for querying projects, targets, and dependencies
- When running tasks (build, lint, test, e2e, etc.), always prefer running through `nx` (`nx run`, `nx run-many`, `nx affected`) instead of the underlying tooling directly
- Prefix nx commands with the workspace's package manager (`npm exec nx build`) — avoids using a globally installed CLI
- You have access to the Nx MCP server and its tools; use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md` — not all plugins have this file, proceed without it if unavailable
- **Never guess CLI flags** — always check `nx_docs` or `--help` first when unsure

### Scaffolding and generators

For scaffolding tasks (creating apps, libs, project structure, setup), always invoke the `nx-generate` skill **first** before exploring or calling MCP tools.

### When to use nx_docs

- **Use for:** advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- **Don't use for:** basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally — don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
