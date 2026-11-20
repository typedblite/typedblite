/**
 * SPIKE: a `SqliteDatabase` binding over a Durable Object's SQLite storage (`ctx.storage.sql`).
 *
 * The Durable Object API is synchronous, like `node:sqlite`, which is why it can satisfy the interpreter's interface
 * at all. Its differences, and how this binding answers each:
 *
 * - **No `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` or `RELEASE` in `sql.exec()`**: the platform owns transactions,
 *   through `ctx.storage.transactionSync(fn)`. The host wraps each engine call in {@link DurableObjectSqlite.unitOfWork},
 *   one `transactionSync`, and the interpreter's own transaction statements are absorbed here as bookkeeping. Every
 *   rollback site in the runtime rethrows after rolling back (read on 2026-11-19), so the thrown error unwinds out of
 *   `transactionSync`, which rolls the whole call back. A rollback whose error does NOT escape the call cannot be
 *   honoured this way, so it is refused loudly (`PartialRollbackError`) and counted.
 * - **No named parameters**: only `?`. Named parameters (`:id`, bare keys as `node:sqlite` takes them) are rewritten
 *   to `?` once per SQL text, outside string literals, identifiers and comments.
 * - **No `changes`**: `run()` reads `SELECT changes()` straight after the statement, as the WASM binding does.
 * - **No `errcode`**: the constraint codes the engine matches on are restored from SQLite's message text.
 * - **Blobs are `ArrayBuffer`s**, both ways.
 * - **No close**: the storage belongs to the object.
 */
import type {
  SqliteDatabase,
  SqliteNamedParameters,
  SqliteParameter,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from '../../../libs/runtime/src/sqlite-database.js';

/** The part of `SqlStorageCursor` this binding reads. */
interface SqlCursor extends Iterable<Record<string, unknown>> {
  toArray(): Record<string, unknown>[];
  readonly rowsWritten: number;
}

/** The part of `DurableObjectStorage` this binding reads. */
export interface DurableObjectStorageLike {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): SqlCursor;
    readonly databaseSize: number;
  };
  transactionSync<T>(closure: () => T): T;
}

/** A rollback was asked for inside a call that then returned normally: the platform cannot roll back part of a call. */
export class PartialRollbackError extends Error {
  constructor() {
    super(
      'The engine rolled back part of this call and then carried on. A Durable Object can only roll back a whole ' +
        'transactionSync, so this call was rolled back in full instead.',
    );
    this.name = 'PartialRollbackError';
  }
}

/** What the binding saw, for the spike's report. */
export interface DurableObjectSqliteStats {
  /** Statements sent to `sql.exec()`, including the `SELECT changes()` after each `run()`. */
  statements: number;
  /** `BEGIN`, `COMMIT`, `SAVEPOINT`, … absorbed instead of sent. */
  transactionStatementsAbsorbed: number;
  /** Units of work run (one per engine call). */
  unitsOfWork: number;
  /** Units of work that threw, and so were rolled back by the platform. */
  unitsRolledBack: number;
  /** Rollbacks the engine asked for in a call that then returned normally. Must stay 0. */
  partialRollbacks: number;
  /** Calls that threw after the engine had committed a top-level transaction in them. Node keeps that work; this binding cannot. */
  throwsAfterCommit: number;
  /** PRAGMAs the platform refused that this binding answers itself. */
  pragmasAnswered: Record<string, number>;
  /** `run()`s where `rowsWritten` and `changes()` disagreed (diagnostic only; `changes()` is what is returned). */
  rowsWrittenMismatches: number;
  /** `CREATE`/`DROP` statements on the `temp` schema, run on `main` instead. */
  tempSchemaRewrites: number;
}

const TRANSACTION_STATEMENT =
  /^\s*(BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?|COMMIT(\s+TRANSACTION)?|END(\s+TRANSACTION)?|ROLLBACK(\s+TRANSACTION)?(\s+TO(\s+SAVEPOINT)?\s+\w+)?|SAVEPOINT\s+\w+|RELEASE(\s+SAVEPOINT)?\s+\w+)\s*;?\s*$/i;

