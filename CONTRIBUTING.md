# Contributing to TypeDBLite

Thank you for your interest in TypeDBLite. This guide explains how to set up the project, how
changes are made, and what a pull request needs before it can be merged.

- [Ways to contribute](#ways-to-contribute)
- [Setting up](#setting-up)
- [Making a change](#making-a-change)
- [The checks every change passes](#the-checks-every-change-passes)
- [Pull requests](#pull-requests)
- [Code conventions](#code-conventions)
- [Decisions](#decisions)
- [Larger features](#larger-features)
- [Reporting bugs](#reporting-bugs)
- [Licence](#licence)

## Ways to contribute

- **Report a bug.** Especially a query that TypeDB answers one way and TypeDBLite another. See
  [Reporting bugs](#reporting-bugs).
- **Close a conformance gap.** [CONFORMANCE.md](CONFORMANCE.md) lists every scenario of TypeDB's
  specification that does not pass, with the reason.
- **Implement a construct you need.** See [Adding a TypeQLite construct](docs/development/adding-a-construct.md).
- **Improve the documentation.** If something in [docs/](docs/README.md) was wrong or unclear, that
  is a bug worth fixing.

For anything larger than a bug fix, please open an issue first to agree the approach. TypeDBLite
adds TypeQL constructs only when there is a real caller for them, and an issue is where that caller
is named.

## Setting up

You need **Node.js 22.16 or later** (the project is developed on Node 24) and **npm**. Linux, macOS and
Windows all work: the gate has passed on Linux (Node 22.16, 22 and 24), Windows and macOS (Node 24).

> **GitHub Actions is off for now** (the account's billing needs attention), so nothing on GitHub checks a
> pull request. **Run `npm run gate` before you open one** and put its result in the description. It runs the
> one Node and OS you have, so a change that touches paths, child processes, file handles or Node-version
> behaviour is worth trying on another if you can. The workflows are written and will be turned back on.

```bash
git clone https://github.com/dave-jackson-dev/typedblite.git
cd typedblite
npm install
npm run build
npm test
```

The repository is an [Nx](https://nx.dev) workspace using npm workspaces. Run tasks through Nx
from the repository root:

```bash
npm exec nx -- run <project>:<target>
```

| Project | Path | Targets |
| ------- | ---- | ------- |
| `typeqlite-language` | `libs/language` | `build`, `test`, `typecheck`, `langium-generate` |
| `content-revision` | `libs/content-revision` | `build`, `test`, `typecheck` |
| `typedblite-runtime` | `libs/runtime` | `build`, `test` |
| `typedblite-conformance` | `libs/conformance` | `build`, `test`, `typecheck`, `report` |
| `typedblite` (CLI) | `apps/cli` | `build`, `test`, `typecheck` |
| `typeqlite-vscode` | `apps/vscode` | `build`, `test`, `typecheck`, `package`, `e2e` |
| `sync-demo` | `apps/sync-demo` | `build`, `test`, `typecheck`, `smoke`, `test-browser`, `serve`, `demo`, `android-*` |

For VS Code, the repository includes launch configurations. **Run TypeQLite Editor** starts a second
window with the extension loaded from source.

Start with [Architecture](docs/development/architecture.md) for a map of the code.

## Making a change

1. **Branch from `main`.** Name the branch for its purpose: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
2. **Write the test first** where you can. For a bug, that means a test that fails for the reason
   in the report.
3. **Make the change.** Keep a pull request to one concern.
4. **Run the checks** below.
5. **Commit** with a [Conventional Commits](https://www.conventionalcommits.org) message, scoped to
   the package. Examples from the history: `fix(runtime): …`, `feat(language): …`,
   `docs(debugger): …`, `chore: …`. The body says *why*.

## The checks every change passes

**1. The gate, from a clean tree.**

```bash
npm run gate
```

It deletes the build output first, because the incremental build can hide type errors from stale
declarations ([Testing](docs/development/testing.md#the-clean-tree-gate)), then runs the build, the
type-check, the tests **with the 80% coverage floor**, the WASM suite, the browser suite and the VS Code e2e.
Each step stops the gate at the first failure and says which. `npm run gate -- --quick` stops after the tests,
for a change that cannot touch the engine's WASM build or the editor. The last three suites need Playwright's
Chromium (`npx playwright-core install chromium`) and a display (`xvfb-run` on a headless machine).

**2. No conformance regression.** `npm test` includes the report card, which fails if any feature's
passing count drops below `libs/conformance/baseline.json`. If your change makes more scenarios
pass, raise the baseline in the same commit. Never lower it.

**3. The editor, if you touched it.** A change to the language library's providers, the grammar, or
`apps/vscode` also needs `npm exec nx -- run typeqlite-vscode:e2e`. It needs a display, so use
`xvfb-run` when headless.

## Pull requests

A pull request description says:

- **What changed, and why.** For a new construct, name its caller: the specification scenario or
  the real query that needs it.
- **How it was tested.** Name the tests you added, and show the gate's result.
- **Conformance,** if the numbers moved: before and after.
- **Anything a reviewer should look at closely,** and anything you deliberately left out.

Update the documentation in the same pull request: [the language guide](docs/guides/typeqlite-language.md)
for new syntax, [CONFORMANCE.md](CONFORMANCE.md) for new numbers, and a package README for a new
API.

**Merging.** A pull request is merged with a **merge commit**. It is never squashed or rebased, so each
of its commits stays in the history under its own hash and message. That is why the commits matter:
write each one as you would want to read it later, with a Conventional Commits message that says *why*.

## Code conventions

- **TypeScript in strict mode.** Avoid `any`; where it is unavoidable, say why in a comment.
- **ESM throughout.** Import paths in source end in `.js`.
- **Named exports only.** A package's `index.ts` exports its public API and nothing else.
- **The interpreter is synchronous.** Do not introduce `async` into it.
- **Only `node-sqlite.ts` imports `node:sqlite`.** Everything else goes through `SqliteDatabase`.
- **Fail loudly.** A user-visible problem is a structured diagnostic with a `DiagnosticCode`, not a
  plain `Error`, and never a silent no-op. Something unsupported is refused by name.
- **Validator rules are runtime rules.** Only register a check in `ValidationRegistry` if the
  engine should refuse that construct too. Editor-only checks go in the editor's
  `DocumentValidator`.
- **Comments explain why, not what.** A `🔴` marks a note that is non-obvious, was learned the hard
  way, and would be easy to get wrong again. Keep them, and add your own when you learn something
  that way.

## Decisions

A decision that shapes the code beyond one change, and that a later contributor would otherwise
re-argue, is recorded as an **architecture decision record** in
[docs/architecture/](docs/architecture/). Copy the shape of an existing ADR. Give it the next
number, a status (`Proposed` until it is accepted), and the context, the decision, the alternatives
rejected, and the consequences. Cite it from the code it governs: `// ADR-009 Decision 2`.

An ADR is amended, not silently edited. When a decision changes, add a dated amendment that says
what changed and why, and leave the original text readable.

## Larger features

Work that spans several pull requests follows the
[Multi-Phase Lifecycle Standard](docs/standards/governance/multi-phase-lifecycle-standard.md):
- a feature document in `docs/planning/<feature>/`;
- a feature branch, with one branch per phase;
- a checklist written when each phase starts, and a summary written when it ends.

[The editor's feature document](docs/planning/editor/editor.feature.md) is a complete example.

## Reporting bugs

Open an issue with:

- **The TypeQLite** that shows the problem: the schema, the data, and the query. The smaller, the
  better.
- **What you expected, and what happened.** Include the diagnostic code and message, if there is one.
- **What TypeDB does,** if you know. TypeDB's behaviour is the definition of correct here. If you
  have Docker, the [TypeDB oracle](docs/development/testing.md#the-typedb-oracle) can run your
  case against a real TypeDB.
- Your Node.js version and operating system.

Please report security vulnerabilities privately, through GitHub's private vulnerability reporting
for this repository, not in a public issue.

## Licence

TypeDBLite is licensed under the [Mozilla Public License 2.0](LICENSE). By contributing, you agree
that your contribution is licensed under the same terms.

The files in `libs/conformance/spec/` are TypeDB's behaviour specification, also under MPL-2.0, and
keep their own headers. Do not edit them.

---

AI agents and automated tools: [AGENTS.md](AGENTS.md) condenses these rules.
