# Adding a TypeQLite construct

This is the path a new piece of TypeQL takes through TypeDBLite: from grammar, through validation and
the engine, to the conformance report card. Read [Architecture](architecture.md) first if you have
not.

## Before you start: find the caller

**A construct is added only when something needs it.** TypeDBLite implements the TypeQL its
callers use, not everything TypeDB has. The rule is "find the caller first". A caller is one of:

- **A scenario in TypeDB's behaviour specification** that fails because the construct is missing.
  This is the most common caller. Run the report card (`nx run typedblite-conformance:report`) and
  look at the failure digest.
- **A real schema or query** that someone needs to run, in an issue or a pull request.

Write the caller down in your pull request. It is what justifies the change, and it becomes the
first test.

If you are not sure what TypeDB does with an edge case, ask TypeDB itself: run the scenario through
the [TypeDB oracle](testing.md#the-typedb-oracle).

## 1. The grammar

Edit [`libs/language/src/typeqlite.langium`](../../libs/language/src/typeqlite.langium). It is a
[Langium](https://langium.org/docs/reference/grammar-language/) grammar, and it follows TypeQL's
syntax exactly. Where TypeDB's behaviour specification shows the syntax, follow that.

Regenerate the parser:

```bash
npm exec nx -- run typeqlite-language:langium-generate
```

`src/generated/` is build output and is not committed. The `build`, `test` and `typecheck` targets
regenerate it first. Tools that run from source, such as `tsx` and Vitest's aliases, read whatever
is in `src/generated/`, so regenerate after every grammar edit.

**Check for ambiguity.** Langium reports conflicts at generation time. If TypeDB reserves a new
keyword, add it to the `RESERVED` set in `typeqlite-validator.ts`, which
`reserved-keywords.spec.ts` covers.

Add a parse spec in `libs/language/test/`.

## 2. Validation, if the grammar accepts too much

The grammar is deliberately permissive where TypeDB's rules depend on context. Rules that the
grammar cannot express go in
[`typeqlite-validator.ts`](../../libs/language/src/typeqlite-validator.ts):

- **Give each rule a stable code** in
  [`typeqlite-validation-codes.ts`](../../libs/language/src/typeqlite-validation-codes.ts), and
  register it in `registerValidationChecks`.
- **If the construct accepts annotations,** add a row to the admissibility table in
  [`typeqlite-annotations.ts`](../../libs/language/src/typeqlite-annotations.ts).
- **Checks must be synchronous.** `validateSync` refuses a check that returns a promise.

🔴 **Every check registered here runs in the runtime too.** An `error` refuses the construct in the
engine, not just in the editor. A diagnostic that only makes sense in an editor belongs in the
editor's `DocumentValidator`, which the runtime never runs
([Architecture](architecture.md#the-language-library-serves-two-masters)).

**If the construct names a type** in a new position (for example, a new place a label can appear),
update `sitesOf` and `LABEL_POSITIONS` in
[`typeqlite-labels.ts`](../../libs/language/src/typeqlite-labels.ts). Otherwise the editor cannot
navigate, complete or rename through it.

## 3. The engine

**A schema construct** is checked in
[`schema-rules.ts`](../../libs/runtime/src/schema-rules.ts) (`define`) or
[`schema-mutation.ts`](../../libs/runtime/src/schema-mutation.ts) (`redefine` and `undefine`), and
recorded by [`sqlite-generator.ts`](../../libs/runtime/src/sqlite-generator.ts).
- If it needs storage, add a new `schema_*` table with `CREATE TABLE IF NOT EXISTS`. Do not change
  an existing table's shape: existing stores must keep opening.

**A query construct** is handled in
[`interpreter.ts`](../../libs/runtime/src/interpreter.ts), usually in two places:
- **`planStage`**, which checks the construct statically and records what it binds. Refuse here,
  before any row is read, wherever you can.
- **`runStages`** and `combinations()`, which run it.

A value expression belongs in [`expressions.ts`](../../libs/runtime/src/expressions.ts), a reducer in
[`reduce.ts`](../../libs/runtime/src/reduce.ts), and a `fetch` shape in
[`fetch.ts`](../../libs/runtime/src/fetch.ts).

**Rules for engine code:**
- **Synchronous.** No `async` in the interpreter.
- **SQLite only through the `SqliteDatabase` interface.** Never import `node:sqlite` outside
  `node-sqlite.ts`.
- **Refuse with a `DiagnosticCode`,** through `this.refuse(code, message, range)`, never a plain
  `Error`. Messages should say what to do. Where TypeDB has an error code (such as `[CNT9]`), use its
  wording.
- **Handle the whole construct or refuse the rest by name.** A partial implementation that silently
  ignores an unsupported variant breaks the [fail-loud rule](architecture.md#failing-loudly-three-layers).
  Refuse it with `DiagnosticCode.notImplemented` and a message naming the gap.

## 4. Tests

- **Runtime tests** in `libs/runtime/test/` cover the behaviour, **and** each refusal by its code.
- **Run the report card:**

  ```bash
  npm exec nx -- run typedblite-conformance:test
  ```

  - If scenarios now pass, `test` fails with `⬆ above baseline`. Raise those numbers in
    `libs/conformance/baseline.json` in the same commit.
  - If a declared deviation now passes, remove it from `deviations.yaml`.
  - **No count may go down.**
- **If the editor is affected** (a new label position, a new keyword), run the extension's tests and
  its e2e: `nx run typeqlite-vscode:test` and `nx run typeqlite-vscode:e2e`.

## 5. Documentation

- Update [The TypeQLite language](../guides/typeqlite-language.md) if users can now write something
  new, or remove the construct from its list of gaps.
- If the report card changed, update [CONFORMANCE.md](../../CONFORMANCE.md) and cite the new run.
- If you made a decision a later contributor would need to know, write an ADR (see
  [Contributing](../../CONTRIBUTING.md#decisions)).

## Checklist

- [ ] The caller is named in the pull request
- [ ] Grammar changed, parser regenerated, parse spec added
- [ ] Validator rules (if any) have codes, and are meant to apply to the runtime too
- [ ] Label positions updated (if the construct names a type)
- [ ] Engine handles the construct, and refuses what it does not handle, by code
- [ ] Runtime tests for behaviour and refusals
- [ ] Report card: no regression, baseline raised, passing deviations removed
- [ ] The clean-tree gate is green ([Testing](testing.md#the-clean-tree-gate))
- [ ] The language guide and CONFORMANCE.md are up to date
