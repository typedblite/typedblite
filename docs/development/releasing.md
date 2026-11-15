# Releasing

How the npm packages are versioned, checked and published. The promises a version makes to users are in
[Versions and compatibility](../guides/compatibility.md). This page is how a maintainer keeps them.

> **Status: nothing has been released, and the release workflow has never run.** GitHub Actions has been
> off since 2026-11-14 (billing). Everything on this page that runs locally has been run (see
> [What has been checked](#what-has-been-checked)). The workflow, the OIDC exchange with npm, and provenance
> have not.

## What is released, and with what

| Artifact | Where | Version |
| --- | --- | --- |
| `@typedblite/content-revision`, `@typedblite/language`, `@typedblite/runtime` | npm | One version for all four, released together |
| `typedblite` (the CLI, `apps/cli`) | npm | The same version |
| The `typeqlite` VS Code extension, and the TypeQLite Theme Bridge (`typeqlite-theme`) | VS Code Marketplace and Open VSX | Each its own version: [below](#the-vs-code-extensions) |
| `typedblite-conformance`, the playground, the sync demo | Not published | `private: true` |

The list of published packages is [`tools/publishable.mjs`](../../tools/publishable.mjs). `release.projects`
in `nx.json` must name the same projects, and `npm run check-packages` fails if it doesn't.

**The tool is Nx release** (`nx release`), not Changesets. The workspace already runs on Nx, so it adds no
dependency. It versions the four packages as one fixed group, rewrites their dependencies on each other,
updates the lockfile, and publishes in dependency order. Its config is the `release` block in `nx.json`.
The changelog stays hand-written ([CHANGELOG.md](../../CHANGELOG.md), Keep a Changelog), so Nx's changelog
generation is off.

## The checks a package must pass

All three run in `npm run gate` (the clean room only in the full gate, not `--quick`), in CI, and in the
release workflow:

- **`npm run check-api`** ([`tools/check-api.mjs`](../../tools/check-api.mjs)) builds the API reference with
  TypeDoc, every warning an error, and fails if a public signature mentions a type the package does not export.
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
- **`npm run clean-room`** ([`tools/clean-room.mjs`](../../tools/clean-room.mjs)) packs the four tarballs and
  installs them in an empty directory outside the repository, with their dependencies from the registry, and
  then: runs the CLI through its `bin` link against a file database; runs the runtime on `node:sqlite` with the
  language and content-revision packages; runs it on WASM SQLite in Node; type-checks the published
  declarations with `tsc` and `skipLibCheck: false`; and bundles the `browser` export condition for a browser,
  failing if it reaches a `node:` module. `-- --keep` leaves the directory for a look.

Each check of both scripts has been seen to fail on a broken package (a missing `files` list, a CLI with no
`#!` line, a declaration naming a type that does not exist, a `node:` import in the browser entry).

## One-time setup

Only the maintainer can do these, once, before the first release:

1. **Claim the unscoped `typedblite` name on npm** for the CLI (`npx typedblite` needs it), and `typeqlite`
   to protect it. The `@typedblite` org already covers the three libraries. Require 2FA for every member of
   the org, and add a second owner.
2. **Take `"private": true` off `apps/cli/package.json`.** It is there so that nothing can publish the CLI
   until its name is held. `nx release publish` skips a private package and says so, and the dry run shows
   three packages until then.
3. **Create a GitHub environment named `npm`** (Settings → Environments) with yourself as a required
   reviewer, so that a pushed tag waits for your approval before anything is published.
4. **The first publish of each package needs a token**, because npm only lets a package that exists have a
   trusted publisher. Create a granular access token limited to the four packages (and the org, to create
   them), with a short expiry. Save it as the repository secret `NPM_TOKEN`.
5. **After the first publish, switch to trusted publishing.** On npmjs.com, for each package: Settings →
   Trusted publishing → GitHub Actions, repository `typedblite/typedblite`, workflow `release.yml`, environment `npm`. Then delete the `NPM_TOKEN` secret,
   revoke the token, and set each package to require 2FA and disallow tokens.

## Making a release

1. **On a branch, write the release.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [0.1.0-rc.1] - YYYY-MM-DD` and start a new, empty `## [Unreleased]` above it. Then:

   ```bash
   npm exec nx -- release version 0.1.0-rc.1
   ```

   That builds, runs `check-packages`, sets the version in the four manifests and their dependencies on each
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

**While Actions is off,** there is no provenance, because provenance is signed by the CI run. A package can
be published from a laptop (`npm login`, then `npm exec nx -- release publish --tag next`), but it would have
no provenance, and the plan says to publish with it. Whether to wait is the maintainer's call.

## The VS Code extensions

Two extensions, published by `typedblite`: **TypeQLite** (`apps/vscode`) and the **TypeQLite Theme Bridge**
(`apps/vscode/theme-bridge`), which a remote window needs to colour Markdown previews. Each has its own version in
its `package.json` and its own `CHANGELOG.md`, and is released by its own tag. They are not versioned with the npm
packages.

`npm exec nx -- run typeqlite-vscode:package` builds both, as `apps/vscode/dist/<name>-<version>.vsix`, named by
`vsce` from each manifest. `typeqlite-vscode:e2e` packages them, installs both into a downloaded VS Code and runs its
cases against the installed copies, so it is the check that what would be published works. It runs in the full gate.

### One-time setup

Only the maintainer can do these, once:

1. **The Visual Studio Marketplace publisher `typedblite`.** Create it at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), signed in with a Microsoft
   account. Create an Azure DevOps personal access token with the **Marketplace (Manage)** scope, for all accessible
   organizations, with a short expiry. Save it as the secret `VSCE_PAT`.
2. **The Open VSX namespace `typedblite`.** Sign in to [open-vsx.org](https://open-vsx.org) with GitHub, link an
   Eclipse account and sign the Eclipse Foundation Open VSX Publisher Agreement, then create an access token. Create
   the namespace with `npx ovsx@1.3.0 create-namespace typedblite -p <token>`, and ask for it to be verified (an issue
   on the open-vsx.org repository), so that it shows as the official publisher. Save the token as `OVSX_PAT`.
3. **A GitHub environment named `marketplaces`**, holding both secrets, with yourself as a required reviewer.

Both marketplaces show the README, and rewrite its relative links to the repository on GitHub, so the links work
once the repository is public.

### Making a release

1. **On a branch:** set the version in the extension's `package.json`, rename `## [Unreleased]` in its
   `CHANGELOG.md` to `## [<version>] - YYYY-MM-DD`, run `npm run gate`, and open a pull request.
2. **Merge it, then tag the merge commit on `main`:** `typeqlite-v<version>` for TypeQLite, or
   `typeqlite-theme-v<version>` for the Theme Bridge, and push the tag.
3. **Approve the run.** [`release-extension.yml`](../../.github/workflows/release-extension.yml) checks the tag
   against the manifest and the changelog, builds, packages, runs the e2e under `xvfb-run`, then waits for approval
   on `marketplaces`. It publishes the `.vsix` to both marketplaces (a version with a `-` as a pre-release) and
   creates the GitHub Release with the `.vsix` attached.

**Checked by hand (2026-11-15):** both extensions package with their marketplace metadata (keywords, gallery banner,
`homepage`, `bugs`, a changelog), and with both versions set to `0.0.2` the `package` and `e2e` targets built,
installed and passed (19 cases) with no other edit. Then back to `0.0.1`. The release-notes step reads each
extension's changelog. The `vsce` and `ovsx` options the workflow uses were checked against `vsce publish --help`
and `ovsx` 1.3.0's source. **Not checked:** the workflow, the tokens, and a real publish.

## What has been checked

Run by hand on Linux, Node 24.19, on 2026-11-15:

- `check-packages` and `clean-room` pass, and each of their checks has been seen to fail on a broken package.
- `nx release version 0.1.0-rc.1` for real, without the commit: the four manifests, their internal
  dependencies and the lockfile moved to `0.1.0-rc.1`, and every private workspace package still linked the
  local copy. The clean room passed at that version. Then back to `0.0.1`.
- `nx release publish --dry-run --tag next`: three packages (the CLI is private) to
  `https://registry.npmjs.org/` with the `next` tag.
- The workflow's version, release-notes, npm-version and dist-tag logic, run as shell.

**Not checked:** the workflow on GitHub, OIDC and provenance, a real publish, the clean room on Node 22.16
(not installed here), macOS and Windows. CI's `clean-room` job covers the last three once Actions is on.
