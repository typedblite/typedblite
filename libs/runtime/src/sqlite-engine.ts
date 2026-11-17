import { TypeDBLiteInterpreter, type TypeDBLiteOptions, type TypeDBLiteSchemaSnapshot } from './interpreter.js';

/** One result row, shaped the way `rowString` and `rowNumber` read it. */
export interface EngineRow {
  readonly [variable: string]: unknown;
}

/**
 * A SQLite engine behind `TypeDBLiteDatabase`'s five methods.
 *
 * Async throughout because the port is, not because SQLite is: `node:sqlite` is synchronous, and
 * pretending otherwise here would be the only honest place to hide a future async engine.
 *
 * @privateRemarks
 * 🔴 This deliberately has no dependency on application-layer code, and application code should not
 * depend on this class directly — only on the port interface. The port
 * ([ADR-002](../../../docs/architecture/adr-002-typeql-engine-as-a-port.md) Decision 1) is
 * structural: `TypeDBLiteDatabase.open({ engine })` accepts anything with these five methods. A
 * direct dependency either way would work and would quietly make SQLite *the* engine, which
 * Decision 1 exists to prevent — this is the default adapter, and a TypeDB server over the network
 * is another.
 */
export class SqliteEngine {
  private readonly interpreter: TypeDBLiteInterpreter;

  /**
   * Opens a database and an interpreter over it.
   *
   * @param location `:memory:`, or the path of a SQLite file.
   * @param options How the interpreter opens the database and runs queries.
   */
  constructor(location = ':memory:', options: TypeDBLiteOptions = {}) {
    this.interpreter = new TypeDBLiteInterpreter(location, undefined, options);
  }

  /**
   * This engine's change log.
   *
   * @privateRemarks
   * 🔴 **This does not widen the port.** `TypeDBLiteDatabase`'s five methods are the port
   * ([ADR-002](../../../docs/architecture/adr-002-typeql-engine-as-a-port.md) Decision 1) and
   * they stay five — a TypeDB server over the network has no change log and must not be asked for
   * one. What this exposes is a *capability of this adapter*, reachable by whoever composed it.
   * The composition root holds the engine, so it can replicate; a consumer holding only the port
   * cannot, which is the correct asymmetry.
   */
  get changeLog(): TypeDBLiteInterpreter['changeLog'] {
    return this.interpreter.changeLog;
  }

  /** Whether a schema has been applied to this database — survives a reopen. */
  get hasSchema(): boolean {
    return this.interpreter.hasSchema;
  }

  /** The schema applied to this database, as sorted lists. */
  schemaSnapshot(): TypeDBLiteSchemaSnapshot {
    return this.interpreter.schemaSnapshot();
  }

  /** Applies schema definitions: the `define` of the interpreter. Safe to repeat. */
  async define(schema: string): Promise<unknown> {
    return this.interpreter.define(schema);
  }

  /** Runs a pipeline for its effect and returns the execution report. */
  async execute(query: string): Promise<unknown> {
    // 🔴 Return the engine's report rather than swallowing it. This adapter is the only thing
    // between the interpreter and every repository in the workspace, so dropping the report here
    // would make ADR-004 unreachable from the layer that is supposed to decide what to do with it.
    return this.interpreter.execute(query);
  }

  /** Runs a pipeline and returns its rows. */
  async query(query: string): Promise<{ rows: readonly EngineRow[] }> {
    return this.interpreter.query(query);
  }

  /**
   * A no-op, and `TypeDBLiteDatabase.persist` is documented as one so a caller can persist
   * unconditionally after a write.
   *
   * A file-backed SQLite database has already written by the time this is called: the interpreter
   * commits each pipeline. There is no snapshot to take.
   */
  async persist(): Promise<void> {
    return undefined;
  }

  /**
   * Run `work` in one transaction: `BEGIN IMMEDIATE`, then `COMMIT` if it resolves or `ROLLBACK` if it throws,
   * rethrowing the same error. Inside `work`, this engine's own `execute` and `query` are in the transaction.
   *
   * One handle, one transaction at a time. Two overlapping calls on the same engine would share one SQLite connection
   * and so one transaction; `TypeDBLiteDatabase` serialises them, and a second `BEGIN` here is refused rather than
   * silently joined.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.interpreter.beginTransaction();
    let result: T;
    try {
      result = await work();
    } catch (error) {
      this.interpreter.rollbackTransaction();
      throw error;
    }
    try {
      this.interpreter.commitTransaction();
    } catch (error) {
      this.interpreter.rollbackTransaction();
      throw error;
    }
    return result;
  }

  /** Closes the database. */
  async close(): Promise<void> {
    this.interpreter.close();
  }
}
