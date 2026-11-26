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
- [Sign your commits (DCO)](#sign-your-commits-dco)
- [License](#license)

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

> **CI runs on every pull request** and every push to `main`: build, type-check and tests on Linux (Node 22.16, 22 and
> 24), Windows and macOS, the clean-room install, the conformance report, and the WASM, browser, coverage and VS Code
> e2e jobs. **Run `npm run gate` before you open one** and put its result in the description: it also runs the
> playground, sync-demo and website checks and the five-minute tour from the packed tarballs, which CI does not.

```bash
git clone https://github.com/typedblite/typedblite.git
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
| `typedblite-node-host` | `libs/node-host` | `build`, `test`, `typecheck` |
| `typedblite-conformance` | `libs/conformance` | `build`, `test`, `typecheck`, `report` |
| `typedblite` (CLI) | `apps/cli` | `build`, `test`, `typecheck` |
| `typeqlite-vscode` | `apps/vscode` | `build`, `test`, `typecheck`, `package`, `e2e` |
| `sync-demo` | `apps/sync-demo` | `build`, `test`, `typecheck`, `smoke`, `test-browser`, `serve`, `demo`, `android-*` |
| `playground` | `apps/playground` | `build`, `test`, `typecheck`, `test-browser`, `serve` |
| `website` | `apps/website` | `build-site`, `check`, `dev`, `serve`, `prepare` |

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
type-check, the package contents (`npm run check-packages`), the API (`npm run check-api`), the tests **with the 80% coverage floor**, the WASM
suite, the browser suites (the engine's, and the playground's), the VS Code e2e, the clean-room install
(`npm run clean-room`), and the five-minute tour (`npm run tour`).
Each step stops the gate at the first failure and says which. `npm run gate -- --quick` stops after the tests,
for a change that cannot touch the engine's WASM build, the editor or the packaging. The last three suites need Playwright's
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

**A breaking change** to anything [Versions and compatibility](docs/guides/compatibility.md) covers (the API,
the language, diagnostic codes, stores, revisions, the CLI's flags or the requirements) is listed in
`CHANGELOG.md` under **Changed**, marked **Breaking**, with what a user must do. Say so in the pull request too.

## Releases

The npm packages are released together, at one version, with **Nx release**. A maintainer makes a release:
the changelog section and `nx release version` on a branch, merged as a pull request, then a tag on `main`
that the release workflow publishes. [Releasing](docs/development/releasing.md) has the steps and the checks.

## Code conventions

- **TypeScript in strict mode.** Avoid `any`; where it is unavoidable, say why in a comment.
- **ESM throughout.** Import paths in source end in `.js`.
- **Named exports only.** A package's entry point exports its public API and nothing else, by name. Something
  public only so another module of the package can call it is marked `@internal` in its doc comment.
  `npm run check-api` checks that every type the API mentions is exported.
- **The interpreter is synchronous.** Do not introduce `async` into it.
- **Only `node-sqlite.ts` imports `node:sqlite`.** Everything else goes through `SqliteDatabase`.
- **Fail loudly.** A user-visible problem is a structured diagnostic with a `DiagnosticCode`, not a
  plain `Error`, and never a silent no-op. Something unsupported is refused by name.
- **Validator rules are runtime rules.** Only register a check in `ValidationRegistry` if the
  engine should refuse that construct too. Editor-only checks go in the editor's
  `DocumentValidator`.
- **Comments explain why, not what.** A `🔴` marks a note that is non-obvious, was learned the hard
  way, and would be easy to get wrong again. Keep them, and add your own when you learn something
  that way. On an exported name, put the note under `@privateRemarks`: the API reference leaves that tag out,
  and `npm run check-api` fails if a `🔴` or `⚠️` note would show there.

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
- **What TypeDB does,** if you know. TypeDB's behavior is the definition of correct here. If you
  have Docker, the [TypeDB oracle](docs/development/testing.md#the-typedb-oracle) can run your
  case against a real TypeDB.
- Your Node.js version and operating system.

Please report security vulnerabilities privately, through GitHub's private vulnerability reporting
for this repository, not in a public issue.

## Sign your commits (DCO)

Every commit in a pull request is signed off, to certify the [Developer Certificate of Origin](DCO): that you wrote
the change, or otherwise have the right to submit it under the project's license. There is no contributor license
agreement.

```bash
git commit -s                        # adds: Signed-off-by: Your Name <you@example.com>
```

The name and email are your Git `user.name` and `user.email`, and the sign-off must match the commit's author. To sign
off commits you have already made:

```bash
git rebase --signoff main && git push --force-with-lease
```

Merge commits need no sign-off.

## License

TypeDBLite is licensed under the [Mozilla Public License 2.0](LICENSE). By contributing, you agree
that your contribution is licensed under the same terms.

The files in `libs/conformance/spec/` are TypeDB's behavior specification, also under MPL-2.0, and
keep their own headers. Do not edit them.

---

AI agents and automated tools: [AGENTS.md](AGENTS.md) condenses these rules.
