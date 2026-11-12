import { SqliteEngine } from '@typedblite/runtime';

/** What running a chunk of TypeQLite produced, in a shape both the REPL and the CLI can render. */
export type Outcome =
  | { kind: 'rows'; rows: ReadonlyArray<Record<string, string>> }
  | { kind: 'ok'; statement: 'define' | 'write' }
  | { kind: 'error'; message: string };

/**
 * A TypeQLite session — the piece the REPL and the CLI share, so neither owns the semantics.
 *
 * 🔴 Statement classification is **textual, on the leading keyword**, and that is deliberate rather
 * than lazy. The interpreter already parses properly and rejects what it cannot run; duplicating a
 * parse here to decide which of its three methods to call would be a second, worse parser that can
 * disagree with the real one. This only has to answer "which method", and the interpreter has the
 * final say on whether the text is valid at all.
 */
export class TypeDBLiteSession {
  private readonly engine: SqliteEngine;

  constructor(location = ':memory:') {
    this.engine = new SqliteEngine(location);
  }

  /** Asks the ENGINE, not a local flag — a file-backed database reopened in a new process
   * already has its schema, and a flag here would say otherwise. */
  get hasSchema(): boolean {
    return this.engine.hasSchema;
  }

  async run(source: string): Promise<Outcome> {
    const text = source.trim();
    if (!text) return { kind: 'ok', statement: 'write' };

    // 🔴 Without this, a statement run before any `define` fails with SQLite's own
    // `no such table: thing` — an internal leaking through as if it were a TypeQLite error, and
    // exactly the kind of message this shell exists to stop people deciphering.
    if (!this.hasSchema && !/^define\b/i.test(text)) {
      return {
        kind: 'error',
        message:
          'no schema has been applied — run a `define` block first, or load one with --file',
      };
    }

    try {
      if (/^define\b/i.test(text)) {
        await this.engine.define(text);
        return { kind: 'ok', statement: 'define' };
      }
      if (isRead(text)) {
        const { rows } = await this.engine.query(text);
        return { kind: 'rows', rows: rows.map(render) };
      }
      await this.engine.execute(text);
      return { kind: 'ok', statement: 'write' };
    } catch (error) {
      // Returned, never thrown: a REPL that dies on a typo is unusable, and one reason this exists
      // is to make TypeQLite's errors legible rather than fatal.
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.engine.close();
  }
}

/**
 * A read is a pipeline with no write stage. 🔴 It used to be "a pipeline with `select`", so a
 * bare `match` went to `execute()`, which skips a pipeline with nothing to write and reports
 * success — `(0 rows)` for `match $x isa ganesh;` (`d-20260911-a-match-pipeline-with-no-select`).
 * String literals are blanked first so `has note "please insert this"` is not mistaken for a write.
 */
function isRead(text: string): boolean {
  // Both quote styles — `STRING` admits `'…'` since Phase 06 (review, round 1).
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  return !/\b(insert|delete|put|update)\b/i.test(withoutStrings);
}

/**
 * Result cells arrive as concepts; the shells want plain strings. An attribute prints its value;
 * a thing prints `entity:person:#3` — `toString()` is the one rendering every kind has.
 */
function render(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [variable, value] of Object.entries(row)) out[variable] = String(value);
  return out;
}

/**
 * Split a source into statements a session can run one at a time.
 *
 * 🔴 A pipeline may span lines and semicolons: `match $s isa skill, has skill-id "x";` followed by
 * `insert …;` is **one** pipeline, and it is the normal shape in every repository. So splitting on
 * `;` alone would tear every `match … insert` in the codebase in half.
 *
 * A statement therefore ends at a `;` that is **not** followed by a stage keyword — the same
 * ordering the grammar encodes, where `match` is followed by an optional write and an optional
 * projection.
 */
export function splitStatements(source: string): string[] {
  const text = source.replace(/^\s*#[^\n]*$/gm, '');
  const statements: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ';') continue;
    const statement = text.slice(start, i + 1);
    const body = statement.trim();
    if (!body) {
      start = i + 1;
      continue;
    }
    const rest = text.slice(i + 1);

    // A `define` block holds many definitions, each `;`-terminated, so it ends only where a
    // pipeline begins — or at the end of the input.
    if (/^define\b/i.test(body)) {
      if (!/^\s*(match|insert|put|delete|update)\b/i.test(rest)) continue;
    } else if (/^match\b/i.test(body)) {
      // A `match` is `;`-separated patterns followed by a write and/or a projection, so its
      // internal semicolons are NOT terminators. The pipeline ends once its LAST stage has been
      // consumed — the stage order the grammar encodes: `match (write)? (select)? (reduce)?`. A
      // `select` followed by a `reduce` is not the end (Phase 06 review, round 4).
      if (!/\b(insert|put|delete|update|select|reduce|sort|offset|limit|distinct|require|fetch)\b/i.test(body)) continue;
      // A stage that only reshapes the stream — and a `fetch`, which ends it — continues the
      // pipeline it follows: `match …; select $x; sort $x; limit 1;` is one query.
      if (/^\s*(select|reduce|sort|offset|limit|distinct|require|fetch)\b/i.test(rest)) continue;
    }

    statements.push(body);
    start = i + 1;
  }

  const tail = text.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
