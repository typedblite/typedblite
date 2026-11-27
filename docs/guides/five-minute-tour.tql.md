# Five-minute tour: a reading list

You will keep a reading list in one file. You will define it and ask it questions in a **notebook**, then use the same file from
the **command line** and from a **Node program**.

> **Status.** The npm packages are a release candidate, `0.1.0-rc.1`. This tour is tested: every cell, command and file below is run, and every answer shown is checked against what runs (see
> [How this tour is tested](#how-this-tour-is-tested)). To build from source instead, see
> [Getting started](getting-started.md). To install the extension, see
> [how to install it](../../apps/vscode/README.md#install).

You need **Node.js 22.16 or later**, and **VS Code** with the TypeDBLite extension for the notebook. Nothing else: no native
toolchain, no Docker, no database server. No VS Code? Read the notebook steps as a transcript: each cell is followed by what it
prints, and `npx typedblite --exec '<statement>'` runs the same statements.

On Node.js 22 the commands also print an `ExperimentalWarning` about SQLite. It is harmless, and the outputs below leave it
out.

## 1. Open this tour as a notebook

Make an empty folder called `readlist`, save this file in it as `five-minute-tour.tql.md`, and open the folder in VS Code. A
`.tql.md` file opens as a **notebook**: the text is text, and each block of TypeQLite is a **cell** with a play button. The
**TypeQLite** kernel is already chosen for you.

Everything in a cell runs on the TypeDBLite engine. The notebook has **one store that lasts from cell to cell**, so a schema you
define in one cell is there for the next. It lives in memory until you choose a file, which you will do in step 4.

Under each cell this page prints what it shows, as plain text, so you can compare or just read along. In the notebook your own
output appears just above it. **Run the cells one at a time, with their play buttons, as you reach them**: the toolbar's **Run
All** would run cells that need the command line first.

## 2. Describe your data

A `book` is an entity. It owns three attributes, and `@key` says that no two books share a title. Run this cell, with its play
button:

```typeql
define
  entity book, owns title @key, owns author, owns status;
  attribute title, value string;
  attribute author, value string;
  attribute status, value string;
```

<!-- tour:expect -->
```text
Schema applied.

`define` applied 4 new definition(s); 0 already present.
Registered 1 key attribute(s).
```

Under the cell the engine says what it did. A schema is applied, and you can re-run the cell: `define` adds, and is safe to repeat.

## 3. Put a book on the list, and ask for it

```typeql
insert $b isa book, has title "Dune", has author "Frank Herbert", has status "to-read";
```

<!-- tour:expect answer -->
```text
b
--------------
entity:book:#1
```

An `insert` answers with what it made. Now ask for it:

```typeql
match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s;
```

<!-- tour:expect answer -->
```text
t     a              s
----  -------------  -------
Dune  Frank Herbert  to-read
```

A cell can hold several statements: they run in order, each answer in turn, and a refusal stops the cell where it happens.

## 4. Keep it in a file

So far the store is in memory (the status bar, bottom left, says **In-memory store**), and closing the notebook forgets it. Choose
a file: click **In-memory store** in the status bar, or choose **Choose the Notebook's Store…** from the notebook toolbar's **…**
menu. Pick **Create a new store file…**, save it as `readlist.db` in the `readlist` folder, then choose **Commit each
statement**. VS Code asks you to confirm, because switching ends the notebook's current session: choose **Switch**. The status
bar now says `readlist.db · commits each statement`.

<!-- tour:store readlist.db -->

The notebook starts again on an empty file, so run the three cells above again, top to bottom, with their play buttons. They
answer exactly as before, and now the data is in `readlist.db`.

## 5. Use the same file from the command line

Open a terminal in the `readlist` folder (**Terminal → New Terminal** does). The `typedblite` command needs no install, and
`--database` names the file the notebook wrote:

<!-- tour:run -->
```bash
npx typedblite --database readlist.db --exec 'match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s;'
npx typedblite --database readlist.db --exec 'insert $b isa book, has title "Piranesi", has author "Susanna Clarke", has status "to-read";'
```

<!-- tour:output -->
```text
t=Dune  a=Frank Herbert  s=to-read
(1 row)
ok
```

The command line saw Dune, which the notebook put there, and added Piranesi. `npx typedblite --database readlist.db --repl` opens
an interactive prompt on the same file.

## 6. See it in the notebook

Back in the notebook, add a cell, or run this one. The notebook reads what the command line wrote:

```typeql
match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s; sort $t;
```

<!-- tour:expect answer -->
```text
t         a               s
--------  --------------  -------
Dune      Frank Herbert   to-read
Piranesi  Susanna Clarke  to-read
```

## 7. Call it from Node

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
import { TypeDBLiteInterpreter, TypeDBLiteValue, diagnosticOf, DiagnosticCode } from '@typedblite/runtime';

const text = (value) => TypeDBLiteValue.value('string', value);

const db = new TypeDBLiteInterpreter('readlist.db');
if (!db.hasSchema) {
  console.error('readlist.db has no schema yet: run the notebook cells in step 2 against it first.');
  process.exit(1);
}

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

- **A file is a database.** `new TypeDBLiteInterpreter('readlist.db')` opens the file the notebook and the command line wrote.
  `db.hasSchema` is true for it, because the notebook defined the schema there.
- **Values go in as rows, not as text.** A pipeline that starts with `given` takes its values from the caller, so a title
  containing a quote or a semicolon cannot change the query. Always use this for anything that comes from outside your program.
  `has title == $t` compares the book's title with the value you passed. (A notebook cell has no caller, so its statements
  write the values in.)
- **Refusals are thrown, with a code.** Adding a title twice breaks the `@key`, and `diagnosticOf` gives you
  `DiagnosticCode.constraintViolated` to branch on, with no string matching.
- **A write that did nothing says so.** An update whose `match` finds no book does not throw, because nothing is wrong, but its
  report carries a `typedblite.empty-match` fact. The program checks for it, so `done` on a title that is not on the list does
  not claim success.

## 8. Use it

<!-- tour:run -->
```bash
node readlist.mjs list
node readlist.mjs add Emma "Jane Austen"
node readlist.mjs done Dune
node readlist.mjs list
```

<!-- tour:output -->
```text
[ ] Dune by Frank Herbert
[ ] Piranesi by Susanna Clarke
Added "Emma".
Finished "Dune".
[x] Dune by Frank Herbert
[ ] Emma by Jane Austen
[ ] Piranesi by Susanna Clarke
```

Dune and Piranesi were added from the notebook and the command line, and the program sees them. Now the two refusals:

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

## 9. Look at the same file again, in the notebook

The program wrote to the file, so the notebook sees its changes. Add a cell, or run this one:

```typeql
match $b isa book, has status "done", has title $t; select $t;
```

<!-- tour:expect answer -->
```text
t
----
Dune
```

The notebook can show what the engine says no to as well. An update whose `match` finds no book is not an error, and the facts say
that it did nothing:

```typeql
match $b isa book, has title == "Not a book"; update $b has status "done";
```

<!-- tour:expect -->
```text
OK.

`match` bound 0 combinations, so the write ran 0 times.
```

And adding a title twice is refused, with the engine's own message, on the cell that did it. (A `@key` is a `@unique` attribute
that every book must have, which is why the message names `@unique`.) The notebook marks the cell with a red cross and stops
there, so this is the last cell:

```typeql
insert $b isa book, has title "Dune", has author "Frank Herbert", has status "to-read";
```

<!-- tour:expect -->
```text
TypeQLite refused this statement: [CNT9] Constraint '@unique' has been violated for attribute 'title'. (line 1, column 21)
```

That is the whole loop: a schema, a file, a notebook, a command line, and a program, all on one SQLite file with no server. Close
the notebook, which closes its store and writes everything into the file, and you can copy `readlist.db` to another machine, or
open it in any SQLite tool. Choosing a store is always your decision: the notebook never saves it in the file you are reading,
so a notebook someone sends you runs in your memory, not on a path from their machine.

## How this tour is tested

This page is the notebook, and it is also the test. `npm run tour` packs the packages, installs the tarballs in an empty
directory, and runs every command and file in steps 5, 7 and 8, checking the output shown. A second test plays the whole tour from
top to bottom on the notebook's own engine and the real command line, in one timeline, so the cells see what the command line and
the program wrote: every cell's answer must be the one printed under it. A third opens this file in a real VS Code, installed from
the `.vsix`, and does the same through the editor. If you find an answer here that is not what you got, that is a bug in the tour:
please [open an issue](https://github.com/typedblite/typedblite/issues).

## Where next

- [The TypeQLite language](typeqlite-language.md): everything you can write in a schema and in queries.
- [Embedding the runtime](embedding-the-runtime.md): transactions, `fetch` documents, tracing, and the whole API.
- [Replication and search](replication-and-search.md): syncing two copies of a store, and full-text search.
- [Known limitations](known-limitations.md): what TypeDBLite does not do yet, stated plainly.
- [Why not X?](why-not-x.md): when another tool is the better choice.
