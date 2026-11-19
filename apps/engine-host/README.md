# @typedblite/engine-host

The TypeQLite **engine host** of the workbench: a NestJS CQRS app that runs statements in **sessions**, so the
graph explorer, the debugger and the notebook share one meaning of "run this statement"
([ADR-011](../../docs/architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md),
[feature document](../../docs/planning/workbench/engine-host/engine-host.feature.md)).

**Private, and in progress.** The core, and the CLI, REPL, sidecar and HTTP transports (Phases 01 to 03). MCP
(Phase 04) is not built. The transports are `@devx-micro/app-*` ([ADR-011](../../docs/architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md) D10).

## The operations

Each is a command or a query on the CQRS buses, declared once. A transport sends them through the buses and
does nothing else.

| Kind | Operation | Class |
| ---- | --------- | ----- |
| Command | `session.open` | `OpenSessionCommand(location = ':memory:', schema?)` |
| Command | `session.run` | `RunStatementCommand(sessionId, statement)`, exactly one statement |
| Command | `session.begin`, `session.commit`, `session.rollback` | `BeginTransactionCommand` and the like |
| Command | `session.restart`, `session.close` | `RestartSessionCommand`, `CloseSessionCommand` |
| Query | `session.get`, `session.list` | `GetSessionQuery`, `ListSessionsQuery` |
| Query | `schema.get` | `GetSchemaQuery(sessionId)` |
| Query | `statement.classify`, `statement.split` | `ClassifyStatementQuery`, `SplitStatementsQuery` |

A statement the engine refuses comes back as a `refused` result with the engine's own message. A fault in the
host's own protocol (an unknown session id, a file that will not open) is a `HostError` with a `code` and an
`exitCode`.

## Run it

```bash
npm exec nx -- run engine-host:build

node apps/engine-host/out/main.js statement.classify --statement 'insert $a isa a;'   # one operation, one JSON envelope
node apps/engine-host/out/main.js --repl                                              # a prompt over the operations
node apps/engine-host/out/main.js --sidecar                                           # JSON lines on stdio: the editor's way in
node apps/engine-host/out/main.js                                                     # HTTP on 127.0.0.1:3470
```

| `argv` | Mode |
| ------ | ---- |
| an operation name | One operation. An envelope on stdout, and its exit code (0 success, 2 bad input, 3 conflict, 5 not found, 10 infrastructure) |
| `--repl` | The REPL. A line is flags (`session.open --location x.db`) or a JSON request |
| `--sidecar` | One JSON request per line in, one envelope per line out. Sessions live as long as the process |
| none | HTTP, on `127.0.0.1` only, at `TYPEDBLITE_HOST_PORT` (default 3470) |
| `--help` | The operations and what each takes |
| an unrecognised flag first | Refused by name, exit 2. It never falls through into a mode, so a typo cannot start a server |

### HTTP

Two routes, under `/api/typedblite-host`: `GET /help` lists the operations with their input schemas, and
`POST /ops/:operation` runs any of them, with the input as the JSON body. It answers the operation's data; a fault
answers the status its exit code means (400 bad input, 404 unknown session or operation, 409 conflict, 503 a store
that will not open) with a `code` to branch on. A statement the engine refuses is a **200** with `kind: "refused"`.

```bash
curl -s -XPOST localhost:3470/api/typedblite-host/ops/session.open -H 'content-type: application/json' -d '{"schema":"define entity a;"}'
```

🔴 **Loopback only, and no authentication.** The server binds `127.0.0.1`, refuses a peer that is not loopback,
and refuses a `Host` header that is not `localhost`, `127.0.0.1` or `[::1]` (DNS rebinding: a web page can make the
browser reach loopback, and the host runs statements against real stores). A later feature adds authentication and
a wider listener.

A session lives in the memory of the process that opened it, so a one-shot CLI call cannot keep one. Over the CLI,
`session.run` takes `--location` (open, run, close in one call) instead of `--session`. State across CLI calls is
the file. A statement the engine refuses is an envelope with exit code 0 and `data.kind: "refused"`; branch on
`data.kind`.

## Develop

```bash
npm exec nx -- run engine-host:test
```
