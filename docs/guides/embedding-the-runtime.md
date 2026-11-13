# Embedding the runtime

`@typedblite/runtime` is the database engine. It runs inside your process, stores everything in one
SQLite database, and speaks TypeQLite. This guide covers its whole public API.

- [Two entry points](#two-entry-points)
- [Opening a database](#opening-a-database)
- [Defining a schema](#defining-a-schema)
- [Writing data](#writing-data)
- [Reading data](#reading-data)
- [Reading results](#reading-results)
- [Passing values in: given rows](#passing-values-in-given-rows)
- [Transactions](#transactions)
- [Diagnostics and refusals](#diagnostics-and-refusals)
- [Inspecting the schema](#inspecting-the-schema)
- [Tracing and performance](#tracing-and-performance)
- [Using a different SQLite binding](#using-a-different-sqlite-binding)

## Two entry points

| | `TypeDBLiteInterpreter` | `SqliteEngine` |
| - | ----------------------- | -------------- |
| Calls | Synchronous | `async`, wrapping the interpreter |
| Result types | Fully typed (`TypeDBLiteValue` cells, reports) | `unknown` cells: it implements a structural engine port |
| `given` rows | Yes | No |
| Transactions | `beginTransaction` / `commitTransaction` / `rollbackTransaction` | `transaction(async () => …)` |
| Use it when | You embed the engine directly. **Start here** | Your code is written against an asynchronous database interface that a TypeDB server could also implement ([ADR-002](../architecture/adr-002-typeql-engine-as-a-port.md)) |

Both expose `changeLog`, `hasSchema`, `schemaSnapshot()` and `close()`. The rest of this guide uses
the interpreter.

```ts
import { TypeDBLiteInterpreter } from '@typedblite/runtime';

const db = new TypeDBLiteInterpreter(':memory:');
```

## Opening a database

```ts
new TypeDBLiteInterpreter(location?, busyTimeoutMs?, options?)
```

| Parameter | Default | Meaning |
| --------- | ------- | ------- |
| `location` | `':memory:'` | A SQLite file path, or `':memory:'` for a database that exists only as long as the object does |
| `busyTimeoutMs` | `5000` | How long a write waits for another process's lock before failing. SQLite allows one writer at a time |
| `options.trace` | `false` | Record counts for each `query()`. See [Tracing](#tracing-and-performance) |
| `options.planJoins` | `true` | Apply relation constraints as early as possible. `false` runs the original, unplanned engine, which is kept for differential testing |
| `options.openDatabase` | `openNodeSqlite` | The function that opens the SQLite connection. See [Using a different SQLite binding](#using-a-different-sqlite-binding) |

A **file** database is switched to WAL journal mode, so readers do not block a writer. If the file
system cannot support WAL, the database still opens, and the first call's report carries a
`typedblite.journal-mode` fact saying so.

Opening a file that already holds a schema loads it. `db.hasSchema` tells you whether any schema has
been applied.

**To open a store read-only**, pass an opener that opens the connection that way:

```ts
import { DatabaseSync } from 'node:sqlite';

const reader = new TypeDBLiteInterpreter('./people.db', 5000, {
  openDatabase: (location) => new DatabaseSync(location, { readOnly: true }),
});
```

Reads work as usual, and any write fails with SQLite's own `attempt to write a readonly database`.
Opening writes nothing to a store that is up to date. A store last written by an older version of
TypeDBLite may need one writable open first: storage grows additively, and the newer tables are
created on open.

Call `db.close()` when you are done. It closes the SQLite connection.

## Defining a schema

`define(text)` applies `define`, `redefine` and `undefine` clauses:

```ts
const report = db.define(`
  define
    entity person, owns name @key, owns email, plays employment:employee;
    entity company, owns name @key, plays employment:employer;
    relation employment, relates employee, relates employer, owns start-date;
    attribute name, value string;
    attribute email, value string @regex(".+@.+");
    attribute start-date, value date;
`);
```

**`define` is additive and safe to repeat.** Applying the same schema again changes nothing, and the
report says how many definitions were already present. This means an application can run its schema
on every start-up.

Schema changes are checked against the data already stored. For example, `undefine person` is refused
while persons exist, and adding `@key` is refused if two things already share a value. A refused
`define` changes nothing: each call is one transaction.

The [language guide](typeqlite-language.md#schema) covers what a schema can say.

## Writing data

`execute(text)` runs every pipeline in `text` that has a write stage (`insert`, `put`, `update` or
`delete`):

```ts
db.execute(`
  insert
    $a isa person, has name "Alice", has email "alice@example.com";
    $c isa company, has name "Acme";
    (employee: $a, employer: $c) isa employment, has start-date 2024-01-15;
`);

db.execute(`
  match $p isa person, has name "Alice";
  update $p has email "alice@acme.test";
`);
```

- **Each pipeline commits on its own**, unless the call runs inside a
  [transaction](#transactions). A refused pipeline writes nothing. But if one text holds several
  pipelines (separated by `end;`), the ones before the refusal stay written. To make several
  pipelines all-or-nothing, run them in a transaction.
- A pipeline with no write stage is skipped by `execute()`. Use `query()` to read.
- The returned report includes a `typedblite.wrote` fact counting the things, attributes and role
  players written. When the `match` before a write binds nothing, you get a
  `typedblite.empty-match` fact instead of a silent no-op.
- A write pipeline can end in `fetch` or `select`. Its answers come back in `rows` or `documents`, as
  a read's would.

## Reading data

`query(text)` runs **one** read pipeline:

```ts
const { rows, diagnostics } = db.query(`
  match $p isa person, has name $n;
  select $n;
  sort $n;
`);
```

- A pipeline with no `select` returns every variable it names, as TypeDB does.
- A pipeline ending in `fetch` returns JSON in `documents`, and `rows` is empty.
- A write stage in a `query()` is refused (`typedblite.write-in-read`), never quietly skipped.
- Text holding several pipelines is refused: one read per call.

**An empty result explains itself.** When a query returns no rows, `diagnostics` includes a
`typedblite.no-candidates` fact for each constraint, giving two counts:

```
`isa person` matched 2 candidate(s) before the constraints on '$p', and 0 after.
```

`0 … 0` means nothing of that type exists, so look at the data or the type name. `2 … 0` means the
pattern's constraints excluded every candidate, so look at the query.

## Reading results

Each row maps a variable name (without `$`) to a `TypeDBLiteValue`:

```ts
const { rows } = db.query(`match $p isa person, has name $n; select $p, $n;`);
for (const row of rows) {
  const person = row.p;
  if (person.isEntity()) console.log(person.type, person.iid, person.iidHex);
  console.log(row.n.type, row.n.asString());
}
```

| Kind | Test | Carries | `toString()` |
| ---- | ---- | ------- | ------------ |
| Entity | `isEntity()` | `type` (its own type, such as `employee` rather than the queried `person`), `iid`, `iidHex` | `entity:person:#1` |
| Relation | `isRelation()` | `type`, `iid`, `iidHex` | `relation:employment:#4` |
| Attribute | `isAttribute()` | `type`, the value, `iidHex` | the value |
| Value | `isValue()` | `type` (the value type), the value. An expression's or a reducer's result | the value |
| Type | `isType()` | `label` (such as `person`, or `employment:employee` for a role) | `type:person` |

`isThing()` is true for entities and relations.

Read a value with `asString()`, `asInteger()` or `asDouble()`. Each throws on a thing or a type
rather than inventing a value. Values are held in their canonical text form: a `date` reads as
`2024-01-15` and a `boolean` as `true`. `asString()` always gives that form.

A `fetch` returns plain JSON:

```ts
const { documents } = db.query(`
  match $p isa person, has name $n;
  fetch { "name": $n, "emails": [ $p.email ] };
`);
// [ { "name": "Alice", "emails": ["alice@example.com"] }, { "name": "Bob", "emails": [] } ]
```

A `reduce` returns one row of values:

```ts
const counted = db.query(`match $p isa person; reduce $count = count;`);
console.log(counted.rows[0]?.count.asInteger()); // 2
```

## Passing values in: given rows

A pipeline that starts with a `given` stage takes its values from the caller instead of from string
interpolation. The pipeline runs once for each row you pass:

```ts
import { TypeDBLiteValue } from '@typedblite/runtime';

db.execute(`given $n: string; insert $p isa person, has name $n;`, [
  { n: TypeDBLiteValue.value('string', 'Carol') },
  { n: TypeDBLiteValue.value('string', 'Dan') },
]);
```

Mark a variable optional with `?` (`given $nick: string?;`), and pass `null` for it. Use given rows
for any value that comes from outside the program: it keeps user input out of the query text. Rows
that do not fit the declaration are refused with `typedblite.given`.

## Transactions

Group several calls so that they commit or roll back together:

```ts
db.beginTransaction();
try {
  db.execute(`insert $p isa person, has name "Erin";`);
  db.execute(`insert $p isa person, has name "Fay";`);
  db.commitTransaction();
} catch (error) {
  db.rollbackTransaction();
  throw error;
}
```

- Reads inside the transaction see its uncommitted writes.
- **Some rules are checked at commit,** because they hold for the transaction as a whole rather
  than for each statement. For example, every owner of a `@key` must hold exactly one key value by
  the time you commit. **A commit that fails rolls the whole transaction back**, as TypeDB's does,
  and throws the refusal. Calling `rollbackTransaction()` afterwards is harmless: it never throws.
- One transaction at a time per connection. A second `beginTransaction()` is refused.

`SqliteEngine` does the same with a callback, rolling back if the callback throws:

```ts
const engine = new SqliteEngine('./people.db');
await engine.transaction(async () => {
  await engine.execute(`insert $p isa person, has name "Gus";`);
  await engine.execute(`insert $p isa person, has name "Hal";`);
});
```

## Diagnostics and refusals

TypeDBLite reports two kinds of diagnostic, following
[ADR-004](../architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md):

| | Facts | Refusals |
| - | ----- | -------- |
| Severity | Information | Error |
| How you get them | In the returned report's `diagnostics` | **Thrown.** The `Error` carries the diagnostic |
| Examples | `schema-applied`, `wrote`, `empty-match`, `no-candidates`, `projected`, `annotation-not-enforced` | `parse-failed`, `unknown-type`, `constraint-violated`, `abstract-type`, `not-implemented` |

Every diagnostic is an LSP `Diagnostic` with a stable `code`, a `message` for people, and a `range`
pointing into the text you passed, so an editor can underline it.

Read the diagnostic from a thrown error with `diagnosticOf`, and branch on its code:

```ts
import { diagnosticOf, DiagnosticCode } from '@typedblite/runtime';

try {
  db.execute(`insert $p isa person, has name "Alice";`);
} catch (error) {
  const diagnostic = diagnosticOf(error);
  if (diagnostic?.code === DiagnosticCode.constraintViolated) {
    console.log(diagnostic.message, diagnostic.range);
    // [CNT9] Constraint '@unique' has been violated for attribute 'name'.
  } else {
    throw error;
  }
}
```

Codes you will meet most often:

| Code (`DiagnosticCode.…`) | Means |
| ------------------------- | ----- |
| `parseFailed` | The text is not valid TypeQLite |
| `unknownType`, `unknownAttribute`, `unknownRole` | A label the applied schema does not define. The message lists what it does define |
| `constraintViolated` | A `@key`, `@unique`, `@regex` or cardinality rule refused the write |
| `abstractType` | An `insert` of an abstract type |
| `hasInstances`, `hasSubtypes` | An `undefine` that would orphan data or subtypes |
| `notImplemented` | Valid TypeQL that TypeDBLite does not run yet. See [the gaps](typeqlite-language.md#what-typeqlite-does-not-do-yet) |
| `writeInRead` | A write stage passed to `query()` |
| `given` | Given rows that do not match the `given` stage |

`DiagnosticCode` in [`diagnostics.ts`](../../libs/runtime/src/diagnostics.ts) lists them all. A report
holds at most 50 diagnostics. Past that, a final `typedblite.diagnostics-truncated` fact says how many
were dropped.

🔴 **TypeDBLite never silently succeeds at something it does not do.** Unknown syntax fails to
parse. Syntax it has chosen not to implement is refused by name. Anything that reaches the engine
unhandled throws ([ADR-002](../architecture/adr-002-typeql-engine-as-a-port.md), Decision 7). If a
statement returns without a refusal, it did what it says.

## Inspecting the schema

`schemaSnapshot()` returns the applied schema as plain data:

```ts
const snapshot = db.schemaSnapshot();
snapshot.types;      // entity and relation types: ['person', 'company', 'employment']
snapshot.attributes; // ['name', 'email', 'start-date']
snapshot.owns;       // [{ owner: 'person', attribute: 'name' }, …]
```

Its fields are `types`, `relations`, `attributes`, `owns`, `parents`, `valueTypes`, `roles`, `plays`
and `annotations`. Each lists only what was **declared**, not what is inherited.

You can also query the schema in TypeQLite itself: `match $t sub person; select $t;`.

## Tracing and performance

Switch on tracing to see how much work a query did:

```ts
const traced = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true });
traced.query(`match $p isa person; select $p;`);
traced.lastQueryTrace();
// { stages: [{ stage: 'types', combinations: 1 }, { stage: 'thing $p', combinations: 1 }],
//   combinationsCreated: 2, candidatesCalls: 1, candidateRows: 1,
//   statementsPrepared: 2, statementsExecuted: 2, relationHoldsCalls: 0, findRelationsCalls: 0 }
```

The trace holds counts, never timings, so a test can assert that a join does not explode into a
cartesian product. When tracing is off it costs nothing.

| Environment variable | Effect |
| -------------------- | ------ |
| `TYPEDBLITE_TRACE=1` | Turns tracing on for every interpreter in the process |
| `TYPEDBLITE_PLAN_JOINS=0` | Turns join planning off for every interpreter in the process. Use it to bisect a suspected planning bug |

**How to keep queries fast:**
- **Bind with types and keys.** `$p isa person, has name "Alice"` narrows candidates through an
  index. A bare `$x has name $n` has to consider everything.
- **Relations join on role players.** Bind the role players first and the relation is looked up
  through them.
- **Check the trace.** When a query is slow, `combinationsCreated` shows where the combinations
  multiply, stage by stage.

## Using a different SQLite binding

The engine talks to SQLite through the `SqliteDatabase` interface in
[`sqlite-database.ts`](../../libs/runtime/src/sqlite-database.ts). Only `node-sqlite.ts` imports
`node:sqlite`. Pass your own opener to use another binding:

```ts
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter, type SqliteOpener } from '@typedblite/runtime';

const open: SqliteOpener = (location) => new DatabaseSync(location);
const db = new TypeDBLiteInterpreter('./people.db', 5000, { openDatabase: open });
```

A binding must meet these requirements:

| Requirement | Why |
| ----------- | --- |
| **Synchronous** | One query can make hundreds of SQLite calls inside a transaction. The interpreter is synchronous throughout, and making it async would mean rewriting it |
| Named parameters without a prefix: `.all({ id })` binds `:id` | Most WASM wrappers expect `{ ':id': id }` and need a thin adapter |
| `run()` reports `changes` exactly | The change log uses `changes > 0` to tell a new revision from a duplicate |
| `exec()` runs several statements in one string | Schema DDL is applied that way |
| **FTS5 compiled in** | Full-text search is always on. Opening a database without FTS5 fails with a message that says so |

**In a browser, use the supported WASM binding** rather than writing your own:
`@typedblite/runtime/wasm` runs the engine on the official SQLite WASM build, with OPFS persistence.
See the runtime README's [In the browser](../../libs/runtime/README.md#in-the-browser) section, and
[ADR-009](../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md). Outside Node,
`new TypeDBLiteInterpreter()` with no `openDatabase` refuses, and names the opener to pass.
