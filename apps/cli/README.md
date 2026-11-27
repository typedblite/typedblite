# typedblite

The TypeDBLite command line: an interactive REPL, a file runner, and a one-shot executor for TypeQLite.

## Installation

It is a release candidate, published under npm's `next` tag. It runs with nothing to install, or installs globally:

```bash
npx typedblite@next --exec 'define entity person, owns name @key; attribute name, value string;'
npm install -g typedblite@next
```

It needs Node.js 22.16 or later. Or build it from source:

```bash
npm run build   # or: npm exec nx -- run typedblite:build
```

The compiled binary is at `apps/cli/out/main.js`.

## Usage

```
typedblite [--database <path>] <mode>

Modes:
  --repl                 interactive TypeQLite prompt
  --file <path>          run a .typeqlite file and exit
  --exec '<statement>'   run one statement and exit
  --help                 print this text

Options:
  --database <path>      file-backed SQLite database (default: :memory:)
```

### Interactive REPL

```bash
node apps/cli/out/main.js --repl
```

```
typedblite — .help for help, .exit to leave
in-memory database — nothing is kept when this session ends
typedblite> define entity person, owns name @key; attribute name, value string;
schema applied
typedblite> insert $p isa person, has name "Alice";
ok
typedblite> match $p isa person, has name $n; select $n;
n=Alice
(1 row)
typedblite> .exit
```

Statements end at `;`. Multi-line statements are supported — the prompt shows `...>` while a statement is incomplete. A bare `match …;` without a following stage is held at the prompt; TypeQLite requires a projection or write stage to complete the pipeline.

### REPL dot commands

| Command | Action |
|---|---|
| `.help` | Print usage |
| `.schema` | Report whether a schema has been applied |
| `.exit` | Leave (Ctrl-D also works) |

### File-backed database

```bash
node apps/cli/out/main.js --repl --database ./my.db
```

The database persists across sessions. Each statement is committed immediately.

### Run a file

```bash
node apps/cli/out/main.js --file schema.typeqlite --database ./my.db
```

Statements are run in order. The first error stops execution and exits with code 1.

### One-shot statement

```bash
node apps/cli/out/main.js --exec 'match $p isa person, has name $n; select $n;' --database ./my.db
```

## Known limitations

The CLI finds where a statement ends by looking at `;` and the keyword the statement starts with.
It does not parse the statement. Two consequences:

- **A standalone `insert` ends at its first `;`.** `insert $a isa person, …; $c isa company, …;`
  runs as two statements, and the second fails to parse. Write one `insert` per thing, or start the
  statement with `match` (`match …; insert …;` is kept whole).
- **In the REPL, a `define` block runs when its first line ends in `;`.** Type a `define` on one
  line, or put the schema in a file and load it with `--file`, which reads ahead and keeps a
  multi-line `define` together.

The engine has neither limitation. Statements passed to it through the runtime API are parsed whole.

## Output format

| Outcome | Output |
|---|---|
| `define` / `insert` / `delete` / `put` | `schema applied` or `ok` |
| `match … select` with rows | One line per row: `var=value  var=value` |
| `match … select` with no rows | `(no rows)` |
| Error | `error: <message>` |

## Piped input

The REPL accepts piped input:

```bash
node apps/cli/out/main.js --repl < my-queries.typeqlite
```

This works because the REPL is driven by the `line` event on readline rather than `rl.question()` — `question()` silently drops buffered lines when input is piped.

## Tests

```bash
npm exec nx -- run typedblite:test
```

Test files live in `test/` with `.test.mts` extension. The REPL tests (`test/repl.test.mts`) spawn the actual binary and pipe input into it; they test the real process boundary rather than the module in isolation.
