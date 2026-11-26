# TypeDBLite — Open Source Launch Plan

Status: in progress · Written 2026-11-14 · Current as of 2026-11-25, `main` at `e3de77e` ([where to resume](#where-to-resume))

This plan takes TypeDBLite from "a strong repository" to "a project strangers can install, trust, and
contribute to." It is organized as gates, not dates: each phase has exit criteria, and the launch
happens when the gates are green. A suggested calendar is at the end.

- [Where to resume](#where-to-resume)
- [Free hosting and CI for open source](#free-hosting-and-ci-for-open-source)
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

*As of 2026-11-25. The work is in `typedblite/typedblite`, **private until launch**, with its history rewritten to
drop the private names. Its pull requests restart at #1; #1 to #74 are merged. The pre-rewrite history is kept
privately in the old repository.* Read this first; everything it points to is below.

**Nothing is released:** no tags, nothing on npm, no extension on Open VSX. **The website is live** at
`typedblite.dev`, with the guides, the API reference, the playground and the sync demo.

**A clean `npm ci` works from the public registry (2026-11-25).** The seven `@devx-micro/app-*` packages (ADR-011)
are on npmjs.org and pinned at 0.4.1. With them, `npm ci` from an empty cache succeeded and `npm run gate` passed in
full on Node 24.19.0, Linux.

**CI runs again (2026-11-26).** The repository is public and Actions is enabled. The first runs found failures on
Node 22, macOS and Windows in code merged while it was off (#81 fixed them), and `main` then passed. The `npm` and
`marketplaces` environments exist with a required reviewer. `release.yml` and `release-extension.yml` have never run.
One intermittent failure is known: a `write EPIPE` at the end of the extension's notebook server test.

**Landed since the move** (details in the changelog and each pull request): the five-minute tour, now a notebook
(#1, #2, #60); a value read as an attribute refused (#3); `oracle-bench` (#4); the website and API reference
(#6, #11 to #21, #24 to #37); the in-browser sync demo (#39 to #45); the engine host and the published
`@typedblite/session` (#46 to #52); TypeQLite notebooks (#53 to #62); the debugger (#63 to #70);
`@typedblite/node-host`, private (#72); `npm run deploy:vsx` (#73, #74).

**What is left, in order.** Several steps are hard to undo once something is public or published.

1. ~~**Unblock the build.**~~ Done 2026-11-25: the `@devx-micro` packages are published (above).
2. **Start the long waits, in parallel.**
   - Send the written confirmation to TypeDB Ltd (B1; the draft is deliberately not in this repository), get a
     one-line reply, and settle [PL-1](#parking-lot). It blocks going public.
   - Start the Open VSX namespace `typedblite`: it needs the Eclipse publisher agreement and a verification request
     ([Releasing](../../development/releasing.md#the-vs-code-extensions)).
3. ~~**Get CI back**~~ (decision 10). Done 2026-11-26. Left: re-raise the old repository's Capacitor 8 update, decide
   whether `coverage` and macOS become blocking, and add `sync-demo:test-browser`.
4. **Accounts** ([Releasing](../../development/releasing.md#one-time-setup)): claim the unscoped `typedblite` and
   `typeqlite` on npm (both still unpublished on 2026-11-25); 2FA on the `@typedblite` org and a second owner; take
   `private` off `apps/cli`; the Marketplace publisher `typedblite`; the `npm` and `marketplaces` GitHub environments
   and their tokens (none exist yet). Releasing still counts three libraries; there are now four, plus the CLI.
5. **Governance:** `CODE_OF_CONDUCT.md` (the official Contributor Covenant text); DCO or CLA (decision 4);
   `GOVERNANCE.md` and `ROADMAP.md`; who answers issues and who reviews (8); the launch window (7); review the
   [compatibility policy](../../guides/compatibility.md) and the ["Why not X" draft](../../guides/why-not-x.md).
6. **First release candidate:** publish `0.1.0-rc.1` under `next`, run the clean room against the published packages
   on three platforms, publish the extensions, and run the five-minute tour against the registry.
7. **Content:** "TypeDB vs TypeDBLite" (TypeDB Ltd should read it first), demo GIF, badges, blog post, release
   notes, good first issues. At release, remove the "not on npm" and "not public yet" notices (README, website) and
   restore the website's GitHub links (hidden in #34).
8. **Go public.** First run `gitleaks` again (clean on 2026-11-25) and finish PL-1. Then set branch protection,
   Discussions, private vulnerability reporting, secret scanning with push protection, Dependabot alerts, and the
   repository's website link and topics (both empty). Then Phase 4 and Phase 5.

Decided already: the production consumer is not named (5, S3); Windows is blocking; the coverage policy (decision 9);
the Node minimum (22.16); ADR-003's amendment (accepted).

**Merging:** merge commits only, never squash or rebase (the maintainer's rule, 2026-11-14).

**Open, not blocking:** full scans and long relation traversals are several times slower than TypeDB's
(`npm exec nx -- run typedblite-conformance:oracle-bench`); profile them before changing anything. No comparison
results are kept in the repository, because TypeDB Ltd should read a comparison before it is published. PL-2 to PL-5.

**History notes:** the older component names (`document-store`, `graph-store`, `iam`, `workflow-engine`, `mvp`) are
still in history on purpose. `55b783a`, cited in `docs/development/performance.md`, is not a commit in this
repository.

**Resuming locally:** Node 22.16 or later, then `git checkout main && git pull && npm ci && npm run gate` (it needs
Playwright's Chromium, `npx playwright-core install chromium`, and a display, or `-- --quick`). Useful to know:
- **`npm install` can write local-registry URLs into `package-lock.json`** if npm is pointed at a local proxy. Rewrite
  them to `https://registry.npmjs.org/` after checking each integrity hash, and check `grep -c localhost
  package-lock.json` prints 0. A URL rewritten for a package that is not on npmjs.org still fails for others.
- **In TypeQL 3, a `match` after an `insert` is the next stage of the same pipeline.** Separate statements with `end;`.
- `CI=true` turns on the coverage floor. Run with `CI=` to match the blocking gate.
- A workflow run shows "success" even when an experimental job fails. Read the jobs, not the run.
- A push cancels CI that is still running on the same ref.
- The Langium override in `TypeQLiteDocumentBuilder.notifyDocumentPhase` must be re-checked on any Langium upgrade.

---

## Free hosting and CI for open source

Checked on each provider's own pages on 2026-11-25, except where noted. Terms change; re-check before relying on one.

| Service | Free for this project | Limits and catches |
| --- | --- | --- |
| [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) | Standard hosted runners in **public** repositories, including Windows and macOS | Larger runners are billed. Private repositories get a quota. The page does not say whether a failed payment blocks public-repository jobs |
| [GitHub Packages](https://docs.github.com/en/billing/concepts/product-billing/github-packages) | Public packages | Its npm registry [needs a token even to install a public package](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry): not a substitute for npmjs.org |
| npmjs.org | Public packages (not re-checked: npm's pricing page refused the fetch) | [Trusted publishing](https://docs.npmjs.com/trusted-publishers/) works from GitHub Actions, GitLab CI and CircleCI hosted runners; provenance needs a public repository |
| [GitLab for Open Source](https://docs.gitlab.com/subscriptions/community_programs/) | Ultimate and 50,000 compute minutes a month | Application; OSI license on every project in a public namespace; renews every three months |
| [GitLab Free](https://about.gitlab.com/pricing/) | 400 compute minutes a month | Hosted runners need a card on file |
| [CircleCI open source](https://circleci.com/open-source/) | Up to 400,000 credits a month (Linux, Arm, Docker) and 30,000 (macOS, Windows) | Eligibility steps not stated on the page |
| [Codeberg CI](https://docs.codeberg.org/ci/) | Woodpecker for free software | Manual approval; provided as-is; modest use |
| [Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/licensing/concurrent-jobs) | No: new public projects can no longer be created | |
| [Cloudflare Workers static assets](https://developers.cloudflare.com/workers/platform/pricing/) | Static asset requests (the website today) | Requests served by Workers Caching are billed |

**Recommendation:** stay on GitHub and npmjs.org. The workflows, trusted publishing and the repository URL are already
set up for them, and Actions costs nothing for these runners once the repository is public. Until then, fix billing,
or keep relying on `npm run gate`. Moving CI elsewhere would mean rewriting the workflows.

---

## 1. Where we are

**Real strengths — lead with these.**

| Strength | Evidence |
| --- | --- |
| Measured compatibility, not claimed | 1,742 of 1,756 scenarios in TypeDB's own behavior spec pass (99.2%). 12 of the 14 non-passing also fail on TypeDB 3.10.4 itself ([CONFORMANCE.md](../../../CONFORMANCE.md)) |
| Runs where a server can't | Node (`node:sqlite`), browsers (WASM SQLite, ADR-009), any binding satisfying `SqliteDatabase` |
| A working end-to-end story | Offline-first sync demo: browser, desktop and Android, converging through a hub |
| Editor tooling | VS Code extension with a Langium language server |
| Honest engineering record | Ten ADRs, a documented load test with before/after numbers, declared deviations with owners |
| Clean licensing posture | MPL-2.0, matching TypeDB; upstream attribution and trademark notice already in the README |

**Not yet released.** Everything at version `0.0.1`; no git tags or releases; the CLI and the VS Code extension are
still `"private": true`; no `CODE_OF_CONDUCT.md`. The rest is in [Where to resume](#where-to-resume) and
[section 4](#4-readiness-audit).

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
runs in Node and the browser, and passes 99.2% of TypeDB's own behavior spec.*

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

Findings from the first read of the repository (2026-11-14), with their status updated since. **Verified** = confirmed in the files. **To check** = I did not
confirm it and it needs someone to.

### 4.1 Blockers (must be resolved before announcing)

| # | Finding | Status | Action |
| --- | --- | --- | --- |
| B1 | **The name contains TypeDB™.** The README handles attribution well, but a project name that includes another company's mark is the single largest launch risk | **Verbal blessing received** from TypeDB Ltd's CEO (video call, 2026-11) | **Get it in writing.** Send a short follow-up email restating what was agreed (open-source release under the name TypeDBLite, the `@typedblite` scope and `typedblite.dev`, MPL-2.0, the independence statement) and ask for a one-line confirmation reply. Keep the reply with the project records. Read the published trademark policy once to check that the agreement and the policy don't conflict. A verbal OK is good faith; a written one is what survives a change of staff or a rebrand |
| B2 | **No CI.** `.github/workflows/` was absent, so contributors' PRs would get no checks | **Closed 2026-11-26:** running again, and green | See [Where to resume](#where-to-resume) |
| B3 | **Nothing is published.** No tags, no releases, no npm packages, CLI is private | Verified, still true 2026-11-25 | Phase 2 |
| B4 | **npm and domain names.** `@typedblite` (npm org) and `typedblite.dev` are **registered (2026-11-14)**. Still to confirm: the unscoped `typedblite` (the CLI's name) and `typeqlite`, which the scope does not cover: **both still free on 2026-11-15**. The `typedblite` GitHub org is held too (2026-11-15) | Partly done | Check both unscoped names on npm and claim them (publish a placeholder or `0.0.0` under the org if free). Note that the domain, like the name, contains TypeDB™, so B1 covers it too |
| B5 | **`node:sqlite` vs `engines`.** `engines` said Node `>=22.12`. Measured: 22.12 has **no** `node:sqlite`; 22.13 to 22.15 have it **without FTS5**, which the engine requires; **22.16.0 is the first that works** (full gate passes there, cache skipped) | **Resolved** | `engines`, the READMEs, CONTRIBUTING and the getting-started guide now say 22.16; 22.16.0 is a blocking CI job. Node still marks `node:sqlite` experimental, which prints a warning on first use: say so in the docs |
| B6 | **Hub security.** The hub exposes an SSE stream and a POST endpoint. I did not check authentication, binding defaults, or input limits | **Reviewed 2026-11-14: documented, not yet fixed** | Done: the replication guide has a "Security" section with each finding, verified against a live hub. Five of the eight are now fixed in the handler (PL-6); authentication and TLS are the mounting server's job; **a pushed revision is now checked against its content (PL-6, ADR-003 amended 2026-11-15)**, though a peer that may write can still make its write win. Binding is `127.0.0.1` only |
| B7 | **No `SECURITY.md`** (private reporting channel) | **Written; `security@` alias forwards** | Enable GitHub private vulnerability reporting |
| B8 | **A clean `npm ci` fails:** `@devx-micro/app-*` is not on npmjs.org | **Closed 2026-11-25** (found the same day) | Published to npmjs.org; pinned at 0.4.1 |

### 4.2 Should fix before launch

| # | Finding | Action |
| --- | --- | --- |
| S1 | No `CODE_OF_CONDUCT.md` (the issue and PR templates and `CHANGELOG.md` are written) | Add Contributor Covenant 2.1 |
| S2 | **Doc drift.** `docs/memories/project-overview.md` says revision parity is "proven against CouchDB 3.4.3 oracle"; `AGENTS.md` says that oracle was removed (2026-09) and nothing re-checks parity | Fix the overview. A public claim contradicted by the maintainers' own notes is exactly what an early reader finds |
| S3 | Public docs named the engine's one production consumer (performance doc and bench data) | **Decided 2026-11-15: neutralise.** Every reference to it by name was removed; the docs say "a production application" or "a downstream application". Check that no private data ships in `performance-results/` or snapshots |
| S4 | README is long and opens with a thanks table | **Done** (#46 of the old repository) |
| S5 | `.claude/`, `AGENTS.md`, `.github/agents|prompts|skills` ship in the public tree | Fine to keep, and a plus for agent-assisted contributors. Confirm nothing in them is private (paths, tokens, internal URLs) |
| S6 | Sync demo has Electron and Android toolchains: heavy for a newcomer | Keep it, but give a browser-only "run it in one command" path and a recorded GIF |
| S7 | Performance "Still open" list (no cost model, one writer, no change-log retention) | Promote to the public roadmap and known-limitations page rather than leaving it in a results doc |
| S8 | Platform coverage unknown (Windows, macOS) | CI matrix; document support. **Windows: blocking CI job since #39. macOS: green, still experimental. Support stated in CONTRIBUTING and the getting-started guide** |
| S9 | Run a secret scan across full git history | `gitleaks` or GitHub secret scanning; rotate anything found **Manual pass 2026-11-14 and `gitleaks` 8.30.1 on 2026-11-15, both clean; run it again on a rewritten history and before the flip** (see below) |

**S9, what the manual pass covered (2026-11-14).** No scanner was installed then, so this was a pattern search
over all 180 commits on every branch (6.7 MB of patch). `gitleaks` was installed on 2026-11-15 (the official
release binary, checksum verified) and found nothing in 152 commits. It found: no private-key block; no AWS, GitHub, npm, Slack, OpenAI-style or Google key; no JWT; no
URL with embedded credentials; no `.env`, `.pem`, `.key`, `.p12`, `.pfx`, keystore, `.db`, `.sqlite`, `.log`, `.bak`, `.npmrc` or `.netrc` file ever committed; and no
personal path (`/home/dave`, `C:\Users\…`) or personal address in any tracked file. Two literals matched a
"secret-named variable" pattern and are benign: `DEMO_TOKEN` (the sync demo's fixed token, on purpose; see the
replication guide's Security section) and a test string, `super-secret-value-…`, that checks a diagnostic does not
echo a value. The lockfile's earlier `localhost:4873` URLs are a registry address, not a credential. **Still to do:**
run `gitleaks` again after any history rewrite, and enable GitHub secret scanning once the repository is public.

### 4.3 Nice to have

- Benchmarks against a baseline a reader cares about (raw SQLite, a TypeDB server on the same data).
  Frame as "what it costs," not "who wins".
- A "Why not X?" page: TypeDB server, plain SQLite, a general graph library.
- A browser playground (the most persuasive single asset; see 6.1).

## 5. Phases

Each phase lists its **exit criteria**. Don't start the next phase's public steps until they're met.

### Phase 0 — Legal, naming and reservations (week 1–2)

- [ ] Read TypeDB Ltd's trademark and brand policy. Summarize the constraints in one page.
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
      the Open VSX namespace. *(The GitHub organization is done: `typedblite`.)*
- [ ] Domain hygiene: auto-renew on, registrar 2FA, registrar lock, and a multi-year registration.
      `.dev` is HSTS-preloaded, so everything on it must serve valid HTTPS from day one.
- [ ] Confirm copyright holder line and MPL-2.0 headers: new files carry the notice as the project
      decides; vendored spec files keep their original headers (already the case).
- [x] Run a secret and PII scan over the full history (S9; repeat before the flip). Check `.claude/` and `.github/` content (S5).
- [x] Choose a contribution model: **DCO** (sign-off), not a CLA. *Done 2026-11-26: [`DCO`](../../../DCO) and
      [CONTRIBUTING](../../../CONTRIBUTING.md#sign-your-commits-dco).*

**Exit:** written answer or clear path on the name; reservations held; history clean.

### Phase 1 — Repository hygiene and CI (week 2–3)

*Written 2026-11-14 on branch `ccr-6f8d672b-u6bxfd`; nothing here has run on GitHub yet. The gate itself
was run locally on Node 22.23 (see [1.1](#11-what-running-the-gate-found)).*

- [x] `.github/workflows/ci.yml`: install, `build`, `typecheck`, `test` through Nx. Node 24 and 22 on
      Linux are blocking; Node 22.12.0, macOS and Windows are **experimental** (reported, not blocking)
      until seen green (B5, S8). *Windows has been blocking since #39 (2026-11-14), after two green runs.*
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
- [x] Review the hub (B6); write the findings into the replication guide as a "Security" section. *(Done; the code fixes are PL-6.)*
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
   I changed none of them. **Resolved 2026-11-14 (decision 9, below): every project is above the floor.**
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
| coverage | Failed on the known 80% floor: numbers identical to the local run. **Passes since decision 9 was taken (2026-11-14)** | Ready to make blocking: the founder's call |
| gate, Windows, Node 24 | **Build and typecheck pass; 11 tests fail** (12 before `.gitattributes`; below). **Update 2026-11-14: all four groups fixed (#38, #39); green on two complete runs** | **Blocking since #39** |
| PR title | Did not run: `pull_request_target` runs the workflow from the base branch, which does not have it yet | Starts working after merge |

**Windows, by cause.** 11 tests fail in 3 groups (the first group, below, is fixed: the run on `a6a36de` has no
conformance failure). The first count I gave here was 13; the groups were 1 + 3 + 2 + 6 = 12. The causes of
groups 2 and 3 are read from the failure messages; group 4's is unknown.

1. **Conformance `vendored.test` (1 test; all 20 vendored files "differed", `LICENSE` included): FIXED.** Git for
   Windows was converting to CRLF on checkout, which changes every file's bytes. Every tracked file is LF in the
   index. `.gitattributes` (LF everywhere, the spec directory byte-exact) cleared it: the conformance suite now
   passes on Windows.
2. **Runtime `durability` and `transaction-crash` (3 tests): FIXED in #39, with a platform-aware assertion, not
   a skip.** On Windows, Node makes `process.kill(pid, 'SIGKILL')` a `TerminateProcess`: just as abrupt, but
   reported as exit 1 with no signal. So the crash was real all along; only its proof was POSIX-only. Exit 1
   alone proves nothing, because an uncaught exception exits 1 too. So the fixtures now print a marker
   (synchronously, to fd 1) just before they kill themselves. The tests accept the kill only if the child
   printed it, wrote nothing to stderr but Node's own warnings, and died by `SIGKILL` (POSIX) or exited 1 with
   no signal (Windows). **Crash safety is now tested on Windows**, which answers the decision this item asked
   for. (Node 22.16's `ExperimentalWarning` for `node:sqlite` on stderr first failed the check on that runner;
   Node's own warnings are now ignored.)
3. **Runtime `role-player-index` (2 tests): FIXED in #39.** As diagnosed: the test never closed the
   interpreters it opened on a file. It now does. The engine has no leak: `close()` exists and works.
4. **CLI `repl.test` (6 tests): FIXED in #38.** The cause was a defect in the CLI, not the test. Its entry check
   compared the script's file name, split on `/`, with the module's URL. A Windows path has no `/`, so
   `main()` never ran and the CLI exited 0 having printed nothing. The same check failed through npm's `bin`
   link on every platform, whose name is `typedblite`, and `out/main.js` had no `#!` line for that link
   either. All three are fixed.

**Green on Windows since #39:** run 43618713890 (`c794265`) and run 43619313563 (`c2c3217`), two complete runs
with every test passing. The founder made it blocking in #39 (`experimental: false` in `ci.yml`), so a Windows failure
now fails the CI run, as a Linux one does.

Before #38 and #39: the seven CLI `main` tests, 686 of 691 runtime tests and all of conformance passed on Windows. Since #39, everything does.

**Recommended branch protection** once this PR has merged and the checks exist: require
`gate (ubuntu-latest, node 24)`, `gate (ubuntu-latest, node 22)`, `gate (ubuntu-latest, node 22.16.0)`,
`conformance report`, `gate (windows-latest, node 24)` (blocking since #39), and the PR-title check. Then `vscode e2e`, `wasm and browser` and `gate (macos-latest, node 24)`, each of which has been green on two complete runs.

🔴 **GitHub cannot enforce any of these yet.** Branch protection and rulesets return 403 for this
repository: *"Upgrade to GitHub Pro or make this repository public to enable this feature"* (checked
2026-11-14). Until the repository goes public, "required" means the job is blocking in `ci.yml`, so its
failure fails the CI run, and a pull request is merged only on a green run. Set the list above as required
status checks on the day the repository goes public.

### Phase 2 — Packaging and first release (week 3–5)

Decide the public surface deliberately (see [section 12](#12-decisions-needed)). Recommended:

| Artifact | Channel | Notes |
| --- | --- | --- |
| `@typedblite/runtime`, `@typedblite/language`, `@typedblite/content-revision`, `@typedblite/session` | npm | Publish with **provenance** (`--provenance` from GitHub Actions OIDC); include `exports`, types, a README per package, and a `files` allowlist; verify with `npm pack --dry-run` |
| `typedblite` (the CLI; was `typedblite-cli`) | npm (remove `private`) | Goal: `npx typedblite --exec '…'` works with zero clone. Needs the unscoped name |
| `typeqlite` VS Code extension | Marketplace **and** Open VSX | Already packages as a `.vsix`; add a `README`, changelog, gallery banner, categories, keywords. **Done 2026-11-15** except publishing |
| `typedblite-conformance`, `sync-demo` | Repo only | Stay private; they're evidence and demo, not products |

- [x] Versioning: SemVer, **`0.1.0`** for the first public release. Write a compatibility policy:
      pre-1.0 minor versions may break; breaking changes listed in the changelog; store format changes
      follow the "additive only" rule already in `AGENTS.md`.
      *Written 2026-11-15, for the maintainer's review: [Versions and compatibility](../../guides/compatibility.md).*
- [ ] Release automation: tag → GitHub Actions → build → test → publish → GitHub Release with notes.
      Prefer npm trusted publishing (OIDC) over a long-lived token. Where a token is needed for the first
      publish, make it a granular, package-scoped, expiring token and revoke it afterwards.
      Use Nx release or Changesets; pick one and document it in CONTRIBUTING.
      *Written, not run (2026-11-15): Nx release, chosen because the workspace is already Nx and it adds no
      dependency; `.github/workflows/release.yml`; [Releasing](../../development/releasing.md); CONTRIBUTING's
      "Releases". The workflow has never run: Actions is off.*
- [ ] A **clean-room install test**: in an empty directory, on a machine without the repo, follow the
      README exactly (npm install, first query, WASM in a Vite app, CLI via `npx`, VSIX install).
      Run this on Linux, macOS and Windows. Most launch-day pain is found here.
      *Partly done (2026-11-15): `npm run clean-room` installs the packed tarballs in an empty directory and uses
      the CLI through its `bin` link, the runtime on `node:sqlite` and on WASM, the published types and the browser
      entry. Passes on Linux (Node 24), and found the SQLite WASM peer range matching no version. Not yet: from
      **published** packages, `npx` from the registry, a Vite app (esbuild stands in), the VSIX, or the README's
      words; macOS and Windows wait on CI's `clean-room` job.*
- [ ] Dry-run the whole pipeline against a **throwaway scope** or `--dry-run` before the real publish.
      *Locally (2026-11-15): `nx release version 0.1.0-rc.1` for real without the commit, then back, and
      `nx release publish --dry-run --tag next`. The workflow's run is still to do.*
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
      guide (which starts from a clone). *Written 2026-11-15, `docs/guides/five-minute-tour.tql.md`, and run as written
      from the tarballs by `npm run tour` (a gate step); not linked from the README until the packages are on npm,
      then run it again against the registry.*
- [ ] A **Known limitations & roadmap** page *(limitations page done; roadmap not)* assembled from: `@range/@values/...` not enforced, `@card`
      only partly enforced, the 14 non-passing scenarios, and the performance "Still open" list.
- [ ] "TypeDB vs TypeDBLite" page: what's the same, what differs, when to use which. Written to be
      fair to TypeDB; ask TypeDB Ltd to read it (Phase 0 contact).
- [ ] "Why not X?" page (4.3). *Drafted 2026-11-15, `docs/guides/why-not-x.md`, for review; not linked from the README yet.*
- [x] API reference generated from TSDoc (TypeDoc) and published with the site; link from the README.
      *Generated and checked (2026-11-15): `npm run docs:api`, `npm run check-api` in the gate. Published 2026-11-17 as
      `/api/` on the site (it is pages of the site, built by `starlight-typedoc`). Linked from the README's
      Documentation table.*
- [ ] Docs site, served at `typedblite.dev` (Cloudflare; HTTPS is automatic). Layout:
      `typedblite.dev` for the landing page and docs, `/playground` for the playground, `/api` for the TypeDoc
      reference. **Built 2026-11-15, live 2026-11-17: `apps/website`** (Astro Starlight; every page generated from the
      repository's Markdown; `website:check` follows every internal link; [The website](../../development/website.md)).
      The playground is a page inside the site's Starlight layout, and the API reference is generated as pages of it
      (`starlight-typedoc`), so the whole site has one shell. It is deployed by hand to Cloudflare, as an assets-only Worker with `typedblite.dev` as its custom domain
      (`npm run deploy:site`, `apps/website/cloudflare.config.ts`; [The website](../../development/website.md)). The GitHub
      Pages plan was dropped: its workflow `site.yml` never ran and was removed, and so were the `CNAME` and `.nojekyll`
      files. Left: removing the "not on npm yet" notices at launch.
- [x] Mail on the domain: a `security@` and a `hello@` alias (forwarding is enough) so `SECURITY.md` and
      the press kit don't depend on a personal address. Add SPF/DKIM/DMARC if the aliases will send.
- [ ] Use the domain in package metadata (`homepage`), the VS Code extension manifest, the README badges,
      and the repo's website field.
- [ ] The **browser playground** (6.1), hosted on the same site. **Built 2026-11-14, hosted 2026-11-17 at `/playground/`** (`apps/playground`): the
      engine on WASM SQLite in a worker, three examples, errors that name their line, a shareable `#code=` link; 60
      unit tests and 11 in real Chromium, including that nothing leaves the page and that a program's text is never
      shown as markup. **Not done:** a real-browser test of Stop. (About 2.1 MB gzipped on a first visit; build with
      `node build.mjs --minify`.) **Updated
      2026-11-15:** the editor is now Monaco with the real language server over LSP in a worker (the extension's
      server), so highlighting, diagnostics, completion, hover, rename and formatting are the extension's.

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
3. How we know it's faithful: the behavior spec, 1,742/1,756, and the honest accounting of the other 14.
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
it (a real production consumer, unnamed); what works; what doesn't; the conformance method; one specific
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
4. **Contribution model.** DCO (recommended) or CLA. *Decided 2026-11-26: DCO.*
5. **The production consumer as a named case study** (S3). *Decided 2026-11-15 by the maintainer: no. Every
   reference to it by name is removed, and the docs call it "a production application".*
6. **Minimum Node version** after the B5 check.
7. **Launch window.** Early December versus January. *Recommendation: January 2027.*
8. **Capacity.** Who answers issues in launch week, and who is the second reviewer?
9. **Coverage policy.** Four projects are below the 80% floor (1.1). Raise tests, exempt `sync-demo`, or lower
   the floor? *Original recommendation: exempt `sync-demo`, and raise the other three, which are within about
   8 points; keep the floor at 80%.*
   **Decided 2026-11-14: raise the tests, and keep the floor at 80%.** Code that runs only inside a host
   the unit runner lacks is excluded by name, each entry saying where it IS run. No project is exempt.
   Before → after (statements / lines / functions):
   - `typeqlite-language`: 84.2 / 87.2 / **79.2** → 86.1 / 89.0 / 81.0, tests only.
   - `typeqlite-vscode`: **77.6 / 77.8 / 70.3** → 91.7 / 93.8 / 86.1, tests only.
   - `typedblite-conformance`: **72.7 / 75.2 / 79.5** → 95.6 / 99.0 / 97.8. The TypeDB oracle and the
     report script are excluded.
   - `sync-demo`: **19.4 / 20.9 / 21.5** → 91.0 / 94.4 / 87.0. The browser client, Electron, the demo driver
     and the process entries are excluded; the server is tested over HTTP.

   ⚠️ `sync-demo:test-browser`, which runs that excluded client, Electron and driver code, is not in CI.

10. **Where CI runs until launch.** Fix GitHub billing, or rely on `npm run gate` until the repository is public.
    See [Free hosting and CI](#free-hosting-and-ci-for-open-source). *Recommendation: fix billing, so the release
    candidate is not the first time CI sees the engine host, notebook and debugger.*

---

## Parking lot

Things deliberately set aside, each with the moment it must be revisited. An item stays here until it is closed.

| # | Item | Revisit before | Blocks | Status |
| --- | --- | --- | --- | --- |
| PL-1 | Revisit what this plan says about the TypeDB Ltd conversation | The repository is made public, and in any case before the announcement | Flip to public | Open |
| PL-2 | Report the Langium race upstream, and drop our workaround once it is fixed | A Langium upgrade | Nothing | Open |
| PL-3 | Keep the original commits of PRs #22 and #33 (old repository) on a branch or tag | The old repository is deleted | Deleting the old repository | Open |
| PL-4 | Decide whether to add a commit-message check | Branch protection is enabled, or the first outside pull request | Nothing | Open |
| PL-5 | Confirm CI on `main` is stable, including the Node 22 gate | The announcement | Announcement | Open: CI stopped 2026-11-17 |
| PL-6 | Harden `createChangeStreamHandler`. **Mostly done 2026-11-14:** a content-type check (415), a body-size limit (413), a cap on open streams (503), an atomic batch, and no echoing of internal errors. **Written 2026-11-15:** checking a pushed revision against its content, with tests and an ADR-003 amendment, accepted 2026-11-15. Authentication and TLS stay the mounting server's job | The sync story is promoted | Promoting sync | Done |

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
document is already `Validated` and marked complete. A build canceled in that gap drops the listener that sends the
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

Both pull requests are in the old, private repository.

**To do:** there, push a branch or tag for each (for example `archive/pr-22`, `archive/pr-33`) so they stay reachable
whatever GitHub does with PR refs. That is non-destructive. It needs the maintainer's OK, because it creates refs
beyond the working branch. `main` is not rewritten.

### PL-4. A commit-message check

With merge commits every commit message is kept, so the PR-title check (which guards only the merge commit's
title) is no longer the best fit. A per-commit Conventional Commits check would be, but it would also reject
`Merge branch ...` commits inside a pull request. Decide before enabling branch protection, or when the first
outside pull request arrives.

### PL-5. Confirm CI on `main` is stable

The Node 22 gate failed once on `main`, from the Langium race, and has passed since. One clean run proves little:
three clean runs on pull requests did not prove it before. The push runs on `main` for `983f738` and `90cf7d8`
(docs and CI changes only) have not been read.

**To do:** read the push runs on `main` as they arrive. Any intermittent failure of `typeqlite-vscode`'s
`server.test.ts` means the fix is incomplete. Treat several consecutive clean runs, not one, as the bar.

---

*Verification notes.* Facts in this plan about the repository (versions, missing files, conformance
numbers, package visibility, documents' contents) were read directly from it on 2026-11-14; Where to resume and the
free-tier table were checked on 2026-11-25. Items marked
"To check" were not verified. External facts (marketplace and community-site rules, TypeDB Ltd's trademark
policy, Node release details) were not looked up and must be confirmed before acting.
