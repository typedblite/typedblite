#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { splitStatements, TypeDBLiteSession, type Outcome } from './session.js';

/**
 * `typedblite` — a shell for the TypeDBLite engine.
 *
 * The command is `typedblite`; the language it speaks is **TypeQLite**, which implements the TypeQL syntax of TypeDB.
 * That split is deliberate and runs through the whole codebase: `.typeqlite` files, the `typeqlite`
 * language id and the grammar carry the language's name, while the engine, packages and binary
 * carry ours.
 *
 * 🔴 **The REPL reads raw TypeQLite, not an operation name, and that departs from
 * [ADR-002](../../../../docs/architecture/adr-002-typeql-engine-as-a-port.md) Decision 5's stated
 * bias.** D5 leaned toward making this a Domain CQRS App on the grounds that the REPL is already
 * one of the four transports. Reading the shared runtime changed that: `completeReplLine`
 * tab-completes over a **fixed operation list**, which is an operation menu. TypeQLite is a language —
 * `sqlite3` and `psql`, not a command palette. Typing `typedblite.query {"q": "match …"}` would be
 * worse than the tool it replaces, and completion over three operation names buys nothing.
 *
 * Recorded as an amendment to D5 rather than left as a silent departure.
 */

const HELP = `typedblite — a shell for the TypeDBLite engine, which speaks TypeQLite

  typedblite --repl                 interactive TypeQLite prompt
  typedblite --file <path>          run a file of TypeQLite and exit
  typedblite --exec '<statement>'   run one statement and exit
  typedblite --help                 this text

  --database <path>             file-backed database (default: in-memory)

In the REPL:
  .help                         this text
  .schema                       whether a schema has been applied
  .exit                         leave (Ctrl-D also works)

A statement ends at ';'. A pipeline may span lines — 'match …;' followed by
'insert …;' is one statement, and is left intact.`;

function print(outcome: Outcome): void {
  if (outcome.kind === 'error') {
    stdout.write(`error: ${outcome.message}\n`);
    return;
  }
  if (outcome.kind === 'ok') {
    stdout.write(outcome.statement === 'define' ? 'schema applied\n' : 'ok\n');
    return;
  }
  if (outcome.rows.length === 0) {
    stdout.write('(no rows)\n');
    return;
  }
  for (const row of outcome.rows) {
    stdout.write(
      Object.entries(row)
        .map(([variable, value]) => `${variable}=${value}`)
        .join('  ') + '\n',
    );
  }
  stdout.write(`(${outcome.rows.length} row${outcome.rows.length === 1 ? '' : 's'})\n`);
}

/* v8 ignore start -- @preserve
 * 🔴 Bound to `process.stdin` rather than an injected stream, so it cannot be driven in process
 * without replacing a global. `test/repl.test.mts` spawns the real binary and pipes into it, which
 * is also how the defect in the comment below was found — the `line` event versus `rl.question()`,
 * where piped input was silently dropped after the first statement. Ignored here so the number
 * keeps meaning "untested" rather than "untestable in process".
 */
async function runRepl(database: string): Promise<number> {
  const session = new TypeDBLiteSession(database);
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  stdout.write("typedblite — .help for help, .exit to leave\n");
  if (database === ':memory:') {
    // Discoverable rather than a flag nobody finds: an in-memory session is lost on exit, and
    // being told once at the prompt is cheaper than losing an afternoon's schema.
    stdout.write('in-memory database — nothing is kept when this session ends\n');
  }

  // 🔴 Driven by the `line` EVENT, not `rl.question()`. With `question()` the REPL works
  // interactively and silently drops piped input: readline emits every buffered line at once,
  // `question()` captures one, and the rest are lost — so `typedblite --repl < file` ran only the
  // first statement. Found by driving the real process over stdin.
  let buffer = '';
  const prompt = () => stdout.write(buffer ? '      ...> ' : 'typedblite> ');

  prompt();
  for await (const line of rl) {
    const trimmed = line.trim();

    if (!buffer && trimmed.startsWith('.')) {
      if (trimmed === '.exit') break;
      if (trimmed === '.help') stdout.write(`${HELP}\n`);
      else if (trimmed === '.schema')
        stdout.write(
          session.hasSchema
            ? 'a schema has been applied\n'
            : 'no schema applied — nothing can be checked against one yet\n',
        );
      else stdout.write(`unknown command '${trimmed}' — .help for help\n`);
      prompt();
      continue;
    }

    buffer += `${line}\n`;
    if (!buffer.trimEnd().endsWith(';')) {
      prompt();
      continue;
    }
    const statements = splitStatements(buffer);
    if (
      statements.length === 1 &&
      /^\s*match\b/i.test(statements[0]) &&
      !/\b(insert|delete|put|select|reduce)\b/i.test(statements[0])
    ) {
      // A bare `match …;` is an incomplete pipeline: it binds but projects nothing. Wait for the
      // stage that says what to do with it.
      prompt();
      continue;
    }
    for (const statement of statements) print(await session.run(statement));
    buffer = '';
    prompt();
  }

  rl.close();
  await session.close();
  return 0;
}

/* v8 ignore stop */

async function runSource(source: string, database: string): Promise<number> {
  const session = new TypeDBLiteSession(database);
  let failed = false;
  try {
    for (const statement of splitStatements(source)) {
      const outcome = await session.run(statement);
      print(outcome);
      if (outcome.kind === 'error') {
        failed = true;
        break;
      }
    }
  } finally {
    await session.close();
  }
  return failed ? 1 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const database = valueOf('--database') ?? ':memory:';

  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  const file = valueOf('--file');
  if (file) return runSource(readFileSync(file, 'utf8'), database);
  const statement = valueOf('--exec');
  if (statement) return runSource(statement, database);
  if (argv.includes('--repl')) return runRepl(database);

  stdout.write(`${HELP}\n`);
  return 1;
}

/**
 * Whether this module is the script Node was asked to run, so that tests can import it without
 * booting a shell.
 *
 * 🔴 **Real paths, never names.** This once compared the script's file name, split on `/`, with
 * the module's URL. Launched through npm's `bin` link the name is `typedblite`, not `main.js`, and on
 * Windows the path has no `/` to split on. Either way `main()` never ran, and the CLI exited 0
 * having printed nothing. `realpathSync` follows the link, and `fileURLToPath` gives the module's
 * path in the platform's own form.
 */
function isEntryPoint(script: string | undefined): boolean {
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/* v8 ignore start -- @preserve -- entry point only; the module is imported by tests. */
if (isEntryPoint(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
/* v8 ignore stop */
