import type { ExecutionReport } from '@typedblite/runtime';
/** The engine package's exports that a host reaches for at run time. */
export interface TypeDbLiteRuntime {
    readonly SqliteEngine: new (location?: string) => EmbeddedDatabase;
    readonly TypeDBLiteReplicator: new (log: unknown, hubUrl: string, pushIntervalMs?: number, headers?: () => Record<string, string> | Promise<Record<string, string>>) => {
        replicateOnce(options: {
            readonly direction: 'push' | 'pull' | 'duplex';
            readonly from?: {
                readonly pull?: number;
                readonly push?: number;
            };
        }): Promise<{
            readonly cursor: {
                readonly pull?: number;
                readonly push?: number;
            };
            readonly applied: number;
            readonly conflicts: number;
        }>;
    };
    readonly createChangeStreamHandler: (log: unknown, options?: {
        readonly pollMs?: number;
        readonly limit?: number;
        readonly path?: string;
    }) => {
        handle: (request: unknown, response: unknown) => void;
        close: () => void;
    };
}
/**
 * Loads the engine package, `@typedblite/runtime`, which is ESM-only.
 *
 * Exported because a host that replicates needs the replicator and the change-stream handler, not only the engine,
 * and a second copy of the loading below would be a second place to get it wrong.
 *
 * @privateRemarks
 * 🔴 **Loaded lazily, with a dynamic `import()`.** A CommonJS host `require`s this package (Node loads an ES module
 * from `require` when its graph has no top-level `await`), and the engine and its ESM-only language dependencies
 * are loaded only when a database is first opened. A host that supplies its own `engine` never loads the default.
 */
export declare function loadTypeDbLiteRuntime(): Promise<TypeDbLiteRuntime>;
/**
 * A new engine at `location` (`:memory:` when omitted), for a composition root that needs to keep hold of it: to
 * reach its change log and replicate it.
 */
export declare function createSqliteEngine(location?: string): Promise<EmbeddedDatabase>;
/** What a write, or a `define`, reported. */
export interface WriteOutcome {
    /**
     * The engine's execution diagnostics, typed from the runtime's own `ExecutionReport`.
     *
     * @privateRemarks
     * 🔴 Typed from the runtime, not redeclared. A consumer that must not import an LSP package declares the narrower
     * structural view it needs (range, severity, code, message, source), and these diagnostics satisfy it.
     */
    readonly diagnostics: ExecutionReport['diagnostics'];
}
/**
 * What opening a schema'd store produced: the handle, and whatever the opening `define` reported.
 *
 * @privateRemarks
 * 🔴 Every store opener applies its schema as the first thing it does after `TypeDBLiteDatabase.open`, so an
 * engine-level fact raised only at construction ("Could not enable WAL", Information severity) surfaces on exactly
 * this report. Returning it beside the database, rather than swallowing it inside the opener, is what lets a caller
 * read it.
 */
export interface StoreOpenResult {
    readonly database: TypeDBLiteDatabase;
    readonly report: WriteOutcome;
}
/** One result row. Values are read through the engine's concept wrappers (`asString`, `asInteger`, …). */
export interface TypeDBLiteRow {
    readonly [variable: string]: {
        asString?: () => string;
    } | unknown;
}
/** What a read answered. */
export interface TypeDBLiteQueryResult {
    readonly rows: readonly TypeDBLiteRow[];
}
/** How `TypeDBLiteDatabase.open` opens a database. */
export interface TypeDBLiteDatabaseOptions {
    /** Database name; also the filename beneath `storagePath`. */
    readonly name: string;
    /**
     * Directory for a file-backed database. Omit for in-memory: the default, and what unit tests should use.
     *
     * TypeDBLite writes through as it goes, so there is no snapshot to take and nothing to lose between `persist()`
     * calls.
     */
    readonly storagePath?: string;
    /**
     * Use this engine instead of the default. When supplied, the default is neither loaded nor constructed, so an
     * alternative engine costs nothing at startup and needs no dependency from this package to whatever provides it.
     */
    readonly engine?: EmbeddedDatabase;
}
/**
 * The engine behind a `TypeDBLiteDatabase`: five methods, and the port.
 *
 * @privateRemarks
 * 🔴 **Exported so an engine can be supplied, not so one can be assumed.** TypeDBLite is the default; a TypeDB server
 * reached over the network would be another adapter. The port is structural (anything with these five methods
 * qualifies), which is what keeps an online engine possible now that the local one has a default.
 */
