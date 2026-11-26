# Getting started

This guide takes you from a fresh clone to running a schema and queries, first from the command
line and then from your own code. It takes about ten minutes.

## Prerequisites

- **Node.js 22.16 or later.** TypeDBLite uses `node:sqlite`, which is built into Node, and needs its
  full-text search (FTS5), which Node's bundled SQLite includes from 22.16. Older releases either have no
  `node:sqlite` (22.12) or lack FTS5 (22.13 to 22.15). Node 24 is what the project is developed on.
- **npm**, which comes with Node. The repository is an npm workspace.
- **Linux, macOS or Windows.** CI builds and tests on all three.
- **git**.

You do not need a native toolchain, Docker, or a TypeDB server.

## Build from source

```bash
git clone https://github.com/typedblite/typedblite.git
cd typedblite
npm install
npm run build
```

`npm run build` builds every package in dependency order through [Nx](https://nx.dev). The language
package generates its parser from the grammar first, so the first build takes a little longer.

To check that everything works, run the test suites:

```bash
npm test
```

## Your first session in the CLI

The CLI is at `apps/cli/out/main.js`.

### 1. Write a schema and some data

Save this as `people.tql`:

```typeql
# The schema
define
  entity person, owns name @key, plays employment:employee;
  entity company, owns name @key, plays employment:employer;
  relation employment, relates employee, relates employer;
  attribute name, value string;

# Some data
insert $a isa person, has name "Alice";
insert $b isa person, has name "Bob";
insert $c isa company, has name "Acme";

match
  $a isa person, has name "Alice";
  $c isa company, has name "Acme";
insert (employee: $a, employer: $c) isa employment;
```

### 2. Load it into a database file

```bash
node apps/cli/out/main.js --file people.tql --database ./people.db
```

```
schema applied
ok
ok
ok
ok
```

`--database` names a SQLite file, which persists between runs. Without it, the CLI uses an
in-memory database that is gone when the command ends.

### 3. Query it

Start the REPL against the same file:

```bash
node apps/cli/out/main.js --repl --database ./people.db
```

```typeql
match (employee: $p, employer: $c) isa employment; $p has name $person; $c has name $company; select $person, $company;
```

```
person=Alice  company=Acme
(1 row)
```

Who is not employed anywhere?

```typeql
match $p isa person, has name $n; not { (employee: $p) isa employment; }; select $n;
```

```
n=Bob
(1 row)
```

Type `.exit` (or press Ctrl-D) to leave. To run one statement without the REPL, use `--exec`:

```bash
node apps/cli/out/main.js --exec 'match $p isa person, has name $n; select $n;' --database ./people.db
```

> **CLI tip.** The CLI decides where a statement ends by looking at `;`. A `define` block or a
> `match … insert …` pipeline may span several lines in a `--file`. In the REPL, type a `define`
> block on one line, and write a standalone `insert` as one `insert` per thing, as above. The
> engine API (next section) has neither restriction. The [CLI README](../../apps/cli/README.md) has
> the full reference.

## Your first program

The same steps from TypeScript. `TypeDBLiteInterpreter` is the engine. It is synchronous, because
`node:sqlite` is:

```ts
import { TypeDBLiteInterpreter } from '@typedblite/runtime';

const db = new TypeDBLiteInterpreter(':memory:'); // or a file path, such as './people.db'

db.define(`
  define
    entity person, owns name @key, owns email;
    attribute name, value string;
    attribute email, value string;
`);

db.execute(`insert $p isa person, has name "Alice", has email "alice@example.com";`);

const { rows } = db.query(`match $p isa person, has name $n, has email $e; select $n, $e;`);

for (const row of rows) {
  console.log(row.n.asString(), row.e.asString()); // Alice alice@example.com
}

db.close();
```

If your code expects an asynchronous database, `SqliteEngine` wraps the same engine in `async`
methods and adds a `transaction` helper. See
[Embedding the runtime](embedding-the-runtime.md#two-entry-points).

Each value in a row is a `TypeDBLiteValue`, a concept such as an entity, a relation, an attribute
or a computed value. Call `asString()`, `asInteger()` or `asDouble()` to read an attribute or value
cell. See [Embedding the runtime](embedding-the-runtime.md#reading-results).

**Nothing is on npm yet.** Once the first release is out, the runtime installs with:

```bash
npm install @typedblite/runtime
```

Until then, build from source and depend on the workspace packages. What a version number will promise is in
[Versions and compatibility](compatibility.md).

## When something is refused

TypeDBLite never silently ignores something it does not support. A statement it cannot run fails
with an error that carries a structured diagnostic:

```ts
import { diagnosticOf, DiagnosticCode } from '@typedblite/runtime';

try {
  db.query(`match $x isa planet; select $x;`);
} catch (error) {
  const diagnostic = diagnosticOf(error);
  diagnostic?.code === DiagnosticCode.unknownType; // true
  // "Unknown type 'planet': type label 'planet' not found. The applied schema defines: person"
}
```

## Edit TypeQLite with the VS Code extension

The repository includes the TypeDBLite VS Code extension, which edits `.tql` and `.typeqlite` files. To build and install
it:

```bash
npm exec nx -- run typeqlite-vscode:package
code --install-extension apps/vscode/dist/typeqlite-0.0.1.vsix
```

## Next steps

- [Five-minute tour](five-minute-tour.tql.md): a notebook, the command line and a small program on one SQLite file, from an empty folder (for after
  the first release, when it installs from npm).
- [Embedding the runtime](embedding-the-runtime.md): the whole engine API.
- [The TypeQLite language](typeqlite-language.md): everything you can write.
- [Replication and search](replication-and-search.md): syncing stores, and full-text search.
- [Contributing](../../CONTRIBUTING.md): if you want to change TypeDBLite itself.
