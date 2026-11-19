# @typedblite/engine-host

The TypeQLite **engine host** of the workbench: a NestJS CQRS app that runs statements in **sessions**, so the
graph explorer, the debugger and the notebook share one meaning of "run this statement"
([ADR-011](../../docs/architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md),
[feature document](../../docs/planning/workbench/engine-host/engine-host.feature.md)).

**Private, and in progress.** Phase 01 is the core: no transport and no binary yet. The CLI, REPL, sidecar and
HTTP transports come from `@devx-micro/app-*` in Phases 02 and 03, and MCP in Phase 04.

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

## Develop

```bash
npm exec nx -- run engine-host:test
```
