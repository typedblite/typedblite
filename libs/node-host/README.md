# @typedblite/node-host

TypeDBLite's **Node host adapter**: the database handle an application opens its TypeQLite stores through, in Node.
It is private and not published: a host consumes it through a `file:` dependency on this directory, as it consumes
the runtime.

```ts
import { openSchemaDatabase, requiredRowString } from '@typedblite/node-host';

const { database, report } = await openSchemaDatabase(
  { name: 'inventory', storagePath: './data', ensureDirectory: true }, // omit storagePath for in-memory
  'define attribute code, value string; entity item, owns code @key;',
);
// report.diagnostics: what the schema's define reported, including an engine fact such as "Could not enable WAL"

await database.transaction(async (tx) => {
  await tx.execute('insert $i isa item, has code "a";'); // a state change…
  await tx.execute('insert $i isa item, has code "b";'); // …and its event record, atomically
});

const { rows } = await database.query('match $i isa item, has code $c; select $c;');
rows.map((row) => requiredRowString(row, 'c')); // ['a', 'b']

await database.close();
```

## What it provides

- **`TypeDBLiteDatabase`**: `open`, `define`, `execute`, `query`, `transaction`, `persist`, `close`, over an
  engine port (`EmbeddedDatabase`, five methods and an optional `transaction`). The default engine is the runtime's
  `SqliteEngine`; `open({ engine })` takes any other.
- **`openSchemaDatabase`**: open, create the directory if asked, apply the schema, and return the handle with the
  schema's report (`StoreOpenResult`). If the schema is refused, an engine it created is closed before the error is
  rethrown; an engine you passed in is left open for you.
- **Row readers**: `rowString`, `rowNumber`, `requiredRowString`, `requiredRowNumber`.
- **TypeQLite literals**: `typeQLiteValue`, `escapeTypeQLite`, `typeQLiteDatetime`, and `TypeQLiteValueError` for a
  value with no literal.
- **`isUniqueConstraintViolation(error, attribute)`**: a `@key` or `@unique` violation on that attribute, and no other.
- **`readSchemaFile(fromDirectory, fileName)`**: a schema shipped as a packaged asset, never read from the cwd.
- **Loading the engine**: `loadTypeDbLiteRuntime` (the engine, the replicator and the change-stream handler),
  `createSqliteEngine` (an engine a composition root keeps, to replicate it), and `installedRuntimeEntry` (where the
  installed runtime is, from a directory).

## What it promises

- **Transactions.** `transaction(work)` commits if `work` resolves, and rolls back and rethrows the same error if it
  throws. Use the handle it gives `work`, not the database: a call on the database from inside `work` is refused
  rather than left to deadlock, and so is a nested transaction. Transactions on one handle run one at a time, and a
  plain `execute`, `query`, `define`, `persist` or `close` waits for an open one and never lands inside it. The
  handle stops working when its transaction ends. An engine with no `transaction` is refused with
  `TransactionsNotSupportedError`, and `work` is not run. The write lock is held across every `await` in `work`,
  and no timeout is enforced.
- **Diagnostics are returned.** `define` and `execute` answer `{ diagnostics }`, typed from the runtime's
  `ExecutionReport['diagnostics']`. A refusal is still a thrown error.
- **A CommonJS host can `require` it.** It is ESM, and Node loads it from `require` (Node 22.16 and later, as `engines` says). The
  engine is loaded with a dynamic `import()` when a database is first opened, from where this package is
  installed. If a host's build has rewritten that `import()` into a `require`, it falls back to resolving the
  installed runtime from this module's directory.
- **Node only.** It uses `node:async_hooks` and `node:fs`. In a browser, use the runtime directly.

## Why not `@typedblite/session`

`@typedblite/session` is one open store with a lifetime for a shell: a statement's refusal is *returned*, cells are
rendered to strings, and transactions are `begin`, `commit` and `rollback` on the session. This package is the
handle an application's repositories are written against, and they rely on what `session` deliberately does not do:

- a refusal is a *thrown* error, which `isUniqueConstraintViolation` inspects;
- cells keep the engine's concept wrappers, so `rowNumber` can ask for an integer or a double;
- the engine is a port that a host can replace, and the default is the runtime's `SqliteEngine`;
- a transaction is a callback, serialized per handle and guarded against re-entry.

Building this package on `session` would change each of those, so it is built on the runtime directly, beside
`session`, and shares nothing with it but the engine.

## License

[MPL-2.0](../../LICENSE)
