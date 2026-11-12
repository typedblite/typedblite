# The TypeQLite language

TypeQLite is the dialect of [TypeQL 3.x](https://typedb.com/docs/typeql) that TypeDBLite runs. If you
know TypeQL, you already know TypeQLite: the syntax is TypeQL's, and the behaviour is measured
against TypeDB's own behaviour specification. On that specification, TypeDBLite passes **1,742 of
1,756 scenarios** ([CONFORMANCE.md](../../CONFORMANCE.md)).

This guide is a tour of what you can write, with examples that run as shown. For the full detail of
any construct, TypeDB's [TypeQL reference](https://typedb.com/docs/typeql) applies. The
[last section](#what-typeqlite-does-not-do-yet) lists where TypeDBLite differs.

- [Files and statements](#files-and-statements)
- [Schema](#schema)
- [Annotations](#annotations)
- [Changing a schema](#changing-a-schema)
- [Functions](#functions)
- [Writing data](#writing-data)
- [Reading data: patterns](#reading-data-patterns)
- [Pipeline stages](#pipeline-stages)
- [Expressions](#expressions)
- [Fetch](#fetch)
- [What TypeQLite does not do yet](#what-typeqlite-does-not-do-yet)

## Files and statements

TypeQLite files use the `.tql` or `.typeqlite` extension. A file holds `define`, `redefine` and
`undefine` clauses and query pipelines, in any order. `#` starts a comment, and `#!` starts a
documentation comment that the editor shows on hover.

Labels are case-sensitive, and may contain `-` and `_`: `start-date`, `employee_count`.

## Schema

A schema declares three kinds of type, and how they connect:

```typeql
define
  attribute name, value string;
  attribute age, value integer;
  attribute salary, value double;
  attribute start-date, value date;

  entity person, owns name @key, owns age, plays employment:employee;
  entity company, owns name @key, plays employment:employer;

  relation employment,
    relates employee,
    relates employer,
    owns salary,
    owns start-date;
```

| Kind | What it is |
| ---- | ---------- |
| `entity` | A thing that exists on its own: a person, a company |
| `relation` | A thing that connects others through **roles**. `relates employee` declares a role, and `plays employment:employee` lets a type fill it |
| `attribute` | A value with a type, owned by entities and relations through `owns`. An attribute is stored once per type and value, and shared by every owner |

**Value types:** `string`, `integer`, `long`, `double`, `decimal`, `boolean`, `date`, `datetime`,
`datetime-tz`, `duration`.

**Subtyping.** Any type can specialise another with `sub`. A subtype inherits what its parent owns
and plays, and `isa person` also matches an `employee-person`:

```typeql
define
  entity employee-person sub person;
  entity product @abstract, owns name @key;
  entity book sub product;
  relation contract sub employment, relates contractor as employee;
```

`relates contractor as employee` specialises an inherited role: in a `contract`, the employee role
is called `contractor`, and a type must declare `plays contract:contractor` to fill it.

**Structs** declare a named group of values: `struct address: street value string, city value string;`.

## Annotations

Annotations follow the thing they constrain. Each position admits only certain annotations, and a
misplaced one is refused with `typedblite.annotation-not-admitted`:

```typeql
define
  attribute email, value string @regex("^[^@]+@[^@]+$");
  attribute ref @independent, value string;
  entity person @doc("Anyone the system knows about"),
    owns name @key,
    owns email @card(0..2);
```

What each one does in TypeDBLite, as measured:

| Annotation | Behaviour |
| ---------- | --------- |
| `@key` | **Enforced.** A value identifies at most one owner, and every owner must hold exactly one key value by commit. A keyed entity is also what [replication](replication-and-search.md) identifies across stores |
| `@unique` | **Enforced.** At most one owner per value, among the declaring type and its subtypes |
| `@abstract` | **Enforced.** The type cannot have instances of its own; insert a concrete subtype |
| `@regex("…")` | **Enforced** on every write. The whole value must match |
| `@independent` | **Honoured.** The attribute is kept when its last owner lets go of it. Other attributes are removed |
| `@doc("…")` | **Retained.** Read it back with `get_doc(person)` |
| `@card(min..max)` | **Partly.** It decides whether `fetch` returns a value or a list, and whether `update` may replace one. Bounds other than a key's are **not** enforced on writes |
| `@range(…)`, `@values(…)` | Their arguments are checked against the value type at `define`. **Not** enforced on writes |
| `@distinct`, `@cascade`, `@meta` | Parsed and accepted. **Not** enforced |

An annotation that TypeDBLite accepts but does not enforce never fails silently. `define` may report
it with a `typedblite.annotation-not-enforced` fact, and the conformance report card tracks each one
scenario by scenario.

## Changing a schema

`define` adds and is safe to repeat. To change or remove something, use `redefine` and `undefine`:

```typeql
define person owns nickname;               # add an ownership to an existing type
undefine owns nickname from person;        # remove it again
redefine person owns email @card(0..3);    # change an annotation that is already set
undefine nickname;                         # remove a type
```

TypeDBLite checks a change against the stored data, the way TypeDB does. It refuses to `undefine` a
type that still has instances or subtypes, to add a `@key` that existing data repeats, and to
`redefine` something that is not defined. The refusal codes are listed in
[Embedding the runtime](embedding-the-runtime.md#diagnostics-and-refusals).

## Functions

Functions are defined in the schema and called from queries. A function returns either a single
value or a stream (`{ … }`):

```typeql
define
  fun age_of($p: person) -> integer:
    match $p has age $a;
    return first $a;

  fun adult_names() -> { name }:
    match $p isa person, has age $a, has name $n; $a >= 18;
    return { $n };

  fun headcount($c: company) -> integer:
    match (employer: $c) isa employment;
    return count;
```

```typeql
match $p isa person, has name "Bob"; let $a = age_of($p); select $a;
match let $n in adult_names(); select $n;
```

A function can be local to one query, by writing it before the pipeline with `with`:

```typeql
with fun double_age($p: person) -> integer:
  match $p has age $a; let $d = $a * 2; return first $d;
match $p isa person, has name "Alice"; let $d = double_age($p); select $d;
```

`return` can stream values (`return { $n };`), pick one (`return first $a;` or `return last $a;`),
or reduce (`return count;`, `return sum($s);`).

## Writing data

**`insert`** creates things. Several statements in one `insert` share variables, so a relation can
use the things inserted beside it:

```typeql
insert
  $a isa person, has name "Alice", has age 34;
  $c isa company, has name "Acme";
  $e isa employment, links (employee: $a, employer: $c),
    has salary 52000.0, has start-date 2024-01-15;
```

`(employee: $a, employer: $c) isa employment;` is the same relation, written anonymously.

**`match` then write.** A write after a `match` runs once for each row the match produces:

```typeql
match $p isa person, has name "Alice";
insert $p has nickname "Al";
```

**`put`** inserts only if an identical thing does not already exist, so running it twice leaves one:

```typeql
put $c isa company, has name "Initech";
```

**`update`** replaces an attribute or role player that can only be held once:

```typeql
match $p isa person, has name "Bob";
update $p has age 18;
```

**`delete`** removes things, ownerships and role players:

```typeql
match $c isa company, has name "Initech";
delete $c;

match $p isa person, has name "Alice", has nickname $n;
delete has $n of $p;

match $f isa friendship, links (friend: $b); $b has name "Bob";
delete links (friend: $b) of $f;
```

Deleting a relation's last role player deletes the relation too.

## Reading data: patterns

A `match` is a set of patterns. Each row it returns is one way to satisfy all of them.

| Pattern | Example |
| ------- | ------- |
| A type, including subtypes | `$p isa person` |
| Exactly a type | `$p isa! person` |
| An attribute, a literal or a comparison | `$p has name "Alice"`, `$p has name $n`, `$p has age > 20` |
| A relation and its role players | `$e isa employment, links (employee: $p, employer: $c)` |
| The same relation, anonymously | `(employee: $p, employer: $c) isa employment` |
| The role a player fills | `$e links ($r: $p)` binds `$r` to the role type |
| One thing by its iid | `$p iid 0x1e0000000000000001` |
| A thing's type | `$p isa $t` |
| Types, by what they are | `$t sub product`, `$t owns email`, `$t plays employment:employee`, `employment relates $r` |
| A comparison | `$a < 20`, `$n != "Alice"`, `$e contains "example"`, `$n like "^A.*"` (a regular expression) |
| A computed value | `let $months = $a * 12` |
| Either branch | `{ $n == "Alice"; } or { $n == "Bob"; };` |
| Not this | `not { $p has email $e; };` |
| Optionally this | `try { $p has email $e; };` leaves `$e` empty where there is none |
| Two variables, one thing | `$x is $y` (usually inside `not { … }`) |

For example, who has no email address:

```typeql
match $p isa person, has name $n; not { $p has email $e; }; select $n;
```

## Pipeline stages

A pipeline starts with `match` (or a write, or `given`), and each stage after it transforms the
stream of rows:

| Stage | What it does |
| ----- | ------------ |
| `match …` | Adds patterns. A `match` after a `match` joins with the rows so far |
| `insert …`, `put …`, `update …`, `delete …` | Write once per row |
| `select $a, $b;` | Keep only these variables |
| `sort $a desc, $b;` | Order the rows |
| `offset 10;` `limit 10;` | Skip, then take |
| `distinct;` | Drop duplicate rows |
| `require $e;` | Keep only rows where an optional variable is set |
| `reduce $n = count, $avg = mean($a) groupby $c;` | Aggregate. Reducers: `count`, `sum`, `max`, `min`, `mean`, `median`, `std` |
| `fetch { … };` | End the pipeline with JSON documents. See [Fetch](#fetch) |
| `given $n: string;` | First stage only: take rows from the caller. See [given rows](embedding-the-runtime.md#passing-values-in-given-rows) |

```typeql
match $p isa person, has age $a;
reduce $n = count, $avg = mean($a), $max = max($a);

match (employer: $c, employee: $p) isa employment;
reduce $n = count groupby $c;

match $p isa person, has name $n;
sort $n desc; offset 0; limit 1;
select $n;
```

A pipeline may end with `end;`, which separates pipelines that share one text. `execute()` runs each
of them; `query()` answers one read per call.

## Expressions

`let` computes a value from others:

```typeql
match $e isa employment, has salary $s;
let $k = round($s / 1000.0);
select $k;
```

- **Operators:** `+`, `-`, `*`, `/`, `%`, `^`, and parentheses.
- **Built-in functions:** `abs`, `ceil`, `floor`, `round`, `min`, `max`.
- **Concept functions:** `iid($p)` gives a thing's iid as a string. `get_doc(person)` gives a type's
  `@doc` text.
- **Comparisons:** `==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `like`.

Arithmetic is checked: an integer overflow or a division by zero is refused
(`typedblite.value-out-of-range`), not wrapped or turned into infinity.

## Fetch

`fetch` turns each row into a JSON document. It can project attributes, nest objects, run a
sub-query for a list, and call functions:

```typeql
match $p isa person, has name "Alice";
fetch {
  "name": $p.name,
  "all": { $p.* },
  "employers": [
    match (employee: $p, employer: $c) isa employment; $c has name $cn;
    fetch { "company": $cn };
  ]
};
```

```json
[{
  "name": "Alice",
  "all": { "name": "Alice", "age": 34, "email": ["alice@example.com"], "status": "active" },
  "employers": [{ "company": "Acme" }]
}]
```

`$p.email` is a list because `person owns email @card(0..2)` allows more than one. An attribute
that can be owned only once is a single value. Numbers and booleans are JSON numbers and booleans.

## What TypeQLite does not do yet

Each of these is refused by name (`typedblite.not-implemented` or a parse error), never silently
skipped:

- **A function that returns things.** A function can return values and attributes, but not
  entities, relations or types. Return the attributes you need.
- **Writing list values.** `owns tag[]` can be declared, but `has tag[] [ … ]` cannot be written.
- **Value-type conversion functions**, such as `double($a)`.
- **`let … in`** over anything but a function call.
- **`return check`**, and a `reduce` after a write stage.
- **Several reads in one `query()` call.** Run each separately.
- **Enforcing `@card`, `@range`, `@values`, `@distinct` and `@cascade` on writes.** See
  [Annotations](#annotations).
- **Rules and inference.** TypeDB 3 removed them in favour of functions, and TypeDBLite follows.

For the scenario-level detail of every difference, with the reason each one exists, see
[CONFORMANCE.md](../../CONFORMANCE.md).
