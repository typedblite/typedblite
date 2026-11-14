# TypeDBLite — Open Source Launch Plan

Status: in progress · Written 2026-11-14 · Basis: a read of the repository at `main` (`77f98c3`); [where to resume](#where-to-resume) is current as of `82deabb`

This plan takes TypeDBLite from "a strong repository" to "a project strangers can install, trust, and
contribute to." It is organised as gates, not dates: each phase has exit criteria, and the launch
happens when the gates are green. A suggested calendar is at the end.

- [Where to resume](#where-to-resume)
- [1. Where we are](#1-where-we-are)
- [2. Goals and non-goals](#2-goals-and-non-goals)
- [3. Positioning and audience](#3-positioning-and-audience)
- [4. Readiness audit](#4-readiness-audit)
- [5. Phases](#5-phases)
- [6. Launch assets](#6-launch-assets)
- [7. Launch day runbook](#7-launch-day-runbook)
- [8. Community and governance](#8-community-and-governance)
- [9. Metrics](#9-metrics)
- [10. Risks](#10-risks)
- [11. Calendar](#11-calendar)
- [12. Decisions needed](#12-decisions-needed)
- [Parking lot](#parking-lot)

---

## Where to resume

*As of 2026-11-14, `main` at `82deabb`.* Read this first; everything it points to is below.

**Merged to `main`** (PR #22, PR #33): CI (Ubuntu on Node 24, 22 and the 22.16.0 minimum; macOS; Windows; conformance
report; coverage; WASM and browser; VS Code e2e; PR-title check; label sync), the community files (`SECURITY.md`,
`CHANGELOG.md`, `CODEOWNERS`, Dependabot, issue forms, PR template), `.gitattributes`, and the fixes CI found: a
lockfile pointing at a local registry, `langium-cli` failing on Node 24.22+, a wrong Node minimum (now 22.16), a
Windows-only build command, a fixed-wait test, and a Langium race that dropped a document's diagnostics (see 1.1).

**Verified on GitHub** (push run on `main`, `82deabb`): all three Ubuntu gates, macOS, VS Code e2e, WASM and browser
(3 tests in a real Chromium) and the conformance report pass; the label sync corrected the three truncated labels;
the PR-title check works. **Not** verified: that the Node 22 gate is stable. It failed once on `main` from the race
and passed after the fix, but one clean run proves little; the evidence for the fix is the before/after replays and
the regression test (`libs/language/test/diagnostics-published.spec.ts`).

**Merging:** merge commits only, never squash or rebase, so each commit keeps its own history (the maintainer's rule,
2026-11-14). PRs #22 and #33 were squashed before that rule; their original commits are still on GitHub at
`refs/pull/22/head` (`904fb2b`) and `refs/pull/33/head` (`a7557e1`), and are not on any branch.

**Known and left alone:** coverage is under the 80% floor in four projects (`CI=true` switches the floor on; the
blocking gate runs with `CI` empty); 11 tests fail on Windows (1.2), so Windows is experimental.

**Only the maintainer can do these:**

1. **Send the written confirmation to TypeDB Ltd** (B1). The draft is deliberately not in this repository. Get a
   one-line written reply before any announcement.
2. **Branch protection on `main`.** Require `gate (ubuntu-latest, node 24)`, `gate (ubuntu-latest, node 22)`,
   `gate (ubuntu-latest, node 22.16.0)`, `conformance report` and `conventional-commit`. Then `vscode e2e`,
   `wasm and browser` and `gate (macos-latest, node 24)`. Allow merge commits only (no squash, no rebase), so each
   commit keeps its own history.
3. **Repository settings:** Discussions, private vulnerability reporting, secret scanning with push protection,
   Dependabot alerts.
4. **`CODE_OF_CONDUCT.md`:** Insights, Community Standards, Add (inserts the official Contributor Covenant text).
5. **Decisions:** Windows (fix the 11 tests, or document as unsupported for launch), the coverage policy (decision 9),
   and whether `downstream-app` stays named in the docs (S3, decision 5).

**Next work, in order:** the hub security review (B6); Phase 2 packaging (claim the unscoped `typedblite` and
`typeqlite` npm names; take `private` off the CLI; publish `0.1.0-rc.1` under `next` with provenance; the clean-room
install test on three platforms); Phase 3 docs and the playground. Parked, and not blocking the flip to public: PL-2 to PL-5 in the
[parking lot](#parking-lot) (the Langium report, keeping the old PR commits, a commit-message check, watching CI on `main`).

**Before the repository goes public:** the repository is **private** (maintainer, 2026-11-14), and this plan names the
TypeDB Ltd conversation. That is parked as [PL-1](#parking-lot), and the "flip the repo to public" step in Phase 4 is
blocked on it.

**Resuming locally:** Node 22.16 or later, then `git checkout main && git pull && npm ci && npm run build && npm test`.
Useful to know:
- `CI=true` turns on the coverage floor. Run with `CI=` to match the blocking gate.
- A workflow run shows "success" even when an experimental job (Windows, coverage, WASM and browser, e2e, macOS)
  fails. Read the jobs, not the run.
- A push cancels CI that is still running on the same ref, so push once the run you care about has finished.
- `apps/vscode` and the language server share `libs/language`; the Langium override in
  `TypeQLiteDocumentBuilder.notifyDocumentPhase` must be re-checked on any Langium upgrade.

---

## 1. Where we are

**Real strengths — lead with these.**

| Strength | Evidence |
| --- | --- |
| Measured compatibility, not claimed | 1,742 of 1,756 scenarios in TypeDB's own behaviour spec pass (99.2%). 12 of the 14 non-passing also fail on TypeDB 3.10.4 itself ([CONFORMANCE.md](../../../CONFORMANCE.md)) |
| Runs where a server can't | Node (`node:sqlite`), browsers (WASM SQLite, ADR-009), any binding satisfying `SqliteDatabase` |
| A working end-to-end story | Offline-first sync demo: browser, desktop and Android, converging through a hub |
| Editor tooling | VS Code extension with a Langium language server |
| Honest engineering record | Ten ADRs, a documented load test with before/after numbers, declared deviations with owners |
| Clean licensing posture | MPL-2.0, matching TypeDB; upstream attribution and trademark notice already in the README |

**Not yet release-shaped.** Everything at version `0.0.1`; no git tags or releases; no CI workflow files
(`.github/workflows/` does not exist); the CLI, VS Code extension and conformance package are
`"private": true`; no `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, or issue/PR templates. Details
in [section 4](#4-readiness-audit).

## 2. Goals and non-goals

**Goals (first 90 days)**

1. A stranger goes from the README to a first successful query in **under 5 minutes** (no clone needed).
2. Packages are installable from npm and the editor from the VS Code Marketplace and Open VSX.
3. At least **10 external issues and 3 external pull requests** — evidence that people can contribute.
4. TypeDB's community knows about the project, from us, and on good terms.
5. A visible, public roadmap and a conformance number people can verify themselves.

**Non-goals**

- Star count as the target. It follows from the above; it isn't steered directly.
- Claiming to replace TypeDB. The pitch is *embedded and browser contexts where a server is impractical*.
- Stability promises beyond what exists. Launch at `0.x` with a clear compatibility policy.

## 3. Positioning and audience

**One-line pitch (draft):** *TypeDB's data model and TypeQL, embedded: a TypeScript engine on SQLite that
runs in Node and the browser, and passes 99.2% of TypeDB's own behaviour spec.*

**Audiences, in priority order**

| # | Audience | What they want | Where they are | First thing to show them |
| --- | --- | --- | --- | --- |
| 1 | TypeDB users and evaluators | A local/dev/test instance with no server; a TypeQL they already know | TypeDB Discord, forum, GitHub discussions | The conformance report, and `--exec` in one line |
| 2 | Local-first / offline-first developers | Typed graph data that syncs | Local-First Web community, HN, lobste.rs | The sync demo with the network cut |
| 3 | TS/JS developers wanting a graph DB without ops | `npm install` and go | r/typescript, dev.to, X/Bluesky | Browser playground |
| 4 | Language-tooling people | A worked Langium language server | Langium discussions, VS Code extension authors | ADR-008 and the extension |

**Messaging rules**

- Lead with the *use case*, not the thanks. Move "Special Thanks to TypeDB" below a short value section
  in the README (it stays, prominently, but second). Attribution is a strength; it shouldn't be the
  first screen.
- Every compatibility claim cites a run (the project's own Conformance Standard requires this).
- Say what is not supported yet, early. The language guide's annotation table is a model of this.
- Never imply endorsement by TypeDB Ltd. Keep the Independence paragraph.

## 4. Readiness audit

Findings from reading the repository. **Verified** = confirmed in the files. **To check** = I did not
confirm it and it needs someone to.

### 4.1 Blockers (must be resolved before announcing)

| # | Finding | Status | Action |
| --- | --- | --- | --- |
| B1 | **The name contains TypeDB™.** The README handles attribution well, but a project name that includes another company's mark is the single largest launch risk | **Verbal blessing received** from TypeDB Ltd's CEO (video call, 2026-11) | **Get it in writing.** Send a short follow-up email restating what was agreed (open-source release under the name TypeDBLite, the `@typedblite` scope and `typedblite.dev`, MPL-2.0, the independence statement) and ask for a one-line confirmation reply. Keep the reply with the project records. Read the published trademark policy once to check that the agreement and the policy don't conflict. A verbal OK is good faith; a written one is what survives a change of staff or a rebrand |
| B2 | **No CI.** `.github/workflows/` was absent, so contributors' PRs would get no checks | Verified | **Workflows written (Phase 1); not yet run on GitHub.** Running the gate also found a broken lockfile and failing coverage thresholds (1.1) |
| B3 | **Nothing is published.** No tags, no releases, no npm packages, CLI is private | Verified | Phase 2 |
| B4 | **npm and domain names.** `@typedblite` (npm org) and `typedblite.dev` are **registered (2026-11-14)**. Still to confirm: the unscoped `typedblite` (the CLI's name) and `typeqlite`, which the scope does not cover | Partly done | Check both unscoped names on npm and claim them (publish a placeholder or `0.0.0` under the org if free). Note that the domain, like the name, contains TypeDB™, so B1 covers it too |
| B5 | **`node:sqlite` vs `engines`.** `engines` said Node `>=22.12`. Measured: 22.12 has **no** `node:sqlite`; 22.13 to 22.15 have it **without FTS5**, which the engine requires; **22.16.0 is the first that works** (full gate passes there, cache skipped) | **Resolved** | `engines`, the READMEs, CONTRIBUTING and the getting-started guide now say 22.16; 22.16.0 is a blocking CI job. Node still marks `node:sqlite` experimental, which prints a warning on first use: say so in the docs |
| B6 | **Hub security.** The hub exposes an SSE stream and a POST endpoint. I did not check authentication, binding defaults, or input limits | To check | Review before promoting the sync story. If it is unauthenticated, say so loudly in docs and default to localhost |
| B7 | **No `SECURITY.md`** (private reporting channel) | Verified | **Written.** Enable GitHub private vulnerability reporting and create the `security@` alias |

### 4.2 Should fix before launch

| # | Finding | Action |
| --- | --- | --- |
| S1 | No `CODE_OF_CONDUCT.md`, issue templates, PR template, `CHANGELOG.md` | Add. Contributor Covenant 2.1; issue forms for *bug*, *TypeDB-divergence*, *feature (name the caller)* |
| S2 | **Doc drift.** `docs/memories/project-overview.md` says revision parity is "proven against CouchDB 3.4.3 oracle"; `AGENTS.md` says that oracle was removed (2026-09) and nothing re-checks parity | Fix the overview. A public claim contradicted by the maintainers' own notes is exactly what an early reader finds |
| S3 | Public docs reference **downstream-app** as "the engine's one production consumer" (performance doc and bench data) | Decide: keep as a named, linked case study (it's a real asset) or neutralise. Check that no private data ships in `performance-results/` or snapshots |
| S4 | README is long and opens with a thanks table | Restructure (see 5.3) |
| S5 | `.claude/`, `AGENTS.md`, `.github/agents|prompts|skills` ship in the public tree | Fine to keep, and a plus for agent-assisted contributors. Confirm nothing in them is private (paths, tokens, internal URLs) |
| S6 | Sync demo has Electron and Android toolchains: heavy for a newcomer | Keep it, but give a browser-only "run it in one command" path and a recorded GIF |
| S7 | Performance "Still open" list (no cost model, one writer, no change-log retention) | Promote to the public roadmap and known-limitations page rather than leaving it in a results doc |
| S8 | Platform coverage unknown (Windows, macOS) | CI matrix; document support |
| S9 | Run a secret scan across full git history | `gitleaks` or GitHub secret scanning; rotate anything found |

### 4.3 Nice to have

- Benchmarks against a baseline a reader cares about (raw SQLite, a TypeDB server on the same data).
  Frame as "what it costs," not "who wins".
- A "Why not X?" page: TypeDB server, plain SQLite, a general graph library.
- A browser playground (the most persuasive single asset; see 6.1).

## 5. Phases

Each phase lists its **exit criteria**. Don't start the next phase's public steps until they're met.

### Phase 0 — Legal, naming and reservations (week 1–2)

- [ ] Read TypeDB Ltd's trademark and brand policy. Summarise the constraints in one page.
- [x] Speak to TypeDB Ltd's CEO; blessing to release as open source received *(done, by video call)*.
- [ ] Confirm it in writing (see B1): a short email, and a one-line reply from TypeDB Ltd. Ask in the
      same message: (a) may we use "TypeDBLite" and `typedblite.dev` as they stand; (b) do they want
      specific wording in the README's trademark and independence notes; (c) would they like a preview
      before launch, and (d) would they be willing to mention or link the project, or answer questions in
      their community channels, on launch day. Make each an offer, not an expectation.
      *(Owner: maintainer, by hand. Not to be delegated or automated.)*
- [x] Invitations received to connect on LinkedIn and join TypeDB's Discord, to talk with their
      engineering team and user community.
- [ ] Join the Discord and **listen before announcing**: spend two to three weeks reading, answering
      questions you can answer, and learning the channels, norms and self-promotion rules. A launch post
      from someone already known there lands very differently from one by a stranger.
- [ ] Use the engineering access for what only they can answer, once, concisely: the one conformance
      failure (`update` L959), the 12 deviations (does the TypeDB team agree these are TypeDB-side
      failures?), and any spec ambiguity you hit. Report real spec bugs upstream in `typedb-behaviour`.
      Keep the questions about the spec, not requests for review of the whole project.
- [ ] Keep agreements in email (see B1). Chat and LinkedIn are for relationship and questions; they
      are not the record of what TypeDB Ltd agreed.
- [ ] Decide the fallback name now, so a rename is a day's work, not a crisis (e.g. keep "TypeQLite" for
      the language and rename the engine). Check that the fallback name is free on npm, GitHub, and
      the Marketplace.
- [x] Register the `@typedblite` npm org and `typedblite.dev` *(done 2026-11-14)*.
- [ ] Secure the npm org: 2FA required for all members, no shared logins, a second owner as a recovery
      path (a single owner is a single point of failure for the whole project).
- [ ] Claim the unscoped `typedblite` and `typeqlite` npm names, the VS Code Marketplace publisher, and
      the Open VSX namespace. Consider a GitHub organization, so the repo isn't tied to a personal account.
- [ ] Domain hygiene: auto-renew on, registrar 2FA, registrar lock, and a multi-year registration.
      `.dev` is HSTS-preloaded, so everything on it must serve valid HTTPS from day one.
- [ ] Confirm copyright holder line and MPL-2.0 headers: new files carry the notice as the project
      decides; vendored spec files keep their original headers (already the case).
- [ ] Run a secret and PII scan over the full history (S9). Check `.claude/` and `.github/` content (S5).
- [ ] Choose a contribution model: **DCO** (sign-off) recommended over a CLA for an MPL-2.0 project.

**Exit:** written answer or clear path on the name; reservations held; history clean.

### Phase 1 — Repository hygiene and CI (week 2–3)

*Written 2026-11-14 on branch `ccr-6f8d672b-u6bxfd`; nothing here has run on GitHub yet. The gate itself
was run locally on Node 22.23 (see [1.1](#11-what-running-the-gate-found)).*

- [x] `.github/workflows/ci.yml`: install, `build`, `typecheck`, `test` through Nx. Node 24 and 22 on
      Linux are blocking; Node 22.12.0, macOS and Windows are **experimental** (reported, not blocking)
      until seen green (B5, S8).
- [x] Conformance: `npm test` already fails on a regression below `baseline.json`; a separate job runs
      the report card and uploads it. *(Still to do: the README badge generated from a run.)*
- [x] Browser job: `test-wasm` and `test-browser` (Playwright Chromium) — **non-blocking for now**, see 1.1.
- [x] PR-title check (Conventional Commits on the PR title, which names the merge commit; any scope).
- [x] `SECURITY.md`, `CHANGELOG.md`, issue forms (bug, TypeDB divergence, feature-with-caller), PR
      template, `CODEOWNERS`, Dependabot (npm and Actions), label file and sync workflow.
- [ ] `CODE_OF_CONDUCT.md`: **not written.** It should be the official Contributor Covenant 2.1 text,
      which this environment could not fetch. Add it from the repository's *Insights → Community
      Standards → Add* button, which inserts the official text, and set the contact to `hello@typedblite.dev`.
- [x] S2 fixed (`docs/memories/project-overview.md`). **S3 still open**: it needs a decision (decision 5).
- [ ] **Settings only the owner can change** (cannot be done from files): branch protection on `main`
      (require the `gate (ubuntu-latest, node 24)` and `gate (ubuntu-latest, node 22)` and `PR title`
      checks, require review, merge commits only: no squash, no rebase); enable Discussions; enable private vulnerability
      reporting, secret scanning and push protection, Dependabot alerts.
- [x] Mailbox aliases `security@` and `hello@` on `typedblite.dev`: both forward to the maintainer's mailbox
      *(reported by the maintainer 2026-11-14; no test message has been sent, so send one from outside
      to confirm)*. `SECURITY.md` names `security@`.
- [ ] Review the hub (B6); write the findings into the replication guide as a "Security" section.
- [x] After the first CI run: read the results of every experimental job (see [1.2](#12-first-ci-results)). **Promoting
      jobs to blocking is a branch-protection setting only the owner can change.**

**Exit:** CI green on `main` across the blocking matrix; every community-health file present; GitHub's
"Community Standards" checklist is 100%.

#### 1.1 What running the gate found

Running `npm ci`, `build`, `typecheck` and `test` from a clean checkout, as CI will, found three things
that would have turned the first CI run red:

1. **`package-lock.json` pointed 336 packages at a local registry** (`http://localhost:4873/…`, a
   Verdaccio on the machine that committed it). Anyone else's `npm ci` failed, which is also the first
   command in the README. **Fixed**: the URLs now point at `registry.npmjs.org`; the integrity hashes were
   not touched, and `npm ci` then installed 811 packages and verified them. Worth adding to the
   release checklist: `grep -c localhost package-lock.json` must print 0.
2. **The coverage thresholds fail on four projects.** `vitest.shared.ts` enables coverage whenever `CI`
   is set, with an 80% floor, and GitHub sets `CI=true`. Every test passes, but `typeqlite-language`
   (functions 78.1%), `typedblite-conformance` (statements 72.7%), `typeqlite-vscode` (statements 78.2%)
   and `sync-demo` (statements **19.5%**) fail that floor. The blocking gate therefore runs with coverage
   off, and a separate non-blocking `coverage` job reports the numbers. **This is a policy decision**
   (decision 9): raise the tests, exempt `sync-demo` (it is a demo, tested end to end), or lower the floor.
   I changed none of them.
3. **One WASM test failed, deterministically. Cause found and fixed; it was the test, not the engine.**
   `replication-correctness` › *a push that fails midway does not re-send the batches that succeeded*
   waited a fixed 900 ms, then expected the hub to hold all 1,200 changes. The drain takes about
   0.3 s on `node:sqlite` and about 1.5 s on WASM SQLite (measured, three runs each), so the hub held
   1,000 when the window closed. The push logic was identical on both bindings (the same four push
   calls), and the no-resend assertion held in every run. The test now waits for the hub to reach
   1,200 (15 s deadline) before asserting; the assertions are unchanged. Checked by reintroducing the
   bug it guards (dropping the per-batch progress report): the test then fails on both bindings with
   `sent 2 times`. The full WASM suite passes locally (595 passed, 7 skipped by design). The CI job
   stays non-blocking until it has been read on a hosted runner; the other fixed waits (8 more in
   `replication-correctness` and `live.test.ts`) are the next place a slow runner would show up.

4. **The first CI run was red on every Node 24 job, and that was a Node regression, not this PR.**
   `langium generate` (langium-cli 4.3.0) threw `TypeError: Invalid URL` on the runner's Node 24.22.2.
   Reproduced locally: it passes on Node 24.19.0 (the author's) and 22.23, and fails on 24.22.2.
   Cause: its `jsonschema` 1.5.0 resolves `$defs` references against the base `thismessage::/`, an
   opaque-path URL that newer Node rejects. `jsonschema` 1.5.0 is the latest release; `langium-cli`
   4.4.1 does not hit it (control run on the same Node). **Fixed** by upgrading `langium` and
   `langium-cli` to `~4.4` and `vscode-languageserver` to `~10.1` (Langium's own range), plus an explicit
   return type on `prepareRename` (TS2883: the LSP types now resolve to a nested copy). Build,
   typecheck and all 21 test tasks pass on Node 22.23.4 and 24.22.2. Anyone on current Node 24 would
   have hit this on their first `npm run build`, so CI found a launch blocker.
5. **Node 22.12.0 is not a working minimum** (B5, resolved above). CI's experimental 22.12.0 job failed
   with `No such built-in module: node:sqlite`; checking upward found the missing FTS5 in 22.13 to 22.15.

Green locally on Node 22.23: build, typecheck, `npm test` (21 of 21 tasks, coverage off), the
conformance report. **Not run** here: `test-browser` (needs Playwright Chromium), the VS Code e2e,
Node 24, macOS, Windows, and every workflow file on a real runner.

#### 1.2 First CI results

PR #22, heads `e7f3017` and `a6a36de` (GitHub-hosted runners; Node 24.22.2 for the Node 24 jobs). Two complete runs.

| Job | Result | Next step |
|---|---|---|
| gate, Ubuntu, Node 24 | Passed | Blocking: require it |
| gate, Ubuntu, Node 22 (latest) | Passed | Blocking: require it |
| gate, Ubuntu, Node 22.16.0 (the minimum) | Passed | Blocking: require it |
| conformance report | Passed (1,742 pass, 12 deviations, 1 fail, 1 n/a, of 1,756: the documented figures, reproduced on CI) | Require it |
| VS Code e2e | Passed on both runs | Ready to require |
| WASM and browser | Passed on both runs: the WASM suite, and 3 tests in a real Chromium (OPFS persistence across a full browser restart; browser revisions equal Node's; the same `[CNT9]` duplicate-key diagnostic) | Ready to require |
| gate, macOS, Node 24 | Passed on both runs (and on the run before) | Ready to require |
| coverage | Failed on the known 80% floor: numbers identical to the local run | Stays non-blocking until decision 9 |
| gate, Windows, Node 24 | **Build and typecheck pass; 11 tests fail** (12 before `.gitattributes`; below) | Stays experimental |
| PR title | Did not run: `pull_request_target` runs the workflow from the base branch, which does not have it yet | Starts working after merge |

**Windows, by cause.** 11 tests fail in 3 groups (the first group, below, is fixed: the run on `a6a36de` has no
conformance failure). The first count I gave here was 13; the groups were 1 + 3 + 2 + 6 = 12. The causes of
groups 2 and 3 are read from the failure messages; group 4's is unknown.

1. **Conformance `vendored.test` (1 test; all 20 vendored files "differed", `LICENSE` included): FIXED.** Git for
   Windows was converting to CRLF on checkout, which changes every file's bytes. Every tracked file is LF in the
   index. `.gitattributes` (LF everywhere, the spec directory byte-exact) cleared it: the conformance suite now
   passes on Windows.
2. **Runtime `durability` and `transaction-crash` (3 tests).** They assert the killed child reports
   `signal === 'SIGKILL'`. Windows has no POSIX signals, so a killed process reports `signal: null`. The tests'
   assumption is POSIX-only; the engine claim they guard (a killed writer leaves no half-write) is untested on
   Windows. Needs a platform-aware assertion or a documented skip, and a decision on whether crash safety on
   Windows must be proven some other way.
3. **Runtime `role-player-index` (2 tests).** `EPERM` deleting the temporary directory in the test's `finally`
   while SQLite still holds the file open, which Windows does not allow. Test cleanup: close the database
   before `rmSync`.
4. **CLI `repl.test` (6 tests).** The REPL's captured output is empty on Windows. Cause unknown; needs a
   Windows machine or a few CI iterations to see what the child process printed.

The seven CLI `main` tests, 686 of 691 runtime tests and all of conformance now pass on Windows.

**Recommended branch protection** once this PR has merged and the checks exist: require
`gate (ubuntu-latest, node 24)`, `gate (ubuntu-latest, node 22)`, `gate (ubuntu-latest, node 22.16.0)`,
`conformance report`, and the PR-title check. Then `vscode e2e`, `wasm and browser` and `gate (macos-latest, node 24)`, each of which has been green on two complete runs.

### Phase 2 — Packaging and first release (week 3–5)

Decide the public surface deliberately (see [section 12](#12-decisions-needed)). Recommended:

| Artifact | Channel | Notes |
| --- | --- | --- |
| `@typedblite/runtime`, `@typedblite/language`, `@typedblite/content-revision` | npm | Publish with **provenance** (`--provenance` from GitHub Actions OIDC); include `exports`, types, a README per package, and a `files` allowlist; verify with `npm pack --dry-run` |
| `typedblite-cli` | npm (remove `private`) | Goal: `npx typedblite --exec '…'` works with zero clone |
| `typeqlite` VS Code extension | Marketplace **and** Open VSX | Already packages as a `.vsix`; add a `README`, changelog, gallery banner, categories, keywords |
| `typedblite-conformance`, `sync-demo` | Repo only | Stay private; they're evidence and demo, not products |

- [ ] Versioning: SemVer, **`0.1.0`** for the first public release. Write a compatibility policy:
      pre-1.0 minor versions may break; breaking changes listed in the changelog; store format changes
      follow the "additive only" rule already in `AGENTS.md`.
- [ ] Release automation: tag → GitHub Actions → build → test → publish → GitHub Release with notes.
      Prefer npm trusted publishing (OIDC) over a long-lived token. Where a token is needed for the first
      publish, make it a granular, package-scoped, expiring token and revoke it afterwards.
      Use Nx release or Changesets; pick one and document it in CONTRIBUTING.
- [ ] A **clean-room install test**: in an empty directory, on a machine without the repo, follow the
      README exactly (npm install, first query, WASM in a Vite app, CLI via `npx`, VSIX install).
      Run this on Linux, macOS and Windows. Most launch-day pain is found here.
- [ ] Dry-run the whole pipeline against a **throwaway scope** or `--dry-run` before the real publish.
- [ ] Publish `0.1.0-rc.1` under the `next` dist-tag for the private beta.

**Exit:** the clean-room test passes on all three platforms from published artifacts, not from a clone.

### Phase 3 — Docs and onboarding (week 3–6, parallel with Phase 2)

**5.3 README restructure** (target: understand it in 30 seconds, run it in 5 minutes)

1. Logo, one-line pitch, badges (CI, conformance %, npm version, license).
2. 20-second demo (GIF or asciinema): define a schema, insert, match.
3. "Why" — three bullets with the use cases from [section 3](#3-positioning-and-audience).
4. Install and first query: `npx` and `npm install` paths, copy-paste complete.
5. What it is *not* (yet): known limitations, honest and linked.
6. Documentation map, packages table, conformance summary.
7. Acknowledgements — the current "Special Thanks" section moves here, unchanged in substance.

**Docs work**

- [ ] A task-based "5-minute tour" ending in a working app, distinct from the existing getting-started
      guide (which starts from a clone).
- [ ] A **Known limitations & roadmap** page assembled from: `@range/@values/...` not enforced, `@card`
      only partly enforced, the 14 non-passing scenarios, and the performance "Still open" list.
- [ ] "TypeDB vs TypeDBLite" page: what's the same, what differs, when to use which. Written to be
      fair to TypeDB; ask TypeDB Ltd to read it (Phase 0 contact).
- [ ] "Why not X?" page (4.3).
- [ ] API reference generated from TSDoc (TypeDoc) and published to GitHub Pages; link from the README.
- [ ] Docs site: GitHub Pages from `docs/` is enough, served at `typedblite.dev` (CNAME plus DNS records,
      "Enforce HTTPS" on). Don't build a bespoke site pre-launch. Suggested layout: `typedblite.dev` for the
      landing page and docs, `/playground` for the playground, `/api` for the TypeDoc reference.
- [ ] Mail on the domain: a `security@` and a `hello@` alias (forwarding is enough) so `SECURITY.md` and
      the press kit don't depend on a personal address. Add SPF/DKIM/DMARC if the aliases will send.
- [ ] Use the domain in package metadata (`homepage`), the VS Code extension manifest, the README badges,
      and the repo's website field.
- [ ] The **browser playground** (6.1), hosted on the same Pages site.

**Exit:** a first-timer test (below) succeeds without the maintainer's help.

### Phase 4 — Private beta and soft launch (week 5–7)

- [ ] Recruit **5–10 testers** across the audiences in section 3: two TypeDB users, two local-first
      developers, two TS developers new to graph databases, one language-tooling person.
- [ ] Give each the same short task, no coaching: *install it, model something you know, run a query,
      tell us where you got stuck.* Screen-record or take notes. Time to first query is the metric.
- [ ] Triage findings into: fix before launch / fix in 30 days / won't fix (with reason).
- [ ] Seed **15–20 `good first issue`s** — the 14 non-passing conformance scenarios are a natural
      source, plus doc fixes and small constructs with a named caller.
- [ ] Flip the repo to public if it is private; publish `0.1.0` (stable `latest` tag) a few days before
      the announcement so it has settled and the install path is proven in the wild.
      **Not until every [parking-lot](#parking-lot) item that blocks the flip is closed** (today: PL-1).
- [ ] Share with TypeDB Ltd: a courtesy preview of the blog post and README (not a request for
      sign-off on content beyond naming).

**Exit:** all testers reached a first query unaided in ≤ 5 minutes (or the blockers are fixed); no open
blocker-labelled issues.

### Phase 5 — Public launch (week 7–8)

See [section 7](#7-launch-day-runbook).

### Phase 6 — After launch: days 1–90

| Window | Focus |
| --- | --- |
| **Days 1–3** | Respond to everything within hours. Triage every issue. Fix install bugs same-day and cut `0.1.1`. Thank every first-time contributor by name |
| **Week 1** | Write down what people asked that the docs didn't answer; fix the docs first. Publish "what we learned from launch week" (short, honest) |
| **Weeks 2–4** | Merge first external PRs fast (a quick first review sets the culture). Publish the public roadmap and a monthly cadence of releases |
| **Month 2** | Second wave: a deeper technical post (e.g. *How we reached 99.2% of TypeDB's spec*; *Content-addressed revisions for offline-first sync*), a talk or lightning-talk proposal (local-first meetups, TypeScript meetups, Langium) |
| **Month 3** | Retro against the metrics in section 9; decide `0.2` scope from real usage; decide whether the project needs a second maintainer, Discord, or a funding page |

## 6. Launch assets

### 6.1 Must-have

| Asset | Description | Notes |
| --- | --- | --- |
| **Browser playground** | Editor + results pane running TypeDBLite on WASM SQLite, with 3 example schemas; shareable via URL hash | The strongest single proof of "runs in the browser," and zero install. Reuse the sync-demo's WASM plumbing and the VS Code extension's grammar for highlighting |
| **Demo GIF / video (≤ 60 s)** | Terminal: `npx typedblite` → define → insert → query. Second clip: sync demo, cut the network, edit on two devices, reconnect, converge | Put the second clip in the blog post, not the README top |
| **Launch blog post** | ~900–1,200 words, see outline below | Host on the project site or the maintainer's blog; cross-post later |
| **Conformance report page** | The number, the method, how to re-run it | A reader should be able to reproduce 99.2% in two commands |
| **Release notes `0.1.0`** | Plain-language summary, known limitations first | |

**Blog post outline**

1. The problem: you want TypeDB's model somewhere a server can't go.
2. What TypeDBLite is, in one paragraph, with the install-and-query snippet.
3. How we know it's faithful: the behaviour spec, 1,742/1,756, and the honest accounting of the other 14.
4. Where it runs: Node, browser, offline sync (embed the clip).
5. What it can't do yet, stated plainly.
6. Thanks to TypeDB Ltd and the community; independence statement.
7. How to help: link to good first issues; ask for *callers*, not just stars.

### 6.2 Should-have

- Social card image and an OG preview for the repo (the brand SVGs exist in `docs/brand/`).
- A short FAQ: relationship to TypeDB Ltd, license implications of MPL-2.0 (file-level copyleft; fine for
  most users), production-readiness, performance expectations, roadmap.
- A one-page "press kit": logo files, boilerplate, facts, maintainer contact.

### 6.3 Draft copy (edit freely)

**Title options for Show HN**
- `Show HN: TypeDBLite – TypeDB's data model and TypeQL on SQLite, in Node and the browser`
- Avoid superlatives. State the conformance number with its denominator.

**First-comment template (post immediately after submitting):** who you are in one line; why you built
it (the real consumer: downstream-app); what works; what doesn't; the conformance method; one specific
question you want answered ("what would you need to try this on a real project?"); thanks to TypeDB.

## 7. Launch day runbook

**Choose a window.** Tuesday–Thursday, ~08:00–10:00 US Eastern for HN/Reddit. Avoid holiday weeks.
Given today's date, a launch landing between late-November US holidays and the mid-December slowdown is
poor timing; **target the first or second full week of January 2027** unless the readiness gates are met
earlier *and* you can staff a response week in early December.

**T-1 day**
- [ ] `latest` on npm and both extension marketplaces are live and verified from a fresh machine.
- [ ] Playground, docs site, blog post, GIFs all load; links checked (CI link checker).
- [ ] Issue templates and labels active; `good first issue`s visible; Discussions enabled.
- [ ] Pre-written replies for the five predictable questions (why not just use TypeDB; trademark; is it
      production-ready; performance; license).
- [ ] Calendar cleared for the day. Don't launch if you can't respond for ~8 hours.

**Launch day (all times relative to posting)**

| When | Action |
| --- | --- |
| T+0 | Publish blog post. Submit **Show HN**. Post the first comment |
| T+0–1h | Post to the **TypeDB Discord/forum** in the community-projects area, framed as thanks plus a link, not a pitch. Post to **r/typescript** (check each subreddit's self-promotion rules first) |
| T+1–3h | Social posts (X/Bluesky/Mastodon/LinkedIn), each leading with a different asset: GIF, playground link, conformance number |
| T+3–8h | Reply to every comment and issue. Fix and release any install bug immediately |
| T+8h | Submit to **lobste.rs** (needs an invite or an existing account; don't self-promote more than the site's norms allow), and to relevant newsletters: Node Weekly, TypeScript Weekly, Local-First Weekly, via their submission forms |
| End of day | Write down all questions asked; open issues for each docs gap |

**Don'ts:** don't ask people to upvote; don't post to many places simultaneously with identical text; don't
argue with critics; don't over-claim ("drop-in replacement," "production-ready").

**Rollback plan.** If the name must change or a severe bug appears: `npm deprecate` with a clear
message, pin an issue explaining, ship the fix as a patch. Keep the fallback name from Phase 0 ready.

## 8. Community and governance

| Topic | Decision |
| --- | --- |
| **Contribution model** | DCO sign-off (`git commit -s`), enforced by a bot. No CLA |
| **Governance** | Initially BDFL with a written `GOVERNANCE.md`: how decisions are made (ADRs for architectural ones, which the repo already does), how someone becomes a maintainer, how disputes are resolved |
| **Channels** | GitHub Issues (bugs, features), GitHub Discussions (questions, show-and-tell). Add Discord/Matrix only if Discussions overflow |
| **Response targets** | First response to issues/PRs within 2 working days; security reports within 48 hours (stated in `SECURITY.md`) |
| **Feature policy** | The repo's own rule becomes public policy: constructs are added when a real *caller* is named. Say so in the issue form |
| **Triage** | Weekly 30-minute triage; label every issue within the week; close stale `needs-info` after 30 days with a friendly note |
| **Release cadence** | Patch releases as needed; minor monthly while pre-1.0 |
| **Roadmap** | Public `ROADMAP.md` drawn from `docs/planning/` (debugger, editor, graph explorer, sync demo) plus the known-limitations list |
| **Agents** | `AGENTS.md` already orients AI contributors. Add a short policy: AI-assisted PRs are welcome; the human submitter is responsible for the change and must have run the gate |
| **Relationship with TypeDB** | Treat as an upstream. Report spec ambiguities to `typedb-behaviour` rather than working around silently; credit upstream in release notes when their spec drives a change |

## 9. Metrics

Measure outcomes that indicate health, and review monthly.

| Metric | Day 30 | Day 90 | How measured |
| --- | --- | --- | --- |
| Time to first query (testers, unaided) | ≤ 5 min | ≤ 5 min | Beta sessions; later a docs survey |
| Install success (issues titled "can't install") | < 3 | < 5 total | Issue labels |
| External issues opened | 10 | 30 | GitHub |
| External PRs merged | 2 | 8 | GitHub |
| Median time to first response | < 2 days | < 2 days | GitHub insights |
| npm weekly downloads (all three runtime packages) | trend, not target | trend | npm |
| Conformance pass rate | ≥ 99.2%, never lower | ≥ 99.5% if feasible | CI report |
| Repo stars / HN rank | recorded, not targeted | recorded | |
| Qualitative: named real-world callers | 3 | 8 | Issues, Discussions |

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| TypeDB Ltd's position changes (new staff, a rebrand, a policy change) after a verbal OK | Low | **High** | Written confirmation (B1); keep the fallback name; keep the independence statement and the embedded/browser niche; credit them prominently and genuinely. Residual risk is now low, not zero |
| Install fails on a platform we didn't test (Windows, older Node) | High | High | CI matrix; clean-room install on all three platforms; `node:sqlite` check (B5) |
| Unauthenticated hub exposed by someone following the sync guide | Medium | High | Review (B6); safe defaults; explicit "not for the open internet" warning |
| Compatibility over-read as "drop-in TypeDB" | Medium | Medium | Cite runs; publish limitations page; say what's not supported in the first screen of docs |
| Maintainer overload after launch | High | Medium | Launch only in a window with capacity; templates and docs reduce questions; set response expectations in writing; recruit a second reviewer from the beta group |
| Launch lands in a dead news window | Medium | Low | Defer to January (section 7) |
| Early performance criticism (one writer, no cost-based planner) | Medium | Low | Already documented honestly in `performance.md`; surface it in the limitations page so critics find an answer, not a gotcha |
| Private data in git history or bench snapshots | Low | High | Phase 0 scan; review `performance-results/` |
| Supply-chain concern from a new package | Low | Medium | npm provenance, 2FA on the org, minimal dependencies, Dependabot, lockfile committed (already) |
| Single-vendor dependency on SQLite WASM build | Low | Low | Optional peer dependency (already), interface-based binding (already) |

## 11. Calendar

Weeks counted from the day work starts. Phases overlap where noted; gates are what matter, so slip the
calendar, not the criteria.

| Week | Work | Gate |
| --- | --- | --- |
| 1 | Phase 0: trademark read, outreach email, name reservations, history scan, fallback name | Outreach sent |
| 2 | Phase 0 finish; Phase 1 start: CI, community files | Reservations held; history clean |
| 3 | Phase 1 finish; Phase 2 start; Phase 3 start (README, playground) | CI green on matrix |
| 4 | Phase 2: packaging, release automation, `rc.1` to `next` | |
| 5 | Phase 2 clean-room tests; Phase 3 docs; Phase 4 begins: recruit testers | Clean-room passes on 3 OS |
| 6 | Phase 4: beta sessions, fixes, seed good-first-issues | |
| 7 | Phase 4 exit; publish `0.1.0`; repo public if not already; pre-launch checklist | Beta exit criteria |
| 8 | **Launch** (see the window note in section 7) | |
| 9–20 | Phase 6 | Day-90 retro |

Eight weeks assumes one maintainer working on this alongside other commitments. With a second person,
Phases 1–3 compress to about four weeks.

## 12. Decisions needed

These change the plan; the recommendations are what the plan assumes.

1. **The name.** Resolved in principle: TypeDB Ltd's CEO gave a verbal blessing. *Remaining: confirm in
   writing, keep the fallback name on file.*
2. **Public surface.** Publish the three library packages and the CLI to npm; the VS Code extension to
   both marketplaces; leave conformance and sync-demo in the repo. *Recommendation: as in Phase 2.*
3. **Is the repository already public?** *Resolved: it is private (maintainer, 2026-11-14).* Nothing in it is public
   yet. Clear the [parking lot](#parking-lot) before that changes.
4. **Contribution model.** DCO (recommended) or CLA.
5. **downstream-app as a named case study** (S3). It's the project's only production consumer and the
   strongest answer to "who uses this?" *Recommendation: keep, link, and have its data reviewed.*
6. **Minimum Node version** after the B5 check.
7. **Launch window.** Early December versus January. *Recommendation: January 2027.*
8. **Capacity.** Who answers issues in launch week, and who is the second reviewer?
9. **Coverage policy.** Four projects are below the 80% floor (1.1). Raise tests, exempt `sync-demo`, or lower
   the floor? *Recommendation: exempt `sync-demo`, and raise the other three, which are within about
   8 points; keep the floor at 80%.*

---

## Parking lot

Things deliberately set aside, each with the moment it must be revisited. An item stays here until it is closed.

| # | Item | Revisit before | Blocks | Status |
| --- | --- | --- | --- | --- |
| PL-1 | Revisit what this plan says about the TypeDB Ltd conversation | The repository is made public, and in any case before the announcement | Flip to public | Open |
| PL-2 | Report the Langium race upstream, and drop our workaround once it is fixed | A Langium upgrade | Nothing | Open |
| PL-3 | Keep the original commits of PRs #22 and #33 on a branch or tag | Soon: needs the maintainer's OK to push | Nothing | Open |
| PL-4 | Decide whether to add a commit-message check | Branch protection is enabled, or the first outside pull request | Nothing | Open |
| PL-5 | Confirm CI on `main` is stable, including the Node 22 gate | The announcement | Announcement | Open |

### PL-1. What the plan says about the TypeDB Ltd conversation

The plan records that TypeDB Ltd's CEO gave a verbal blessing to the release. That is accurate and useful in a
private planning file. It is a different thing in a public one: it makes a claim about a third party, names their
role, and describes a private conversation, before the written confirmation (B1) exists.

**Where it appears** (all in this file): the B1 row in 4.1; the Phase 0 checklist item "Speak to TypeDB Ltd's CEO";
the risk row "TypeDB Ltd's position changes"; decision 1 in section 12; and [Where to resume](#where-to-resume).

**Decide, when the time comes:**

- *If the written confirmation is in hand:* reword to say a written confirmation was received on a date, without
  naming a role or describing the conversation, and keep the email itself in private records.
- *If it is not:* remove the references, or reduce them to "naming to be confirmed with TypeDB Ltd", and keep the
  detail in private records only.

Either way, the same pass should check the rest of `docs/planning/` for statements about third parties that are
fine in a private repository and not in a public one.

**Owner:** the maintainer. **Blocks:** the "flip the repo to public" step in Phase 4.

### PL-2. Report the Langium race upstream

Langium 4.4.2's `DocumentBuilder.notifyDocumentPhase` checks the cancellation token before each listener, after a
document is already `Validated` and marked complete. A build cancelled in that gap drops the listener that sends the
diagnostics, and nothing rebuilds the document. An editor opening several files at once triggers it (about 3 runs in
10 for five documents).

We work around it in `TypeQLiteDocumentBuilder.notifyDocumentPhase` (`libs/language/src/typeqlite-label-providers.ts`),
with a regression test that cancels at exactly that point (`libs/language/test/diagnostics-published.spec.ts`). The
measured evidence is in PR #33: 6 of 20 standalone replays stalled before the fix and 0 of 40 after.

**To do:** file it with Langium with a minimal reproduction (the regression test is close to one), under the
maintainer's name. When it is fixed upstream: upgrade, delete the override, keep the test. A draft report can be
written on request.

### PL-3. Keep the original commits of PRs #22 and #33

Both were squash-merged before the rule that pull requests are merged with merge commits. Their original commits
(15 and 2) are on no branch; they exist only at GitHub's `refs/pull/22/head` (`904fb2b`) and `refs/pull/33/head`
(`a7557e1`).

**To do:** push a branch or tag for each (for example `archive/pr-22`, `archive/pr-33`) so they stay reachable
whatever GitHub does with PR refs. That is non-destructive. It needs the maintainer's OK, because it creates refs
beyond the working branch. `main` is not rewritten.

### PL-4. A commit-message check

With merge commits every commit message is kept, so the PR-title check (which guards only the merge commit's
title) is no longer the best fit. A per-commit Conventional Commits check would be, but it would also reject
`Merge branch ...` commits inside a pull request. Decide before enabling branch protection, or when the first
outside pull request arrives.

### PL-5. Confirm CI on `main` is stable

The Node 22 gate failed once on `main`, from the Langium race, and has passed since. One clean run proves little:
three clean runs on pull requests did not prove it before. The push runs on `main` for `4288d70` and `63d4c66`
(docs and CI changes only) have not been read.

**To do:** read the push runs on `main` as they arrive. Any intermittent failure of `typeqlite-vscode`'s
`server.test.ts` means the fix is incomplete. Treat several consecutive clean runs, not one, as the bar.

---

*Verification notes.* Facts in this plan about the repository (versions, missing files, conformance
numbers, package visibility, documents' contents) were read directly from it on 2026-11-14. Items marked
"To check" were not verified. External facts (marketplace and community-site rules, TypeDB Ltd's trademark
policy, Node release details) were not looked up and must be confirmed before acting.
