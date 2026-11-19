# Try TypeDBLite in your browser

This page is a notebook, and it runs here, in your browser, with nothing to install. You will keep a reading list: define it, put
books on it, and ask it questions in TypeQLite. The engine is TypeDBLite on WASM SQLite in a Web Worker, so nothing you type
leaves the page, and closing the page forgets it.

Run each cell with its play button, or press **Ctrl** or **⌘** + **Enter** in it. **Run all** runs them in order, and stops at the
last cell, which is refused on purpose. **Restart** gives the notebook an empty store again. Every cell is an editor: change a
statement and run it again.

## 1. Describe your data

A `book` is an entity. It owns three attributes, and `@key` says that no two books share a title:

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

The notebook has **one store that lasts from cell to cell**, so this schema is there for every cell below. Under a cell the engine
says what it did.

## 2. Put a book on the list, and ask for it

```typeql
insert $b isa book, has title "Dune", has author "Frank Herbert", has status "to-read";
```

<!-- tour:expect answer -->
```text
b
--------------
entity:book:#1
```

An `insert` answers with what it made. Now ask for the book:

```typeql
match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s;
```

<!-- tour:expect answer -->
```text
t     a              s
----  -------------  -------
Dune  Frank Herbert  to-read
```

## 3. Add another, finish one, and see the list

```typeql
insert $b isa book, has title "Piranesi", has author "Susanna Clarke", has status "to-read";
```

<!-- tour:expect answer -->
```text
b
--------------
entity:book:#2
```

`update` changes an attribute of every book the `match` finds:

```typeql
match $b isa book, has title == "Dune"; update $b has status "done";
```

<!-- tour:expect answer -->
```text
b
--------------
entity:book:#1
```

```typeql
match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s; sort $t;
```

<!-- tour:expect answer -->
```text
t         a               s
--------  --------------  -------
Dune      Frank Herbert   done
Piranesi  Susanna Clarke  to-read
```

## 4. What is finished

```typeql
match $b isa book, has status "done", has title $t; select $t;
```

<!-- tour:expect answer -->
```text
t
----
Dune
```

## 5. What the engine says no to

An update whose `match` finds no book is not an error, because nothing is wrong. The facts say that it did nothing:

```typeql
match $b isa book, has title == "Not a book"; update $b has status "done";
```

<!-- tour:expect -->
```text
OK.

`match` bound 0 combinations, so the write ran 0 times.
```

And adding a title twice is refused, with the engine's own message, on the cell that did it. (A `@key` is a `@unique` attribute
that every book must have, which is why the message names `@unique`.) The cell is marked, and **Run all** stops here:

```typeql
insert $b isa book, has title "Dune", has author "Frank Herbert", has status "to-read";
```

<!-- tour:expect -->
```text
TypeQLite refused this statement: [CNT9] Constraint '@unique' has been violated for attribute 'title'. (line 1, column 21)
```

## Where next

- [The five-minute tour](five-minute-tour.tql.md): the same reading list in a file, then used from the command line and from a
  Node program. It is a notebook too, for VS Code.
- [The TypeQLite language](typeqlite-language.md): everything you can write in a schema and in queries.
- [Getting started](getting-started.md): install TypeDBLite and use it from your own code.
