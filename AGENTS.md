# AGENTS.md — Working in TypeDBLite

This file is for AI agents and automated tools working in this repository. It describes the layout, the invariants, and the conventions that must be respected when making changes.

---

## Repository layout

```
typedblite/
├── packages/
│   ├── language/          @typedblite/language   — grammar, AST, language services
│   ├── runtime/           @typedblite/runtime     — interpreter, SQLite generator, change log
│   ├── content-revision/  @typedblite/content-revision — revision identifiers
│   └── conformance/       typedblite-conformance  — TypeDB behaviour spec + report card
├── apps/
│   └── cli/               typedblite-cli          — REPL and file runner
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

Coverage is enabled only on CI (`CI=true`). Test suites time out at 30 seconds per test.

---

## Language and grammar

The TypeQLite grammar is in [packages/language/src/typeqlite.langium](packages/language/src/typeqlite.langium). It is a [Langium](https://langium.org) grammar.

**To regenerate the AST after a grammar change:**

```bash
cd packages/language
npm run langium:generate
```

This regenerates `src/generated/ast.ts`, `src/generated/grammar.ts`, and `src/generated/module.ts`. Commit the regenerated files alongside the grammar change.

**Grammar scope discipline.** A construct is added to the grammar only when a real caller needs it. The rule is "find the caller first". The TypeDB behaviour spec (`packages/conformance/spec/`) is a first-class caller — if the spec's Background steps require a construct, add it.

**Annotation admissibility.** Which annotations are valid on which positions is tracked in the validator's admissibility table (`typeqlite-annotations.ts`). `@key` is enforced at write time by the runtime. All other annotations parse successfully, but their runtime semantics are tracked scenario-by-scenario on the conformance report card.

---

## Runtime

### SQLite binding contract

The interpreter works through a `SqliteDatabase` interface (`packages/runtime/src/sqlite-database.ts`), not against `node:sqlite` directly. Only `node-sqlite.ts` imports `node:sqlite`. When adding a new SQLite operation, add it to the interface and implement it in `node-sqlite.ts`.

Key constraints:
- **Synchronous**. The interpreter runs ~250 SQLite calls inside transactions. No async binding satisfies the interface.
- **Named parameters without prefix.** `.all({ id })` binds `:id`. Adapters that require `{ ':id': id }` must translate.
- **`run()` must report `changes` exactly.** The change log uses `changes > 0` to decide whether a revision was new.
- **`exec` must handle multiple statements** in a single string (schema DDL uses this).

### Schema and data

The SQLite schema is generated from a TypeQLite `define` statement by `sqlite-generator.ts`. The interpreter in `interpreter.ts` translates TypeQLite queries to SQLite.

TypeQL entities become rows in a table named after the entity type. Attributes become columns. Relations become junction tables. `@key` generates a `UNIQUE` index.

### Change log and replication

Every write appends to a change log. Revisions are `generation-digest` strings (`@typedblite/content-revision`). The revision is derived deterministically from content, so the same edit on two nodes produces the same revision and converges rather than conflicting.

The hub exposes Server-Sent Events for spokes to subscribe to. The `ChangeStream` interface (`change-stream.ts`) is the hub's side. `ChangeStreamClient` (`change-stream-client.ts`) is the spoke's side.

**Do not change the revision algorithm** in `content-revision/src/lib/revision.ts` without running the parity oracle (`nx run typedblite-runtime:test-oracle`). That oracle proves the semantics against real CouchDB 3.4.3.

---

## Conformance

`packages/conformance/` vendors the TypeDB behaviour specification as Cucumber `.feature` files under `spec/`. The test suite (`test/conformance.test.ts`) runs every scenario and compares against `baseline.json`.

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

- Test files for `packages/language` live in `packages/language/test/` with `.spec.ts` extension.
- Test files for `packages/runtime` live in `packages/runtime/test/` with `.test.ts` extension.
- Test files for `apps/cli` live in `apps/cli/test/` with `.test.mts` extension.
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

1. Add the production rule to `packages/language/src/typeqlite.langium`.
2. Run `npm run langium:generate` inside `packages/language/`.
3. Update the admissibility table in `typeqlite-annotations.ts` if the construct accepts annotations.
4. Add validation in `typeqlite-validator.ts` if the construct has parse-time constraints.
5. Add SQLite generation in `packages/runtime/src/sqlite-generator.ts`.
6. Add interpreter handling in `packages/runtime/src/interpreter.ts`.
7. Add tests in `packages/runtime/test/` covering the new behaviour.
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
| Generating the AST without committing the result | Other packages import the generated files; a stale AST causes build failures |
| Adding a construct to the grammar with no caller | Grammar scope is measured, not guessed — find the caller first |
