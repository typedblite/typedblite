# @typedblite/session

A TypeQLite session over the TypeDBLite engine: **one open store with a lifetime.** It is what the `typedblite`
CLI and the workbench's engine host both run statements through, so neither decides what a statement means.

It has no dependency but `@typedblite/runtime`, and none on a server framework.

```ts
import { Session } from '@typedblite/session';

const session = new Session('my.db'); // or ':memory:'

await session.run('define attribute name, value string; entity person, owns name;');
await session.run('insert $p isa person, has name "Ada";');

await session.begin(); // manual mode: statements join one transaction
await session.run('insert $p isa person, has name "Grace";');
await session.rollback(); // Grace is gone

const answer = await session.run('match $p isa person, has name $n; select $n;');
// { kind: 'rows', rows: [{ n: 'Ada' }], diagnostics: [...] }

await session.close();
```

## What it provides

- **`Session`**: `run`, `begin`, `commit`, `rollback`, `restart`, `close`, `schema()`, and `location`, `mode`,
  `hasSchema`, `closed`.
- **`classifyStatement(text)`**: `empty`, `define`, `read` or `write`, from the text alone, and never throws.
  Classification is textual on purpose: the interpreter parses properly and has the final say.
- **`splitStatements(source)`**: a source split into statements. A `match … insert …` pipeline stays whole.

## What it promises

- **A statement's refusal is returned, never thrown.** `run` answers `rows`, `ok` or `refused`, and a refusal has
  a `reason` to branch on (`engine`, `no-schema`, `locked`, `closed`, `transaction`) and the engine's own
  `message`. Diagnostics (ADR-004) come with every answer.
- **Auto mode** is a transaction per statement. **Manual mode** (after `begin`) joins statements to one
  transaction. A commit that fails rolls the transaction back and says why.
- **A session owns its store.** Two sessions never share a handle, even on one file. SQLite arbitrates a shared
  file: a writer waits for the other's lock (`busyTimeoutMs`, default 5000) and is then refused as `locked`.
- **A session opened before another session's `define` does not see that schema** until it restarts: the engine
  loads a file's schema when it opens.
- **`restart`** reopens the same location in auto mode and rolls back an open transaction. A `:memory:` store
  comes back empty; a file comes back as last committed.

## License

[MPL-2.0](../../LICENSE)
