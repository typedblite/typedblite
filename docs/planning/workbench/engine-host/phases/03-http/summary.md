---
kind: summary
status: complete
feature: engine-host
phase: 03-http
---

# Phase 03 — HTTP: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/engine-host/03-http` · **Checklist:** [checklist.md](checklist.md)

## Goal

HTTP as generic dispatch over the operation list, loopback only, and a fourth transport in the parity spec.

## What was built

- **Two routes** (`http.ts`), under `/api/typedblite-host`: `GET /help` (the operations and their input schemas)
  and `POST /ops/:operation`, which dispatches any operation through the one runtime and renders its envelope
  with `unwrap` from `@devx-micro/app-http`. An operation added to `operations.ts` is reachable with no change here.
- **A bare `typedblite-host` serves**, on `TYPEDBLITE_HOST_PORT` (default 3470). A typo still cannot start a
  server: the unknown-flag refusal comes first.
- **Loopback only, three ways:** the listener is bound to `127.0.0.1`, a request whose peer is not loopback is
  refused (403), and so is one whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`. The third is
  DNS-rebinding protection: a web page can make the browser reach loopback, and the host runs statements against
  real stores.

## What was proven

- The same flow through the CLI, the sidecar, the REPL and HTTP gives the same data, status and error codes.
- Removing the loopback listener fails a spec, and so does removing the `Host` check.
- A built process serves, answers, and ends on SIGTERM; `--repel` still exits 2 and starts nothing.

## Found while building

- **`defineApp` binds every interface.** It calls `app.listen(port)`. The host is loopback only, so the host
  supplies an Express adapter whose `listen` always passes `127.0.0.1`.
- **Patching `app.listen` silently does nothing.** Nest's application is a Proxy whose `set` trap discards the
  assignment, so the obvious fix type-checks, looks right and leaves the server open to the network. I wrote
  exactly that first, and saw it in `ss` (`*:3499`). Replacing it with `defineProperty` recursed, and calling the
  class method from outside the proxy failed on `this.isListening = true`. The adapter is the seam Nest offers.
  The first spec reads the bound address so this cannot regress unseen.
- **Suggestion for devx-micro, not done:** a `host` option on `AppHttpDefinition`, so an app that must be loopback
  does not need an adapter. It is the maintainer's repository.

## Decisions made while building

- **An engine refusal is a 200** with `kind: "refused"`, as it is exit code 0 on the CLI. Faults map through
  `@devx-micro/app-http`: 400, 404, 409, 503.
- **No CORS, no authentication.** A cross-origin page cannot read an answer, and the `Host` check blocks
  rebinding. Authentication and a wider listener stay out of scope.

## What was not done

- The WASM, browser, e2e and clean-room gate steps.
- The lockfile's devx-micro entries still point at npmjs.org URLs that do not exist yet (Phase 02's note).

## For Phase 04

MCP. `@devx-micro` has no MCP transport, so where it lives (the host, or a new `app-mcp`) is decided first.
Tools only, reads by default, a write tier behind `--mcp-write`, HTTP MCP on loopback only. The `Host` and peer
check in `http.ts` is what an HTTP MCP listener should reuse.
