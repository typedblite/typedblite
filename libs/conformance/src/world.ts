import { DiagnosticCode, TypeDBLiteInterpreter, type JsonValue, type TypeDBLiteValue } from '@typedblite/runtime';

export type TransactionKind = 'schema' | 'write' | 'read';

export type AnswerRow = Record<string, TypeDBLiteValue>;

export interface Answers {
  readonly rows: ReadonlyArray<AnswerRow>;
  /** The query that produced them, for the failure message. */
  readonly query: string;
  /** The driver's `getHas` — how `key:ref:1` is resolved against a thing cell, by iid. */
  readonly has: (iid: number, attribute: string) => ReadonlyArray<TypeDBLiteValue>;
  /** A `fetch` query's answers — one document each — and then `rows` is empty. */
  readonly documents?: ReadonlyArray<JsonValue>;
}

/** A step's failure, distinguished from an engine failure so the report can say which it was. */
export class HarnessError extends Error {}

/**
 * The engine ran nothing — no projection reported for a read, a skipped write-less pipeline. 🔴 Never the
 * failure a `; fails` step specifies: TypeDB would have evaluated the query, and whatever it did
 * then is the behaviour under test. `expectFailure` refuses this in every mode.
 */
export class EvaluatedNothing extends HarnessError {}

/**
 * One scenario's state — what a driver's `World` holds in its own behaviour tests.
 *
 * 🔴 **The harness stands in for the connection layer, and only for it.** TypeDB's spec drives a
 * server through a driver: databases, transactions and their kinds are protocol, enforced before
 * a query reaches the language. TypeDBLite has one interpreter per database and no transactions, so
 * the rules a driver would meet at the server are met here — a write in a read transaction fails,
 * a query with no transaction open fails — and **nothing else is**. What the harness does not do,
 * on purpose:
 *
 * - **No rollback on `transaction closes`.** A write not committed stays written. A scenario that
 *   asserts it is gone will *fail*, never pass, so the omission cannot flatter the score.
 * - **No commit-time validation.** `transaction commits; fails` cannot be produced here, and is
 *   reported as a fail.
 * - **`set time-zone` is recorded and has no effect.** Datetime-with-zone scenarios fail honestly.
 */
export class World {
  private readonly databases = new Map<string, TypeDBLiteInterpreter>();
  private transaction: { database: string; kind: TransactionKind; open: boolean } | undefined;
  public answers: Answers | undefined;
  public timeZone: string | undefined;

  /**
   * `open` is how a database is created — in memory, always, for the run. It is a parameter so the
   * harness's own tests can hand in an engine that projects nothing and prove the guards below
   * still refuse it, now that no query the real engine runs is skipped.
   */
  constructor(private readonly open: () => TypeDBLiteInterpreter = () => new TypeDBLiteInterpreter(':memory:')) {}

  databaseCount(): number {
    return this.databases.size;
  }

  createDatabase(name: string): void {
    if (this.databases.has(name)) throw new HarnessError(`database '${name}' already exists`);
    this.databases.set(name, this.open());
  }

  resetDatabase(name: string): void {
    this.databases.get(name)?.close();
    this.databases.set(name, this.open());
    this.transaction = undefined;
  }

  openTransaction(kind: TransactionKind, database: string): void {
    if (!this.databases.has(database)) {
      throw new HarnessError(`database '${database}' does not exist`);
    }
    this.transaction = { database, kind, open: true };
  }

  transactionIsOpen(): boolean {
    return this.transaction?.open === true;
  }

  commit(): void {
    if (!this.transaction?.open) throw new HarnessError('no open transaction to commit');
    this.transaction.open = false;
  }

  closeTransaction(): void {
    if (this.transaction) this.transaction.open = false;
  }

  /** The engine the open transaction addresses — refusing, as the server would, when there is none. */
  private engineFor(needs: TransactionKind): TypeDBLiteInterpreter {
    if (!this.transaction?.open) throw new HarnessError('no open transaction');
    const { kind, database } = this.transaction;
    const permitted: Record<TransactionKind, ReadonlyArray<TransactionKind>> = {
      schema: ['schema'],
      write: ['schema', 'write'],
      read: ['schema', 'write', 'read'],
    };
    if (!permitted[needs].includes(kind)) {
      throw new HarnessError(`a ${needs} query is not permitted in a ${kind} transaction`);
    }
    const engine = this.databases.get(database);
    if (!engine) throw new HarnessError(`database '${database}' does not exist`);
    return engine;
  }

  schemaQuery(text: string): void {
    this.engineFor('schema').define(text);
  }

  /**
   * 🔴 A write that evaluated nothing is a failure, not a success. `execute()` skips a pipeline
   * with no write stage, and reports a fact for each one it ran — no fact, nothing ran.
   */
  writeQuery(text: string): { rows: ReadonlyArray<AnswerRow>; documents?: ReadonlyArray<JsonValue> } {
    const report = this.engineFor('write').execute(text);
    // `emptyMatch` is a write that RAN, zero times — `match` bound nothing — which is a success on
    // TypeDB too. Only a pipeline that was skipped altogether reports neither fact.
    const ran = report.diagnostics.some(
      (d) => d.code === DiagnosticCode.wrote || d.code === DiagnosticCode.emptyMatch,
    );
    if (!ran) throw new EvaluatedNothing('TypeDBLite evaluated nothing: no write stage was executed');
    return { rows: report.rows, documents: report.documents };
  }

  /**
   * 🔴 A read that evaluated nothing is a failure, not an empty answer set. `query()` reports a
   * `projected` fact for each pipeline it ran; no fact, nothing ran. It used to skip a pipeline
   * with no `select` (`d-20260911-a-match-pipeline-with-no-select`, fixed in Phase 02), and this
   * guard is what kept the 114 scenarios asserting only `answer size is: 0` from passing hollowly
   * on the skip. It stays: the fact is the evidence, and an engine that stops reporting it is
   * refused the same way.
   */
  readQuery(text: string): ReadonlyArray<AnswerRow> {
    return this.readAnswers(text).rows;
  }

  /** A read's rows, and its documents when it ends in `fetch` — under the same evaluated-nothing guard. */
  readAnswers(text: string): { rows: ReadonlyArray<AnswerRow>; documents?: ReadonlyArray<JsonValue> } {
    const { rows, diagnostics, documents } = this.engineFor('read').query(text);
    if (!diagnostics.some((d) => d.code === DiagnosticCode.projected)) {
      throw new EvaluatedNothing('TypeDBLite evaluated nothing: no pipeline reported a projection');
    }
    return { rows, documents };
  }

  /** A thing's attributes of one type, from the engine the open transaction reads. */
  attributesOf(iid: number, attribute: string): ReadonlyArray<TypeDBLiteValue> {
    return this.engineFor('read').attributesOf(iid, attribute);
  }

  close(): void {
    for (const engine of this.databases.values()) engine.close();
    this.databases.clear();
  }
}
