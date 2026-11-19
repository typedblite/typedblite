import { type ExecutionReport, type JsonValue, type TypeDBLiteSchemaSnapshot } from '@typedblite/runtime';
/** The diagnostics of a run: its execution facts (ADR-004), and the diagnostic of a refusal. */
export type Diagnostics = ExecutionReport['diagnostics'];
/**
 * Why a session refused. A caller branches on this, never on message text.
 *
 * - `engine`: TypeQLite itself refused the statement. `message` is the engine's own.
 * - `no-schema`: a statement other than a `define` ran before any schema was applied.
 * - `locked`: another connection holds the file's write lock (SQLite arbitrates two sessions on one file).
 * - `closed`: the session was closed.
 * - `transaction`: a `begin` inside a transaction, or a `commit` or `rollback` with none open.
 */
export type RefusalReason = 'engine' | 'no-schema' | 'locked' | 'closed' | 'transaction';
/** One answer row, every cell rendered as the engine's own `toString()` of its concept or value. */
export type Row = Readonly<Record<string, string>>;
/**
 * What a statement answered. Returned, never thrown: a session that dies on a typo is unusable.
 *
 * `rows` and `documents` are what a read or a write pipeline answers (`documents` when it ends in `fetch`).
 */
export type RunResult = {
    readonly kind: 'rows';
    readonly rows: readonly Row[];
    readonly documents?: readonly JsonValue[];
    readonly diagnostics: Diagnostics;
} | {
    readonly kind: 'ok';
    readonly statement: 'define' | 'write';
    readonly rows: readonly Row[];
    readonly documents?: readonly JsonValue[];
    readonly diagnostics: Diagnostics;
} | {
    readonly kind: 'refused';
    readonly reason: RefusalReason;
    readonly message: string;
    readonly diagnostics: Diagnostics;
};
/** What `begin`, `commit` and `rollback` answered. */
export type ControlResult = {
    readonly kind: 'ok';
} | {
    readonly kind: 'refused';
    readonly reason: RefusalReason;
    readonly message: string;
};
/**
 * `auto`: each statement is a transaction of its own, and commits when it succeeds. `manual`: a `begin` is open,
 * statements join it, and nothing is permanent until `commit`.
 */
export type SessionMode = 'auto' | 'manual';
/** How a session opens its store. */
export interface SessionOptions {
    /** How long a write waits for another connection's lock before it is refused as `locked`. Default 5000. */
    readonly busyTimeoutMs?: number;
}
/** Thrown by the accessors that return data, when the session is closed. A run returns a refusal instead. */
export declare class SessionClosedError extends Error {
    /** Always says the session is closed. */
    constructor();
}
/**
 * One open store with a lifetime: a location, a run, manual transactions, a restart and a close.
 *
 * Each session opens its own interpreter, so two sessions never share a store handle, even on one file. What two
 * sessions on one file may do is SQLite's to arbitrate: a writer waits for the other's lock and is then refused
 * as `locked`. The statement is run by the interpreter, and only by it.
 *
 * @privateRemarks
 * 🔴 A session owns its store (feature invariant 4), and nothing here writes SQL (invariant 1).
 */
export declare class Session {
    readonly location: string;
    private readonly options;
    private interpreter;
    private transaction;
    /**
     * Opens a store and an interpreter over it.
     *
     * @param location `:memory:`, or the path of a SQLite file.
     * @param options How the store is opened.
     * @throws when the file cannot be opened.
     */
    constructor(location?: string, options?: SessionOptions);
    /** Whether the session has been closed, and so refuses every run. */
    get closed(): boolean;
    /** `manual` while a transaction is open, `auto` otherwise. */
    get mode(): SessionMode;
    /** Whether a schema has been applied. Asked of the engine, so a reopened file already knows. */
    get hasSchema(): boolean;
    /** The schema applied to this store, as sorted lists. */
    schema(): TypeDBLiteSchemaSnapshot;
    /** Run one statement. */
    run(source: string): Promise<RunResult>;
    /** Open a transaction. Statements join it until `commit` or `rollback`. */
    begin(): Promise<ControlResult>;
    /**
     * Make the transaction's writes permanent. TypeDB's commit checks run here, and a commit that fails rolls the
     * whole transaction back and says why: the session is back in `auto` either way.
     */
    commit(): Promise<ControlResult>;
    /** Discard the transaction's writes. */
    rollback(): Promise<ControlResult>;
    /**
     * Close the store and open it again from the same location, in `auto` mode. An open transaction is rolled back.
     * A `:memory:` store comes back empty, with no schema. A file comes back as it was last committed: the data is
     * the file, not the session.
     */
    restart(): Promise<ControlResult>;
    /** Release the store. Any transaction still open is rolled back. A closed session refuses every run. */
    close(): Promise<void>;
    private open;
    private release;
    private live;
}
//# sourceMappingURL=session.d.ts.map