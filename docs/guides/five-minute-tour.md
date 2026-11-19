# Five-minute tour: a reading list

You will start from an empty folder and end with a small program that keeps a reading list in one
file. On the way you will define a schema, use the command line, and call the engine from Node.

> **Status.** The packages are not on npm yet. This tour is written for the first release, and it is
> tested: `npm run tour` packs the packages, installs the tarballs in an empty directory, and runs every
> command and file below, checking the output shown. Until the release, build from source with
> [Getting started](getting-started.md).

You need **Node.js 22.16 or later**. Nothing else: no native toolchain, no Docker, no database server.

## 1. Describe your data

Make a folder and save this as `schema.tql`:

```bash
mkdir readlist && cd readlist
```

<!-- tour:file schema.tql -->
```typeql
define
  entity book, owns title @key, owns author, owns status;
  attribute title, value string;
  attribute author, value string;
  attribute status, value string;
```

A `book` is an entity. It owns three attributes, and `@key` says that no two books share a title.

## 2. Try it from the command line

The `typedblite` command needs no install. `--database` names a SQLite file, which keeps your data
between runs:

<!-- tour:run -->
```bash
npx typedblite --file schema.tql --database readlist.db
npx typedblite --database readlist.db --exec 'insert $b isa book, has title "Dune", has author "Frank Herbert", has status "to-read";'
npx typedblite --database readlist.db --exec 'match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s;'
```

<!-- tour:output -->
```text
schema applied
ok
t=Dune  a=Frank Herbert  s=to-read
(1 row)
```

`npx typedblite --database readlist.db --repl` opens an interactive prompt on the same file.

## 3. Call it from Node

Create a project in the same folder and install the runtime:

<!-- tour:run -->
```bash
npm init -y
npm pkg set type=module
npm install @typedblite/runtime
```

Save this as `readlist.mjs`:

<!-- tour:file readlist.mjs -->
```js
import { readFileSync } from 'node:fs';
import { TypeDBLiteInterpreter, TypeDBLiteValue, diagnosticOf, DiagnosticCode } from '@typedblite/runtime';

const text = (value) => TypeDBLiteValue.value('string', value);

const db = new TypeDBLiteInterpreter('readlist.db');
if (!db.hasSchema) db.define(readFileSync('schema.tql', 'utf8'));

const [command, title, author] = process.argv.slice(2);

try {
  if (command === 'add' && title && author) {
    db.execute(
      `given $t: string, $a: string;
       insert $b isa book, has title $t, has author $a, has status "to-read";`,
      [{ t: text(title), a: text(author) }],
    );
    console.log(`Added "${title}".`);
  } else if (command === 'done' && title) {
    const report = db.execute(
      `given $t: string;
       match $b isa book, has title == $t;
       update $b has status "done";`,
      [{ t: text(title) }],
    );
    if (report.diagnostics.some((d) => d.code === DiagnosticCode.emptyMatch)) {
      console.error(`No book called "${title}" on the list.`);
      process.exitCode = 1;
    } else {
      console.log(`Finished "${title}".`);
    }
  } else if (command === 'list') {
    const { rows } = db.query(`
      match $b isa book, has title $t, has author $a, has status $s;
      select $t, $a, $s;
      sort $t;
    `);
    for (const row of rows) {
      const mark = row.s.asString() === 'done' ? 'x' : ' ';
      console.log(`[${mark}] ${row.t.asString()} by ${row.a.asString()}`);
    }
  } else {
    console.log('usage: node readlist.mjs add <title> <author> | done <title> | list');
  }
} catch (error) {
  const diagnostic = diagnosticOf(error);
  if (diagnostic?.code === DiagnosticCode.constraintViolated) {
    console.error(`Already on the list: "${title}".`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  db.close();
}
```

Four things in it are worth knowing:

- **A file is a database.** `new TypeDBLiteInterpreter('readlist.db')` opens the file the command line wrote.
  `db.hasSchema` is true for it, so the schema is applied only the first time.
- **Values go in as rows, not as text.** A pipeline that starts with `given` takes its values from the
  caller, so a title containing a quote or a semicolon cannot change the query. Always use this for
  anything that comes from outside your program. `has title == $t` compares the book's title with the
  value you passed.
- **Refusals are thrown, with a code.** Adding a title twice breaks the `@key`, and `diagnosticOf` gives
  you `DiagnosticCode.constraintViolated` to branch on, with no string matching.
- **A write that did nothing says so.** An update whose `match` finds no book does not throw, because
  nothing is wrong, but its report carries a `typedblite.empty-match` fact. The program checks for it,
  so `done` on a title that is not on the list does not claim success.

## 4. Use it

<!-- tour:run -->
```bash
node readlist.mjs list
node readlist.mjs add Piranesi "Susanna Clarke"
node readlist.mjs done Dune
node readlist.mjs list
```

<!-- tour:output -->
```text
[ ] Dune by Frank Herbert
Added "Piranesi".
Finished "Dune".
[x] Dune by Frank Herbert
[ ] Piranesi by Susanna Clarke
```

Dune was added by the command line in step 2, and the program sees it. Now the two refusals:

<!-- tour:run exit=1 -->
```bash
node readlist.mjs add Dune "Frank Herbert"
```

<!-- tour:output -->
```text
Already on the list: "Dune".
```

<!-- tour:run exit=1 -->
```bash
node readlist.mjs done "Not a book"
```

<!-- tour:output -->
```text
No book called "Not a book" on the list.
```

## 5. Look at the same file again

The program wrote to the file, so the command line sees its changes:

<!-- tour:run -->
```bash
npx typedblite --database readlist.db --exec 'match $b isa book, has status "done", has title $t; select $t;'
```

<!-- tour:output -->
```text
t=Dune
(1 row)
```

That is the whole loop: a schema, a file, a command line, and a program, all on one SQLite file with
no server. You can copy `readlist.db` to another machine, or open it in any SQLite tool.

## Where next

- [The reading list, as a notebook](reading-list.tql.md): the TypeQLite half of this tour, to run cell by cell in VS Code.
- [The TypeQLite language](typeqlite-language.md): everything you can write in a schema and in queries.
- [Embedding the runtime](embedding-the-runtime.md): transactions, `fetch` documents, tracing, and the whole API.
- [Replication and search](replication-and-search.md): syncing two copies of a store, and full-text search.
- [Known limitations](known-limitations.md): what TypeDBLite does not do yet, stated plainly.
- [Why not X?](why-not-x.md): when another tool is the better choice.