/** SQLite's extended result codes for the constraint failures the engine distinguishes. */
const CONSTRAINT_CODES: ReadonlyArray<readonly [RegExp, number]> = [
  [/UNIQUE constraint failed/, 2067],
  [/PRIMARY KEY constraint failed|PRIMARYKEY/, 1555],
  [/FOREIGN KEY constraint failed/, 787],
  [/NOT NULL constraint failed/, 1299],
  [/CHECK constraint failed/, 275],
];

function withErrcode(error: unknown): unknown {
  if (error instanceof Error && (error as { errcode?: unknown }).errcode === undefined) {
    const match = CONSTRAINT_CODES.find(([pattern]) => pattern.test(error.message));
    if (match) (error as { errcode?: number }).errcode = match[1];
  }
  return error;
}

/** `:name`, `@name` and `$name` to `?`, outside strings, quoted identifiers and comments. Cached per SQL text. */
const rewrites = new Map<string, { readonly sql: string; readonly names: readonly string[] }>();
function rewriteNamed(sql: string): { readonly sql: string; readonly names: readonly string[] } {
  const cached = rewrites.get(sql);
  if (cached) return cached;
  let out = '';
  const names: string[] = [];
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j += 2;
          else break;
        } else j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const j = end === -1 ? sql.length : end;
      out += sql.slice(i, j);
      i = j;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, j);
      i = j;
    } else if ((c === ':' || c === '@' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j]!)) j += 1;
      names.push(sql.slice(i + 1, j));
      out += '?';
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  const rewritten = { sql: out, names };
  rewrites.set(sql, rewritten);
  return rewritten;
}

const isNamed = (value: unknown): value is SqliteNamedParameters =>
  typeof value === 'object' && value !== null && !(value instanceof Uint8Array);

function toBinding(value: SqliteParameter | undefined): unknown {
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`A Durable Object cannot bind the integer ${value}: it is outside JavaScript's safe range.`);
    }
    return Number(value);
  }
  return value ?? null;
}

function toRow(row: Record<string, unknown>): SqliteRow {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value instanceof ArrayBuffer) row[key] = new Uint8Array(value);
  }
  return row;
}

export class DurableObjectSqlite implements SqliteDatabase {
  readonly stats: DurableObjectSqliteStats = {
    statements: 0,
    transactionStatementsAbsorbed: 0,
    unitsOfWork: 0,
    unitsRolledBack: 0,
    partialRollbacks: 0,
    throwsAfterCommit: 0,
    pragmasAnswered: {},
    rowsWrittenMismatches: 0,
    tempSchemaRewrites: 0,
  };

  /** Open transaction and savepoint frames, as the engine believes them to be. */
  private depth = 0;
  private inUnit = false;
  private rollbackRequested = false;
  private committedInUnit = false;

  constructor(private readonly storage: DurableObjectStorageLike) {}

  /**
   * Run one engine call as one platform transaction. The interpreter's own transaction statements inside it are
   * absorbed; an error escaping `work` rolls everything in it back.
   */
  unitOfWork<T>(work: () => T): T {
    if (this.inUnit) return work();
    this.stats.unitsOfWork += 1;
    this.inUnit = true;
    this.rollbackRequested = false;
    this.committedInUnit = false;
    try {
      return this.storage.transactionSync(() => {
        const result = work();
        if (this.rollbackRequested) {
          this.stats.partialRollbacks += 1;
          throw new PartialRollbackError();
        }
        return result;
      });
    } catch (error) {
      this.stats.unitsRolledBack += 1;
      if (this.committedInUnit && !this.rollbackRequested) this.stats.throwsAfterCommit += 1;
      throw error;
    } finally {
      this.inUnit = false;
      this.depth = 0;
    }
  }

  get isTransaction(): boolean {
    return this.depth > 0;
  }

  /** Sends one statement to the platform, translating its errors. */
  run(sql: string, bindings: readonly unknown[] = []): SqlCursor {
    this.stats.statements += 1;
    try {
      return this.storage.sql.exec(sql, ...bindings);
    } catch (error) {
      if (error instanceof Error) (error as { sql?: string }).sql ??= sql;
      throw withErrcode(error);
    }
  }