export interface EmbeddedDatabase {
    /** Apply a `define` block. */
    define(schema: string): Promise<unknown>;
    /** Run a write. */
    execute(query: string): Promise<unknown>;
    /** Run a read. */
    query(query: string): Promise<{
        rows: readonly TypeDBLiteRow[];
    }>;
    /** Make what was written durable, if the engine needs telling. */
    persist(): Promise<void>;
    /** Release the store. */
    close(): Promise<void>;
    /**
     * Run `work` atomically: everything the engine's own `execute` and `query` do inside it commits together or not at
     * all.
     *
     * @privateRemarks
     * 🔴 **Optional on the type, never optional in effect.** An engine with no native transaction must leave this out
     * and be refused by `TypeDBLiteDatabase.transaction`; it may not implement it by running `work` without atomicity.
     * The port stays five methods for an engine that cannot do this.
     */
    transaction?<T>(work: () => Promise<T>): Promise<T>;
}
/** The refusal: this database's engine has no transaction, and the work was not run. */
export declare class TransactionsNotSupportedError extends Error {
    /** Names the database whose engine cannot run a transaction. */
    constructor(databaseName: string);
}
/**
 * What `transaction`'s work is given: the database's `execute` and `query`, inside the transaction. The work must
 * use this and not the `TypeDBLiteDatabase`, whose own methods wait for the transaction to end.
 */
export interface TypeDBLiteTransaction {
    /** Run a write inside the transaction. */
    execute(query: string): Promise<WriteOutcome>;
    /** Run a read inside the transaction; it sees the transaction's own writes. */
    query(query: string): Promise<TypeDBLiteQueryResult>;
}
/**
 * Read a string attribute out of a result row.
 *
 * The engine wraps values, so `row.x` is not the string; `asString()` is. Centralized here because every repository
 * would otherwise reinvent it, and get the `undefined` case wrong.
 */
export declare function rowString(row: TypeDBLiteRow, variable: string): string | null;
/**
 * Read a numeric attribute out of a result row.
 *
 * `asInteger` is tried before `asDouble` so a whole number does not come back as a float.
 *
 * @privateRemarks
 * 🔴 `rowString` cannot do this. The engine's `asString()` **throws** `Cannot extract string from
 * attribute(integer)` rather than coercing, so a numeric attribute needs its own reader.
 */
export declare function rowNumber(row: TypeDBLiteRow, variable: string): number | null;
/** Throws when the variable is absent or is not numeric. */
export declare function requiredRowNumber(row: TypeDBLiteRow, variable: string): number;
/** Throws when the variable is absent: a missing `select` is a bug, not an empty result. */
export declare function requiredRowString(row: TypeDBLiteRow, variable: string): string;
/**
 * A handle on one TypeDBLite store, reached through TypeQLite.
 *
 * @privateRemarks
 * 🔴 **Deliberately not a document-shaped, per-document CRUD interface.** Forcing TypeQLite through one would
 * produce a lowest-common-denominator interface serving neither kind of store. A TypeQL store is reached through
 * TypeQLite, which is the point of choosing it.
 */
