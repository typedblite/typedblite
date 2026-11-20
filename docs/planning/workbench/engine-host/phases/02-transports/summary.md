---
kind: summary
status: complete
feature: engine-host
phase: 02-transports
---

# Phase 02 — CLI, REPL and sidecar: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/engine-host/02-transports` · **Checklist:** [checklist.md](checklist.md)

## Goal

Make the host a process with three transports, built on `@devx-micro/app-*` (ADR-011 D10), and prove they
cannot drift from the core.

## What was built

- **Twelve operation descriptors** (`operations.ts`), each with a `validate` hook and an `inputSchema`, so that
  the CLI, REPL, sidecar, and later HTTP and MCP, all read one declaration (invariant 5).
- **`typedblite-host`** (`main.ts`): `defineApp` from `@devx-micro/app-main`. `--repl`, `--sidecar`, an operation
  name for one shot, and an unrecognized flag refused by name with exit 2. A bare run prints help and starts
  nothing, because there is no HTTP mode yet.
- **`session.run` takes a `location`** (open, run, close in one call), as the feature document said it should
  over the CLI. It works on every transport, so the answer is the same however it is reached.
- **Nest logs only errors, to stderr**, so a log line never breaks the sidecar's one-envelope-per-line stdout.

## What was proven

- The same eight-step flow through the CLI, the sidecar and the REPL gives the same data, status and error
  codes, and the CLI and sidecar also agree on exit code and kind. The REPL answers in prose, so its kind and exit
  code are not compared. A mutation that made the REPL run a different statement failed it.
- The built binary, as a process: the exit codes, the refused flags, and the sidecar through `SidecarClient`.
- ESM imports the CommonJS `@devx-micro` packages with named imports, as the host's `"type": "module"` needs.

## Decisions made while building

- **An engine refusal is an envelope with exit code 0** and `data.kind: "refused"`. The feature says refusals
  are data, and the alternative (a non-zero exit) would throw away the rows and diagnostics. The cost: a shell
  script must read `data.kind`, not `$?`. Worth revisiting before the explorer relies on it.
- **A `refused` run and a fault are different things.** A bad session id or an unopenable file is an error
  envelope (`SESSION_NOT_FOUND` 5, `OPEN_FAILED` 10), with a code to branch on.

## A mistake of mine, fixed here

Phase 01 committed the build output of `libs/session` and `apps/engine-host` (40 files under `out/`, and two
`tsbuildinfo` files), and PR #47 merged them. Every other project has a `.gitignore` for `out` and
`*.tsbuildinfo`; I did not add one for the two new projects, and `git add -A` took the output. This phase adds
both `.gitignore` files and removes the output from the index. `main` has not received them: the feature branch
has not been merged to it.

## What was not done

- The WASM, browser, e2e and clean-room gate steps.
- **The lockfile's six `@devx-micro` entries** resolve to `https://registry.npmjs.org/…`, where those packages
  are not published yet, with the integrity the local registry gave. They need `npm install` again, and the
  integrity checking, once the packages are on npmjs.org. A public `npm ci` fails until then.
- HTTP and MCP: the parity spec gains them in Phases 03 and 04.

## For Phase 03

`app-main`'s `http.createApp` builds the Nest application; the generic dispatch route comes from
`@devx-micro/app-http` (`unwrap` renders an envelope as a response or an `HttpException`). The parity spec
adds HTTP as a fourth transport.