  exec(sql: string): void {
    if (TRANSACTION_STATEMENT.test(sql)) {
      this.absorb(sql);
      return;
    }
    // The platform refuses the `temp` schema (SQLITE_AUTH). The runtime only uses it for the FTS5 probe, so that a
    // read-only connection can still be probed; this storage is never read-only, so the probe runs in `main`.
    if (/^\s*(CREATE|DROP)\b[^;]*\btemp\./i.test(sql)) {
      sql = sql.replace(/\btemp\./gi, '');
      this.stats.tempSchemaRewrites += 1;
    }
    const pragma = /^\s*PRAGMA\s+(\w+)/i.exec(sql)?.[1]?.toLowerCase();
    try {
      this.run(sql).toArray();
    } catch (error) {
      // `busy_timeout` waits for other connections, and there are none: the object is the only one.
      if (pragma === 'busy_timeout') {
        this.stats.pragmasAnswered[pragma] = (this.stats.pragmasAnswered[pragma] ?? 0) + 1;
        return;
      }
      throw error;
    }
  }

  prepare(sql: string): SqliteStatement {
    const pragma = /^\s*PRAGMA\s+(journal_mode)\b/i.exec(sql)?.[1]?.toLowerCase();
    return new DurableObjectStatement(this, sql, pragma);
  }

  close(): void {
    // The storage belongs to the Durable Object and outlives any one interpreter.
  }

  /** @internal */
  pragmaAnswered(name: string): void {
    this.stats.pragmasAnswered[name] = (this.stats.pragmasAnswered[name] ?? 0) + 1;
  }

  private absorb(sql: string): void {
    if (!this.inUnit) {
      throw new Error(`'${sql.trim()}' outside a unit of work: wrap the engine call in DurableObjectSqlite.unitOfWork.`);
    }
    this.stats.transactionStatementsAbsorbed += 1;
    const statement = sql.trim().toUpperCase();
    if (statement.startsWith('BEGIN') || statement.startsWith('SAVEPOINT')) {
      this.depth += 1;
    } else if (statement.startsWith('ROLLBACK') && /\bTO\b/.test(statement)) {
      // `ROLLBACK TO` keeps the savepoint open; `RELEASE` follows.
      this.rollbackRequested = true;
    } else if (statement.startsWith('ROLLBACK')) {
      this.rollbackRequested = true;
      this.depth = 0;
    } else {
      // COMMIT, END or RELEASE.
      if (this.depth === 1 && !statement.startsWith('RELEASE')) this.committedInUnit = true;
      this.depth = Math.max(0, this.depth - 1);
    }
  }
}

class DurableObjectStatement implements SqliteStatement {
  constructor(
    private readonly db: DurableObjectSqlite,
    private readonly sql: string,
    private readonly pragma: string | undefined,
  ) {}

  private cursor(parameters: readonly unknown[]): SqlCursor {
    const [first, ...rest] = parameters;
    if (isNamed(first)) {
      if (rest.length > 0) throw new Error('Named parameters mixed with positional ones are not supported.');
      const { sql, names } = rewriteNamed(this.sql);
      return this.db.run(
        sql,
        names.map((name) => {
          if (!(name in first)) throw new Error(`Missing named parameter '${name}'.`);
          return toBinding(first[name]);
        }),
      );
    }
    return this.db.run(this.sql, (parameters as SqliteParameter[]).map(toBinding));
  }

  private rows(parameters: readonly unknown[]): SqliteRow[] {
    if (this.pragma === 'journal_mode') {
      // The object is its storage's only connection, so WAL's purpose (readers beside a writer) does not arise, and
      // the platform owns the journal. Answer as the interpreter hopes, so it does not warn about contention.
      try {
        return this.cursor(parameters).toArray().map(toRow);
      } catch {
        this.db.pragmaAnswered('journal_mode');
        return [{ journal_mode: 'wal' }];
      }
    }
    return this.cursor(parameters).toArray().map(toRow);
  }

  get(...parameters: unknown[]): SqliteRow | undefined {
    return this.rows(parameters)[0];
  }

  all(...parameters: unknown[]): SqliteRow[] {
    return this.rows(parameters);
  }

  run(...parameters: unknown[]): SqliteRunResult {
    const cursor = this.cursor(parameters);
    cursor.toArray(); // step to completion, as `RETURNING` needs
    const changes = Number(this.db.run('SELECT changes() AS changes').toArray()[0]?.['changes'] ?? 0);
    if (cursor.rowsWritten !== changes) this.db.stats.rowsWrittenMismatches += 1;
    return { changes };
  }
}