export declare class TypeDBLiteDatabase {
    private readonly database;
    /** The database's name. */
    readonly name: string;
    /** False for an in-memory database, where a snapshot has nowhere to go. */
    readonly durable: boolean;
    /**
     * Set while a transaction is open. Every other method waits on it, and a second transaction queues behind it: one
     * handle is one SQLite connection, so an outsider's write during a transaction would otherwise land inside it.
     */
    private openTransaction;
    /**
     * Marks the async context of a running transaction's work, so a call back into this database from inside it is
     * refused instead of waiting on the transaction it is part of (a deadlock). Compared by identity: a different
     * `TypeDBLiteDatabase` is not inside this one's transaction.
     */
    private readonly insideTransaction;
    private constructor();
    /**
     * Open a database. Construct through `open`, not `new`: the engine is loaded asynchronously, and an un-awaited
     * constructor cannot do that.
     *
     * With `storagePath`, the database is file-backed and reopening finds what was written.
     */
    static open(options: TypeDBLiteDatabaseOptions): Promise<TypeDBLiteDatabase>;
    /**
     * Apply a TypeQLite `define` block, and hand back what the engine reported: the same shape `execute` returns.
     * Idempotent for an unchanged schema.
     *
     * @privateRemarks
     * 🔴 The engine carries a fact it can only raise at construction ("Could not enable WAL", at Information
     * severity) to the FIRST report it produces, and for a store opener that report is this one: each applies its
     * schema before anything else. Dropping this report would mean the fact reaches nobody.
     */
    define(schema: string): Promise<WriteOutcome>;
    /**
     * Run a write, and hand back what the engine reported about it.
     *
     * A caller that wants the diagnostics reads them, and one that does not is unaffected. Anything that must **not**
     * be ignored is still a thrown error rather than a diagnostic.
     */
    execute(query: string): Promise<WriteOutcome>;
    /** Run a read (`match … select …`). */
    query(query: string): Promise<TypeDBLiteQueryResult>;
    /**
     * Run `work` atomically against this one store: it commits if `work` resolves and rolls back if it throws,
     * rethrowing the same error. A producer writes its state change and its event record in one step this way.
     *
     * The work receives a handle (`TypeDBLiteTransaction`); this database's own methods wait until the transaction
     * ends. Transactions on one handle run one at a time, in the order they were asked. No transaction spans stores:
     * a producer writes its state and its event record to its own store.
     *
     * @privateRemarks
     * ⚠️ The write lock is held for as long as `work` runs, across every `await` in it. Other processes wait up to the
     * engine's `busy_timeout` and then fail; keep the work to database writes. No timeout is enforced here.
     *
     * @throws TransactionsNotSupportedError when the engine has no transaction capability; `work` is not run.
     */
    transaction<T>(work: (transaction: TypeDBLiteTransaction) => Promise<T>): Promise<T>;
    /**
     * Run `operation` once no transaction is open.
     *
     * 🔴 `operation` is called in the same synchronous step as the last check. Waiting through a separate `async`
     * helper and *then* calling the engine left a microtask gap in which a queued transaction could take the flag and
     * `BEGIN`, and this call then wrote inside it, so a rollback silently undid an acknowledged write.
     */
    private whenNoTransaction;
    private refuseFromInsideTransaction;
    private executeOnEngine;
    /**
     * A no-op for TypeDBLite, which a caller may keep calling after a write.
     *
     * Each write pipeline commits as it runs, so there is nothing to flush. The call is still passed to the engine,
     * because another engine behind the port may need it.
     */
    persist(): Promise<void>;
    /** Release the store, once no transaction is open. */
    close(): Promise<void>;
}
/** How `openSchemaDatabase` opens a store. */
export interface OpenSchemaDatabaseOptions {
    /** Database name; also the filename beneath `storagePath`. */
    readonly name: string;
    /** Omit for an in-memory database. */
    readonly storagePath?: string;
    /** Override the default engine. */
    readonly engine?: EmbeddedDatabase;
    /**
     * Create `storagePath` first. The engine does not create a missing directory, and reports only "unable to open
     * database file", with no path in it. Off by default, so a caller that takes its directory from an engine it
     * already constructed, or leaves it to its own composition root, keeps that choice.
     */
    readonly ensureDirectory?: boolean;
}
/**
 * Open a schema'd store: open, create the directory if asked, apply the schema, and return the handle with the
 * schema's report. Every store opener would otherwise repeat this sequence by hand, and drop the report.
 */
export declare function openSchemaDatabase(options: OpenSchemaDatabaseOptions, schema: string): Promise<StoreOpenResult>;
/**
 * Whether `error` is a TypeDB uniqueness violation on `attribute`.
 *
 * @privateRemarks
 * 🔴 **`[CNT9]` alone is not enough.** It is emitted for *every* `@key` and `@unique` violation, so a detector
 * matching only on it would report an unrelated constraint (one added later, somewhere else in the schema) as a
 * duplicate, sending an operator after the wrong problem. The attribute name is what makes the match specific, so
 * it is required, not optional.
 */
export declare function isUniqueConstraintViolation(error: unknown, attribute: string): boolean;
//# sourceMappingURL=typedblite-database.d.ts.map