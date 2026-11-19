import { diagnosticOf, TypeDBLiteInterpreter, } from '@typedblite/runtime';
import { classifyStatement } from './classify.js';
/** Thrown by the accessors that return data, when the session is closed. A run returns a refusal instead. */
export class SessionClosedError extends Error {
    /** Always says the session is closed. */
    constructor() {
        super('The session is closed.');
        this.name = 'SessionClosedError';
    }
}
const NO_SCHEMA = 'no schema has been applied — run a `define` block first';
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
export class Session {
    location;
    options;
    interpreter;
    transaction = false;
    /**
     * Opens a store and an interpreter over it.
     *
     * @param location `:memory:`, or the path of a SQLite file.
     * @param options How the store is opened.
     * @throws when the file cannot be opened.
     */
    constructor(location = ':memory:', options = {}) {
        this.location = location;
        this.options = options;
        this.interpreter = this.open();
    }
    /** Whether the session has been closed, and so refuses every run. */
    get closed() {
        return this.interpreter === undefined;
    }
    /** `manual` while a transaction is open, `auto` otherwise. */
    get mode() {
        return this.transaction ? 'manual' : 'auto';
    }
    /** Whether a schema has been applied. Asked of the engine, so a reopened file already knows. */
    get hasSchema() {
        return this.interpreter?.hasSchema ?? false;
    }
    /** The schema applied to this store, as sorted lists. */
    schema() {
        return this.live().schemaSnapshot();
    }
    /** Run one statement. */
    async run(source) {
        const interpreter = this.interpreter;
        if (!interpreter)
            return refused('closed', 'The session is closed.');
        const kind = classifyStatement(source);
        if (kind === 'empty')
            return { kind: 'ok', statement: 'write', rows: [], diagnostics: [] };
        // 🔴 Without this, a statement run before any `define` fails with SQLite's own `no such table: thing` —
        // an internal leaking through as if it were a TypeQLite error.
        if (!interpreter.hasSchema && kind !== 'define')
            return refused('no-schema', NO_SCHEMA);
        const text = source.trim();
        try {
            if (kind === 'define') {
                const report = interpreter.define(text);
                return { kind: 'ok', statement: 'define', rows: [], diagnostics: report.diagnostics };
            }
            if (kind === 'read') {
                const answer = interpreter.query(text);
                return { kind: 'rows', rows: answer.rows.map(render), ...documentsOf(answer.documents), diagnostics: answer.diagnostics };
            }
            const report = interpreter.execute(text);
            return { kind: 'ok', statement: 'write', rows: report.rows.map(render), ...documentsOf(report.documents), diagnostics: report.diagnostics };
        }
        catch (error) {
            return refusalOf(error);
        }
    }
    /** Open a transaction. Statements join it until `commit` or `rollback`. */
    async begin() {
        const interpreter = this.interpreter;
        if (!interpreter)
            return refused('closed', 'The session is closed.');
        if (this.transaction)
            return refused('transaction', 'A transaction is already open on this session.');
        try {
            interpreter.beginTransaction();
            this.transaction = true;
            return { kind: 'ok' };
        }
        catch (error) {
            return refusalOf(error);
        }
    }
    /**
     * Make the transaction's writes permanent. TypeDB's commit checks run here, and a commit that fails rolls the
     * whole transaction back and says why: the session is back in `auto` either way.
     */
    async commit() {
        const interpreter = this.interpreter;
        if (!interpreter)
            return refused('closed', 'The session is closed.');
        if (!this.transaction)
            return refused('transaction', 'No transaction is open on this session.');
        try {
            interpreter.commitTransaction();
            return { kind: 'ok' };
        }
        catch (error) {
            return refusalOf(error);
        }
        finally {
            this.transaction = false;
        }
    }
    /** Discard the transaction's writes. */
    async rollback() {
        const interpreter = this.interpreter;
        if (!interpreter)
            return refused('closed', 'The session is closed.');
        if (!this.transaction)
            return refused('transaction', 'No transaction is open on this session.');
        interpreter.rollbackTransaction();
        this.transaction = false;
        return { kind: 'ok' };
    }
    /**
     * Close the store and open it again from the same location, in `auto` mode. An open transaction is rolled back.
     * A `:memory:` store comes back empty, with no schema. A file comes back as it was last committed: the data is
     * the file, not the session.
     */
    async restart() {
        if (!this.interpreter)
            return refused('closed', 'The session is closed.');
        this.release();
        try {
            this.interpreter = this.open();
            return { kind: 'ok' };
        }
        catch (error) {
            // The file could not be reopened (another connection holds it). The session is closed, and says so.
            return refusalOf(error);
        }
    }
    /** Release the store. Any transaction still open is rolled back. A closed session refuses every run. */
    async close() {
        this.release();
    }
    open() {
        return new TypeDBLiteInterpreter(this.location, this.options.busyTimeoutMs ?? 5000);
    }
    release() {
        const interpreter = this.interpreter;
        this.interpreter = undefined;
        if (!interpreter)
            return;
        if (this.transaction)
            interpreter.rollbackTransaction();
        this.transaction = false;
        interpreter.close();
    }
    live() {
        if (!this.interpreter)
            throw new SessionClosedError();
        return this.interpreter;
    }
}
function refused(reason, message) {
    return { kind: 'refused', reason, message, diagnostics: [] };
}
/** The engine's own message, and its diagnostic when it attached one. A lock is named as one. */
function refusalOf(error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = diagnosticOf(error);
    const reason = /database is locked|SQLITE_BUSY/i.test(message) ? 'locked' : 'engine';
    return { kind: 'refused', reason, message, diagnostics: diagnostic ? [diagnostic] : [] };
}
function documentsOf(documents) {
    return documents === undefined ? {} : { documents };
}
/** Result cells arrive as concepts; the shells want plain strings. `toString()` is the one rendering every kind has. */
function render(row) {
    const out = {};
    for (const [variable, value] of Object.entries(row))
        out[variable] = String(value);
    return out;
}
//# sourceMappingURL=session.js.map