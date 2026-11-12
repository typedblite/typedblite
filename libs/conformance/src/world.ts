import { DiagnosticCode, TypeDBLiteInterpreter, diagnosticOf, type ExecutionReport, type GivenRows, type JsonValue, type TypeDBLiteValue } from '@typedblite/runtime';

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
  /** The value type an attribute type holds — how an `attr:` identifier's literal is read. */
  readonly valueTypeOf?: (attribute: string) => string | undefined;
}

/** What a query answers the harness: rows, or a document each, and the facts saying it ran. */
export interface EngineAnswers extends ExecutionReport {
  readonly rows: ReadonlyArray<AnswerRow>;
  readonly documents?: ReadonlyArray<JsonValue>;
}

/**
 * The engine a database is — TypeDBLite's interpreter, or (`typedb-oracle.ts`) a live TypeDB the same
 * steps drive as the oracle. Exactly what the harness asks of one, and no more.
 */
export interface Engine {
  define(text: string): unknown;
  execute(text: string, given?: GivenRows): EngineAnswers;
  query(text: string, given?: GivenRows): EngineAnswers;
  /** A write or schema transaction; TypeDBLite's has one kind, TypeDB's is opened as the one named. */
  beginTransaction(kind?: 'schema' | 'write'): void;
  commitTransaction(): void;
  rollbackTransaction(): void;
  close(): void;
  attributeValueType(attribute: string): string | undefined;
  attributesOf(iid: number, attribute: string): ReadonlyArray<TypeDBLiteValue>;
  thingNumbered(kind: 'entity' | 'relation', type: number, object: number): number | undefined;
  /** A thing's iid as the engine writes it in a query; TypeDBLite's cell carries its own. */
  iidText?(cell: TypeDBLiteValue): string;
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
 * - **A write or schema transaction is the engine's transaction.** `transaction commits` commits it
 *   — after the engine's commit-time checks, which can fail it (`transaction commits; fails`) —
 *   and `transaction closes`, opening another, or a query that fails, rolls it back: TypeDB ends a
 *   transaction whose query failed (match.feature L1484, *"transaction is open: false"*).
 * - A read transaction holds no engine transaction: it reads what is committed.
 * - **`set time-zone` is recorded and has no effect.** Datetime-with-zone scenarios fail honestly.
 */
export class World {
  private readonly databases = new Map<string, Engine>();
  private transaction: { database: string; kind: TransactionKind; open: boolean } | undefined;
  public answers: Answers | undefined;
  /** What `set query given rows` set, for the next `… with given rows` step. */
  public givenRows: GivenRows | undefined;
  public timeZone: string | undefined;

  /**
   * `open` is how a database is created — in memory, always, for the run. It is a parameter so the
   * harness's own tests can hand in an engine that projects nothing and prove the guards below
   * still refuse it, now that no query the real engine runs is skipped.
   */
  constructor(private readonly open: () => Engine = () => new TypeDBLiteInterpreter(':memory:')) {}

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
    this.closeTransaction();
    this.transaction = { database, kind, open: true };
    if (kind !== 'read') this.databases.get(database)?.beginTransaction(kind);
  }

  transactionIsOpen(): boolean {
    return this.transaction?.open === true;
  }

  commit(): void {
    if (!this.transaction?.open) throw new HarnessError('no open transaction to commit');
    const { kind, database } = this.transaction;
    this.transaction.open = false;
    // The engine rolls back a commit that fails its checks; the transaction is over either way.
    if (kind !== 'read') this.databases.get(database)?.commitTransaction();
  }

  closeTransaction(): void {
    if (!this.transaction?.open) return;
    const { kind, database } = this.transaction;
    this.transaction.open = false;
    if (kind !== 'read') this.databases.get(database)?.rollbackTransaction();
  }

  /**
   * A write or schema query that fails in evaluation ends its transaction, as TypeDB's does: nothing
   * it held is kept (put.feature L592).
   * One that fails to PARSE never reached the transaction, which stays open — the spec runs several
   * `; parsing fails` steps in one transaction (define.feature L2031).
   */
  private failing<T>(query: TransactionKind, run: () => T): T {
    try {
      return run();
    } catch (error) {
      // A refused READ leaves its transaction open, whatever kind it is (match.feature L1009, a read in
      // the Background's write transaction: "transaction is open: true"); L1516 alone expects otherwise.
      if (diagnosticOf(error)?.code !== DiagnosticCode.parseFailed && query !== 'read') this.closeTransaction();
      throw error;
    }
  }

  /** The engine the open transaction addresses — refusing, as the server would, when there is none. */
  private engineFor(needs: TransactionKind): Engine {
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
    this.failing('schema', () => this.engineFor('schema').define(text));
  }

  /**
   * 🔴 A write that evaluated nothing is a failure, not a success. `execute()` skips a pipeline
   * with no write stage, and reports a fact for each one it ran — no fact, nothing ran.
   */
  writeQuery(text: string, given?: GivenRows): { rows: ReadonlyArray<AnswerRow>; documents?: ReadonlyArray<JsonValue> } {
    const report = this.failing('write', () => this.engineFor('write').execute(text, given));
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
  readAnswers(text: string, given?: GivenRows): { rows: ReadonlyArray<AnswerRow>; documents?: ReadonlyArray<JsonValue> } {
    const { rows, diagnostics, documents } = this.failing('read', () => this.engineFor('read').query(text, given));
    if (!diagnostics.some((d) => d.code === DiagnosticCode.projected)) {
      throw new EvaluatedNothing('TypeDBLite evaluated nothing: no pipeline reported a projection');
    }
    return { rows, documents };
  }

  /** An attribute type's value type, from the engine the open transaction reads. */
  attributeValueType(attribute: string): string | undefined {
    return this.engineFor('read').attributeValueType(attribute);
  }

  /** A thing's iid as the engine reads it back in a query — what `<answer.x.iid>` is replaced by. */
  iidOf(cell: TypeDBLiteValue): string {
    const engine = this.engineFor('read');
    return engine.iidText?.(cell) ?? cell.iidHex;
  }

  /** The thing TypeDB would number so — a given row's iid cell (see `givenRows`). */
  thingNumbered(kind: 'entity' | 'relation', type: number, object: number): number | undefined {
    return this.engineFor('read').thingNumbered(kind, type, object);
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
