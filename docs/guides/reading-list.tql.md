# The reading list, as a notebook

This is the TypeQLite half of the [five-minute tour](five-minute-tour.md), as a notebook you can run. Open this file in VS Code
with the **TypeQLite** extension: a `.tql.md` file opens as a notebook, and **Run All** (or each cell's play button) runs it. The
cells run on the TypeDBLite engine, against one store kept in memory from cell to cell, so nothing here touches a file of yours.

Change a statement and run it again. The last cell is refused on purpose, to show what a refusal looks like, so Run All ends there.

## 1. Describe your data

A `book` is an entity. It owns three attributes, and `@key` says that no two books share a title.

```typeql
define
  entity book, owns title @key, owns author, owns status;
  attribute title, value string;
  attribute author, value string;
  attribute status, value string;
```

## 2. Put a book on the list

```typeql
insert $b isa book, has title "Dune", has author "Frank Herbert", has status "to-read";
```

An insert answers what it made, and the engine says what it wrote.

## 3. Ask for it

```typeql
match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s;
```

## 4. Add another book, and finish one

```typeql
insert $b isa book, has title "Piranesi", has author "Susanna Clarke", has status "to-read";
```

`update` changes an attribute of every book the `match` finds:

```typeql
match $b isa book, has title == "Dune"; update $b has status "done";
```

## 5. The list

```typeql
match $b isa book, has title $t, has author $a, has status $s; select $t, $a, $s; sort $t;
```

## 6. What is finished

```typeql
match $b isa book, has status "done", has title $t; select $t;
```

## 7. What the engine says no to

An update whose `match` finds no book is not an error, because nothing is wrong. The answer's facts say that it did nothing:

```typeql
match $b isa book, has title == "Not a book"; update $b has status "done";
```

Adding a title twice breaks the `@key`, and the engine refuses it, with its own message, on this cell:

```typeql
insert $b isa book, has title "Dune", has author "Frank Herbert", has status "to-read";
```
