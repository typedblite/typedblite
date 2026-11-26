# Releasing

How the npm packages are versioned, checked and published. The promises a version makes to users are in
[Versions and compatibility](../guides/compatibility.md). This page is how a maintainer keeps them.

> **Status: nothing has been released, and neither release workflow has run.** Everything on this page that runs
> locally has been run (see [What has been checked](#what-has-been-checked)). The workflows, the OIDC exchange with
> npm, and provenance have not.

## What is released, and with what

| Artifact | Where | Version |
| --- | --- | --- |
| `@typedblite/content-revision`, `@typedblite/language`, `@typedblite/runtime`, `@typedblite/session`, `@typedblite/node-host` | npm | One version for all six, released together |
| `typedblite` (the CLI, `apps/cli`) | npm | The same version |
| The TypeDBLite VS Code extension (`typedblite-workbench`), and the TypeQLite Theme Bridge (`typeqlite-theme`) | VS Code Marketplace and Open VSX | One version for both: [below](#the-vs-code-extensions) |
| `typedblite-conformance`, the playground, the sync demo | Not published | `private: true` |

The list of published packages is [`tools/publishable.mjs`](../../tools/publishable.mjs). `release.projects`
in `nx.json` must name the same projects, and `npm run check-packages` fails if it doesn't.

**The tool is Nx release** (`nx release`), not Changesets. The workspace already runs on Nx, so it adds no
dependency. It versions the six packages as one fixed group, rewrites their dependencies on each other,
updates the lockfile, and publishes in dependency order. Its config is the `release` block in `nx.json`.
The changelog stays hand-written ([CHANGELOG.md](../../CHANGELOG.md), Keep a Changelog), so Nx's changelog
generation is off.

## The checks a package must pass

All three run in `npm run gate` (the clean room only in the full gate, not `--quick`), in CI, and in the
release workflow:

- **`npm run check-api`** ([`tools/check-api.mjs`](../../tools/check-api.mjs)) builds the API reference with
  TypeDoc, every warning an error, and fails if a public signature mentions a type the package does not export, or if a
  name the API exports, or a member a class or interface declares, has no doc comment.
  `npm run docs:api` writes the reference as HTML to `dist/api`.

- **`npm run check-packages`** ([`tools/check-packages.mjs`](../../tools/check-packages.mjs)) reads
  `npm pack --dry-run`, the exact file list `npm publish` would use, for each package. It fails if: a file
  that `main`, `bin`, `exports` or `imports` names is missing; a test, tsconfig, Vitest config, build-info or
  Nx file would ship; a source map names a file that is not shipped; `README.md` or `LICENSE` is missing, or
  the `LICENSE` differs from the root one; the CLI's `bin` lacks its `#!/usr/bin/env node` line; the license,
  `engines`, `repository`, `bugs` or `homepage` disagree with the repository; a scoped package lacks
  `publishConfig.access: "public"`; the versions differ, or a package depends on another at a version other
  than the one being released; or a private workspace package depends on a published one at anything but
  `"*"`. It also checks `nx.json`: the release projects, and that publishing goes to
  `https://registry.npmjs.org/`.
- **`npm run clean-room`** ([`tools/clean-room.mjs`](../../tools/clean-room.mjs)) packs the six tarballs and
  installs them in an empty directory outside the repository, with their dependencies from the registry, and
  then: runs the CLI through its `bin` link against a file database; runs the runtime on `node:sqlite` with the
  language and content-revision packages; runs it on WASM SQLite in Node; runs a transaction through `node-host`; type-checks the published
  declarations with `tsc` and `skipLibCheck: false`; and bundles the `browser` export condition for a browser,
  failing if it reaches a `node:` module. `-- --keep` leaves the directory for a look.

Each check of both scripts has been seen to fail on a broken package (a missing `files` list, a CLI with no
`#!` line, a declaration naming a type that does not exist, a `node:` import in the browser entry).

## One-time setup

Only the maintainer can do these, once, before the first release:

1. **Claim the unscoped `typedblite` name on npm** for the CLI (`npx typedblite` needs it), and `typeqlite`
   to protect it. The `@typedblite` org already covers the five libraries. Require 2FA for every member of
   the org, and add a second owner.
2. **The CLI is publishable:** `apps/cli/package.json` has no `"private": true`. *Done with 0.1.0-rc.1.*
3. **The GitHub environment `npm`** (Settings → Environments) has the maintainer as a required reviewer, so that a
   pushed tag waits for approval before anything is published. *Created 2026-11-26.*
4. **The first publish of each package needs a token**, because npm only lets a package that exists have a
   trusted publisher. Create a granular access token with read and write access to **all packages** (the unscoped
   `typedblite` does not exist yet, so a token cannot be limited to it) and to the `@typedblite` org, with
   "bypass two-factor authentication" and a short expiry. Save it as the secret `NPM_TOKEN` of the `npm`
   environment, so only an approved run can read it:

   ```bash
   gh secret set NPM_TOKEN --env npm --repo typedblite/typedblite
   ```

5. **After the first publish, switch to trusted publishing.** On npmjs.com, for each package: Settings →
   Trusted publishing → GitHub Actions, repository `typedblite/typedblite`, workflow `release.yml`, environment `npm`. Then delete the `NPM_TOKEN` secret,
   revoke the token, and set each package to require 2FA and disallow tokens.

## Making a release

1. **On a branch, write the release.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [0.1.0-rc.1] - YYYY-MM-DD` and start a new, empty `## [Unreleased]` above it. Then:

   ```bash
   npm exec nx -- release version 0.1.0-rc.1
   ```

   That builds, runs `check-packages`, sets the version in the six manifests and their dependencies on each
   other, updates the lockfile, and commits `chore(release): v0.1.0-rc.1`. It does **not** tag. Run
   `npm run gate`, and open a pull request.
2. **Merge it** (a merge commit, as always).
3. **Tag the merge commit on `main`, and push the tag:**

   ```bash
   git switch main && git pull --ff-only
   git tag -a v0.1.0-rc.1 -m v0.1.0-rc.1
   git push origin v0.1.0-rc.1
   ```

4. **Approve the run.** [`release.yml`](../../.github/workflows/release.yml) checks that the tag matches the
   packages' version and that the changelog has a section for it, then runs the build, type-check, tests,
   `check-packages` and `clean-room`. Then it waits for approval on the `npm` environment, publishes with
   provenance (a version with a `-` goes to the `next` dist-tag, anything else to `latest`), and creates the
   GitHub Release from the changelog section.

To see what a release would do without doing it:

```bash
npm exec nx -- release version 0.1.0-rc.1 --dry-run   # the version changes, and the commit it would make
npm exec nx -- release publish --dry-run --tag next   # each tarball, and where it would go
```

**Without CI** there is no provenance, because provenance is signed by the CI run. A package can
be published from a laptop (`npm login`, then `npm exec nx -- release publish --tag next`), but it would have
no provenance, and the plan says to publish with it. Whether to wait is the maintainer's call.

## The VS Code extensions

Two extensions, published by `typedblite`: **TypeDBLite** (`apps/vscode`) and the **TypeQLite Theme Bridge**
(`apps/vscode/theme-bridge`), which a remote window needs to color Markdown previews. The two share one version, set in
both `package.json` files, and a manifest test holds them to it. Each has its own `CHANGELOG.md`, and one tag releases
both. They are not versioned with the npm packages.

The TypeDBLite extension's first published version is 0.3.1: the editor, notebooks and the debugger are its three
features so far. 1.0.0 is the release that adds the Live Data Graph Explorer, which makes it feature complete.

`npm exec nx -- run typeqlite-vscode:package` builds both, as `apps/vscode/dist/<name>-<version>.vsix`, named by
`vsce` from each manifest. `typeqlite-vscode:e2e` packages them, installs both into a downloaded VS Code and runs its
cases against the installed copies, so it is the check that what would be published works. It runs in the full gate.

### One-time setup

Only the maintainer can do these, once:

1. **The Open VSX namespace `typedblite`.** Sign in to [open-vsx.org](https://open-vsx.org) with GitHub, link an
   Eclipse account and sign the Eclipse Foundation Open VSX Publisher Agreement. *The namespace is verified.*
2. **The first publish of each extension, by hand, with an access token.** Open VSX registers a trusted publisher only
   for an extension that already has a published version. Create a token at
   [open-vsx.org/user-settings/tokens](https://open-vsx.org/user-settings/tokens), then, from an up-to-date `main`:

   ```bash
   read -rs OVSX_PAT && export OVSX_PAT
   npm run deploy:vsx
   unset OVSX_PAT
   ```

   Revoke the token afterwards.
3. **A trusted publisher for each of the two extensions**, `typedblite-workbench` and `typeqlite-theme`, at
   [open-vsx.org/user-settings/trusted-publishers](https://open-vsx.org/user-settings/trusted-publishers), as a
   namespace owner ([the guide](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing)). Choose GitHub
   Actions, with these values:

   | Field | Value |
   | --- | --- |
   | Organization or user | `typedblite` |
   | Repository | `typedblite` |
   | Workflow filename | `release-extension.yml` |
   | Environment | `marketplaces` |

   A registration cannot be edited: delete it and make it again. The environment is what limits who can publish,
   because the registration trusts the workflow file on any branch or tag.
4. **The GitHub environment `marketplaces`** has the maintainer as a required reviewer (*created 2026-11-26*). Open
   VSX needs no secret in it.
5. **Optionally, the Visual Studio Marketplace.** Create the publisher `typedblite` at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and an Azure DevOps personal
   access token with the **Marketplace (Manage)** scope, with a short expiry. Save it in the `marketplaces`
   environment as `VSCE_PAT`. Without it the workflow publishes to Open VSX only.

Both marketplaces show the README, and the packaging resolves its relative links from the repository's root, not from
the extension's folder, so they break. A shipped README or changelog links with full URLs, and a manifest test checks it.

### Making a release

1. **On a branch:** set the version in both extensions' `package.json`, rename `## [Unreleased]` in each
   `CHANGELOG.md` to `## [<version>] - YYYY-MM-DD` (saying so if one of them did not change), run `npm run gate`, and
   open a pull request.
2. **Merge it, then tag the merge commit on `main`**, and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a typedblite-v0.3.2 -m typedblite-v0.3.2
   git push origin typedblite-v0.3.2
   ```

3. **Approve the run.** [`release-extension.yml`](../../.github/workflows/release-extension.yml) checks the tag
   against both manifests and changelogs, builds, packages and runs the e2e under `xvfb-run`, then waits for approval
   on `marketplaces`. It publishes both `.vsix` files to Open VSX (and to the Visual Studio Marketplace, if `VSCE_PAT`
   is set) and creates the GitHub Release with both attached.

**Pre-releases.** A version is always plain `x.y.z`, because the Marketplace refuses a suffix such as `-rc.1`. To
publish one as a pre-release, end the tag in `-pre` (`typedblite-v0.3.2-pre`). A version published as a pre-release is
used up: the stable release takes a higher number.

**By hand, to Open VSX only:** `npm run deploy:vsx` packages both extensions and publishes both
([`tools/deploy-vsx.mjs`](../../tools/deploy-vsx.mjs)), reading the token from `OVSX_PAT`. It takes `-- --pre-release`
and `-- --dry-run`.

**Checked by hand (2026-11-15):** both extensions package with their marketplace metadata (keywords, gallery banner,
`homepage`, `bugs`, a changelog), and with both versions set to `0.0.2` the `package` and `e2e` targets built,
installed and passed (19 cases) with no other edit. Then back to `0.0.1`. The release-notes step reads each
extension's changelog. The `vsce` and `ovsx` options the workflow uses were checked against `vsce publish --help`
and `ovsx` 1.3.0's source. **Not checked:** the publish job, Trusted Publishing and a real publish.

## What has been checked

Run by hand on Linux, Node 24.19, on 2026-11-15:

- `check-packages` and `clean-room` pass, and each of their checks has been seen to fail on a broken package.
- `nx release version 0.1.0-rc.1` for real, without the commit: the five manifests, their internal
  dependencies and the lockfile moved to `0.1.0-rc.1`, and every private workspace package still linked the
  local copy. The clean room passed at that version. Then back to `0.0.1`.
- `nx release publish --dry-run --tag next`: three packages (the CLI is private) to
  `https://registry.npmjs.org/` with the `next` tag.
- The workflow's version, release-notes, npm-version and dist-tag logic, run as shell.

**Not checked:** the workflow on GitHub, OIDC and provenance, a real publish, the clean room on Node 22.16
(not installed here), macOS and Windows. CI's `clean-room` job covers the last three once Actions is on.
