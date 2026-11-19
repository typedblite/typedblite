---
kind: adr
status: accepted
date: 2026-11-19
decision-owners: [Founder, TypeDBLite maintainers]
extends: [adr-008]
---

# ADR-011: The workbench runs TypeQLite in a separate engine-host process

- **Status:** Accepted on 2026-11-19. The founder decided on 2026-11-17 that the host is a standalone
  NestJS CQRS app with five transports, and on 2026-11-19 accepted the nine answers below, and on 2026-11-19 chose `@devx-micro/app-*` (D10).
- **Date:** 2026-11-19
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-008](adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md).
  The editor only reads `.tql`. Running a statement is a separate job, done in another process.

---

## Context

The graph explorer, the debugger and the notebook each need to run TypeQLite from the editor. The
editor never loads the runtime. Building the job three times would decide a statement's meaning in
three places.

Measured on 2026-11-19:

| Fact | Consequence |
| ---- | ----------- |
| Two `node:sqlite` connections on one file, journal mode `delete`: while one has an open transaction, the other's write fails with `database is locked`, and its reads succeed and see committed rows only | SQLite can arbitrate two sessions on one file. Raw `node:sqlite` was tested, not `SqliteEngine`, which Phase 01 re-checks |
| The VS Code remote server on this WSL install ships Node 24.22 with `node:sqlite` | A `node` the extension launches works. The desktop Electron's own Node was **not** verified |
| `apps/cli/src/session.ts` has a location, `run`, a textual classifier and `splitStatements`; no transactions, facts, id or restart | The host's core generalises it |
| Nothing in the repository depends on `@nestjs/*` | The decision to add it is this ADR's |

## Decision

**D1. The engine runs in a separate process, the host, in `apps/engine-host`.** The extension never
imports it and never loads the runtime. It starts the host and sends operations over the **sidecar**
(newline-delimited JSON on stdio). The host is launched with a `node` found on the user's PATH, or
the path in a `typedblite.host.node` setting. Node ≥ 22.16, which the runtime already requires.
Electron's own Node is a fallback only once `node:sqlite` has been verified there. A packaged binary
is out of scope. **Phase 05 (2026-11-19):** the extension ships the host as a bundle (`out/host/sidecar.cjs`),
probes the `node` before using it (version and `node:sqlite`), and says what is wrong. It does **not** fall back
to Electron's Node: measured, VS Code 1.146 (Electron 43, Node 24.22) run as plain Node has `node:sqlite`, but
`engines.vscode ^1.91` covers VS Code builds with Node 20, which has none, and `SidecarClient` cannot set
`ELECTRON_RUN_AS_NODE` for a child. A fallback needs an `env` option there.

**D2. NestJS enters the repository, fenced into that one app.** `@typedblite/runtime` and
`@typedblite/language` take no dependency on it (feature invariant 7). The host is **not published**
for now. Publishing it later changes nothing else.

**D3. The host's session core replaces `TypeDBLiteSession`.** The `typedblite` CLI moves onto the
core and its specs pass unchanged. The CLI stays a separate binary, so the published CLI does not
take NestJS. **Amended 2026-11-19 (Phase 01):** because the CLI is published and the host is private,
the core cannot live in the host. It lives in a new, NestJS-free, **published** package,
`@typedblite/session` (`libs/session`): the session, the statement classifier and `splitStatements`.
The CLI and the host both depend on it, and the host adds NestJS and the buses. This makes five
published packages, not four. The runtime's exports do not change (D9).

**D4. Names.** App `apps/engine-host`, package `@typedblite/engine-host` (private), binary
`typedblite-host`, operations `session.open`, `session.run`, `session.begin`, `session.commit`,
`session.rollback`, `session.restart`, `session.close`, `session.get`, `session.list`,
`schema.get`, `statement.classify`, and `statement.split`.

**D5. Two sessions may open one file.** SQLite arbitrates. A lock failure comes back as data, a
refusal that names the lock. A session never shares a store handle with another (invariant 4).

**D6. `session.run` runs exactly one statement.** `statement.split` splits a source. The caller
decides what a failure part-way means, and the host never half-applies silently.

**D7. The debugger's route is left to the debugger.** Its Phase 00 decides between an operation such
as `session.trace` and the adapter loading the runtime. The host stays neutral.

**D8. MCP exposes tools only, reads by default.** Reads are `schema.get`, `session.get`,
`session.list`, `statement.classify`, `statement.split`, and `session.run` limited to statements
that classify as reads. `--mcp-write` opts into writes. HTTP MCP is loopback only. **Made exact in Phase 04:** `session.open` and the
transaction and close operations are not read-tier tools; a read-tier `session.run` runs only a statement the
host's own classifier calls a read (the classifier that routes it to the interpreter's `query`, which cannot
write), and refuses a `location` that does not exist, because opening a missing path creates a file. `--mcp-write`
is a tier and not a mode, so it is refused alone.

**D9. The operation set is internal.** It is not public API until the host is published. The
`@typedblite/runtime` exports do not change.

**D10. The host is built on `@devx-micro/app-*`** (the founder's own shared libraries, MPL-2.0):
`app-runtime` for the one dispatch path and its result envelope, `app-cli`, `app-repl`,
`app-sidecar` and `app-http` for four transports, and `app-main` for the entry point and mode
dispatch. The host declares its operations once and writes no transport of its own. The editor's
client uses `SidecarClient`. Those packages have no MCP transport. **Decided 2026-11-19 (Phase 04): MCP is written in the host**,
not as an `app-mcp` in devx-micro. The read-tier policy is specific to this host's operations, and it can be
lifted into devx-micro once a second app wants it. All seven
packages are on the local registry (checked 2026-11-19), and none is on npmjs.org, so **a public `npm ci` needs all of them published first**.
That blocks publishing the repository, not building the host.

## Consequences

- The dependency graph in `AGENTS.md` gains `engine-host -> runtime`. `vscode -> language` is
  unchanged.
- Users of the workbench need Node ≥ 22.16 on PATH.
- The host adds a dependency tree to `apps/`, and none to the engine.
- The debugger's execution model, and the notebook's restart, can now rely on a process boundary.

## Found while building the core (Phase 01)

A session opened on a file **before** another session's `define` does not see that schema, because the
interpreter loads a file's schema when it opens. It refuses with `no-schema` until it restarts. The host
reports this and does not work round it (invariant 2). Whether the engine should refresh the schema is
the engine's decision, not the host's.

## Not decided here

How the debugger reaches the step hook (D7), and the webview stack, which the explorer or the
notebook decides in its own Phase 00.
