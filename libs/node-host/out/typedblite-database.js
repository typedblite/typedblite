import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installedRuntimeEntry } from './installed-runtime-entry.js';
/**
 * The directory of this module, for resolving the installed engine from it.
 *
 * @privateRemarks
 * 🔴 `__dirname` first, when there is one. A bundler that inlines this module into a CommonJS bundle provides the
 * bundle's directory there, which is where the installed engine is found; it also rewrites `import.meta.url` to the
 * path of the source it bundled from (a build machine's path) or to nothing. Natively, as ESM, there is no
 * `__dirname`, and `typeof` reads it without a `ReferenceError`.
 */
function thisModuleDirectory() {
    return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
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
export async function loadTypeDbLiteRuntime() {
    // 🔴 **Two loaders, and the fallback's trick is only right for one of them.**
    //
    // A host's build can rewrite a plain `import()` into a `require` (TypeScript compiling to CommonJS, a bundler
    // emitting CommonJS), and `require` of the ESM-only engine can fail. Hiding the import inside `new Function`
    // survives that rewrite.
    //
    // 🔴 Under a **module runner with no dynamic-import callback** (Vitest's), the trick is the thing that breaks: a
    // function built by `new Function` has no dynamic-import callback there, and every database open fails with
    // "A dynamic import callback was not specified".
    //
    // 🔴 **Try the real import, and fall back; do not try to detect the world.** The obvious test,
    // `typeof require === 'undefined'`, is wrong: Vitest's module runner provides a `require` shim, so ESM would take
    // the CommonJS branch. Attempting the import *is* the test, because the thing being detected is whether a build
    // rewrote it.
    const specifier = '@typedblite/runtime';
    let runtime;
    try {
        // 🔴 A **literal**, not `specifier`. Webpack cannot statically analyze a variable request and warns
        // "critical dependency: the request of a dependency is an expression", which also stops `webpackIgnore`
        // applying to it.
        runtime = (await import(/* webpackIgnore: true */ '@typedblite/runtime'));
        // 🔴 Webpack caches a partially-initialized module (an empty `{}`) when module-level initialization throws, as
        // `require` of an ESM-only dependency does in a CommonJS bundle. The error is swallowed by the cache and never
        // reaches here, so check the export and let the fallback run.
        if (!runtime.SqliteEngine) {
            throw new Error('webpack returned empty module for @typedblite/runtime');
        }
    }
    catch (nativeError) {
        try {
            // 🔴 Resolve the installed package from this module's directory, not from `process.cwd()`: a bare specifier
            // resolves from the cwd, which is whatever directory the host was started in. The engine is an ordinary
            // dependency, hoisted beside this package or nested under it, never vendored inside a bundle.
            const esmPath = pathToFileURL(installedRuntimeEntry(thisModuleDirectory())).href;
            runtime = await new Function('p', 'return import(p);')(esmPath);
            if (!runtime.SqliteEngine) {
                throw new Error('@typedblite/runtime loaded from the installed package but SqliteEngine is missing');
            }
        }
        catch (trickError) {
            // Both failed, so this is not the interop seam: carry both messages rather than reporting only the
            // fallback's, which is the second symptom rather than the cause.
            const reason = (error) => (error instanceof Error ? error.message : String(error));
            throw new Error(`Could not load ${specifier}. ` +
                `Native import: ${reason(nativeError)}. ` +
                `CommonJS fallback: ${reason(trickError)}.`);
        }
    }
    return runtime;
}
async function loadSqliteEngine() {
    return (await loadTypeDbLiteRuntime()).SqliteEngine;
}
/**
 * A new engine at `location` (`:memory:` when omitted), for a composition root that needs to keep hold of it: to
 * reach its change log and replicate it.
 */
export async function createSqliteEngine(location) {
    const SqliteEngine = await loadSqliteEngine();
    return new SqliteEngine(location ?? ':memory:');
}
/** The refusal: this database's engine has no transaction, and the work was not run. */
export class TransactionsNotSupportedError extends Error {
    /** Names the database whose engine cannot run a transaction. */
    constructor(databaseName) {
        super(`The engine behind '${databaseName}' does not support transactions, so the work was not run. ` +
            'It will not be run without atomicity.');
        this.name = 'TransactionsNotSupportedError';
    }
}
/**
 * Read a string attribute out of a result row.
 *
 * The engine wraps values, so `row.x` is not the string; `asString()` is. Centralized here because every repository
 * would otherwise reinvent it, and get the `undefined` case wrong.
 */
export function rowString(row, variable) {
    const value = row[variable];
    if (!value)
        return null;
    return typeof value.asString === 'function' ? value.asString() : String(value);
}
/**
 * Read a numeric attribute out of a result row.
 *
 * `asInteger` is tried before `asDouble` so a whole number does not come back as a float.
 *
 * @privateRemarks
 * 🔴 `rowString` cannot do this. The engine's `asString()` **throws** `Cannot extract string from
 * attribute(integer)` rather than coercing, so a numeric attribute needs its own reader.
 */
export function rowNumber(row, variable) {
    const value = row[variable];
    if (!value)
        return null;
    if (typeof value.asInteger === 'function') {
        try {
            return value.asInteger();
        }
        catch {
            // Not an integer attribute: fall through to double.
        }
    }
    if (typeof value.asDouble === 'function')
        return value.asDouble();
    return null;
}
/** Throws when the variable is absent or is not numeric. */
export function requiredRowNumber(row, variable) {
    const value = rowNumber(row, variable);
    if (value === null) {
        throw new Error(`Result row has no numeric variable '${variable}' — check the query's select clause`);
    }
    return value;
}
/** Throws when the variable is absent: a missing `select` is a bug, not an empty result. */
export function requiredRowString(row, variable) {
    const value = rowString(row, variable);
    if (value === null) {
        throw new Error(`Result row has no variable '${variable}' — check the query's select clause`);
    }
    return value;
}
/**
 * A handle on one TypeDBLite store, reached through TypeQLite.
 *
 * @privateRemarks
 * 🔴 **Deliberately not a document-shaped, per-document CRUD interface.** Forcing TypeQLite through one would
 * produce a lowest-common-denominator interface serving neither kind of store. A TypeQL store is reached through
 * TypeQLite, which is the point of choosing it.
 */
export class TypeDBLiteDatabase {
    database;
    name;
    durable;
    /**
     * Set while a transaction is open. Every other method waits on it, and a second transaction queues behind it: one
     * handle is one SQLite connection, so an outsider's write during a transaction would otherwise land inside it.
     */
    openTransaction = null;
    /**
     * Marks the async context of a running transaction's work, so a call back into this database from inside it is
     * refused instead of waiting on the transaction it is part of (a deadlock). Compared by identity: a different
     * `TypeDBLiteDatabase` is not inside this one's transaction.
     */
    insideTransaction = new AsyncLocalStorage();
    constructor(database, 
    /** The database's name. */
    name, 
    /** False for an in-memory database, where a snapshot has nowhere to go. */
    durable) {
        this.database = database;
        this.name = name;
        this.durable = durable;
    }
    /**
     * Open a database. Construct through `open`, not `new`: the engine is loaded asynchronously, and an un-awaited
     * constructor cannot do that.
     *
     * With `storagePath`, the database is file-backed and reopening finds what was written.
     */
    static async open(options) {
        // 🔴 TypeDBLite is the default engine for the local path only. `engine` still accepts any implementation of the
        // port, so a TypeDB server adapter remains injectable.
        const SqliteEngine = options.engine ? undefined : await loadSqliteEngine();
        const engine = options.engine ??
            new SqliteEngine(options.storagePath ? join(options.storagePath, `${options.name}.db`) : ':memory:');
        return new TypeDBLiteDatabase(engine, options.name, Boolean(options.storagePath));
    }
    /**
     * Apply a TypeQLite `define` block, and hand back what the engine reported: the same shape `execute` returns.
     * Idempotent for an unchanged schema.
     *
     * @privateRemarks
     * 🔴 The engine carries a fact it can only raise at construction ("Could not enable WAL", at Information
     * severity) to the FIRST report it produces, and for a store opener that report is this one: each applies its
     * schema before anything else. Dropping this report would mean the fact reaches nobody.
     */
    async define(schema) {
        const report = (await this.whenNoTransaction(() => this.database.define(schema)));
        return { diagnostics: report?.diagnostics ?? [] };
    }
    /**
     * Run a write, and hand back what the engine reported about it.
     *
     * A caller that wants the diagnostics reads them, and one that does not is unaffected. Anything that must **not**
     * be ignored is still a thrown error rather than a diagnostic.
     */
    async execute(query) {
        return this.whenNoTransaction(() => this.executeOnEngine(query));
    }
    /** Run a read (`match … select …`). */
    async query(query) {
        return this.whenNoTransaction(() => this.database.query(query));
    }
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
    async transaction(work) {
        const engine = this.database;
        if (typeof engine.transaction !== 'function') {
            throw new TransactionsNotSupportedError(this.name);
        }
        this.refuseFromInsideTransaction('nested transactions are not supported; use the transaction handle');
        // 🔴 Inline, not through `whenNoTransaction()`: that helper runs an operation, and this one must set the flag
        // itself. A separate async helper yields once even when no transaction is open, so two calls in the same tick
        // both passed the check before either set the flag, and the second hit "already open". The check and the set
        // must have no `await` between them.
        while (this.openTransaction)
            await this.openTransaction;
        let release;
        this.openTransaction = new Promise((resolve) => {
            release = resolve;
        });
        const token = { database: this, ended: false };
        const stillOpen = () => {
            // The handle outlives the callback if the work leaks it; using it later would write outside this transaction,
            // or inside the next one.
            if (token.ended) {
                throw new Error(`The transaction has ended: its handle on '${this.name}' can no longer be used.`);
            }
        };
        try {
            return await engine.transaction(() => this.insideTransaction.run(token, () => work({
                execute: async (query) => {
                    stillOpen();
                    return this.executeOnEngine(query);
                },
                query: async (query) => {
                    stillOpen();
                    return engine.query(query);
                },
            })));
        }
        finally {
            token.ended = true;
            this.openTransaction = null;
            release();
        }
    }
    /**
     * Run `operation` once no transaction is open.
     *
     * 🔴 `operation` is called in the same synchronous step as the last check. Waiting through a separate `async`
     * helper and *then* calling the engine left a microtask gap in which a queued transaction could take the flag and
     * `BEGIN`, and this call then wrote inside it, so a rollback silently undid an acknowledged write.
     */
    async whenNoTransaction(operation) {
        this.refuseFromInsideTransaction('use the transaction handle');
        while (this.openTransaction)
            await this.openTransaction;
        return operation();
    }
    refuseFromInsideTransaction(what) {
        const store = this.insideTransaction.getStore();
        // A callback that outlives its transaction still carries the store; once the transaction ended it is an
        // ordinary caller again.
        if (store?.database === this && !store.ended) {
            throw new Error(`Called '${this.name}' from inside a transaction on it: ${what}. ` +
                'The database waits for its transaction to end, so this would never return.');
        }
    }
    async executeOnEngine(query) {
        const report = (await this.database.execute(query));
        return { diagnostics: report?.diagnostics ?? [] };
    }
    /**
     * A no-op for TypeDBLite, which a caller may keep calling after a write.
     *
     * Each write pipeline commits as it runs, so there is nothing to flush. The call is still passed to the engine,
     * because another engine behind the port may need it.
     */
    async persist() {
        await this.whenNoTransaction(() => this.database.persist());
    }
    /** Release the store, once no transaction is open. */
    async close() {
        await this.whenNoTransaction(() => this.database.close());
    }
}
/**
 * Open a schema'd store: open, create the directory if asked, apply the schema, and return the handle with the
 * schema's report. Every store opener would otherwise repeat this sequence by hand, and drop the report.
 */
export async function openSchemaDatabase(options, schema) {
    if (options.ensureDirectory && options.storagePath) {
        await mkdir(options.storagePath, { recursive: true });
    }
    const database = await TypeDBLiteDatabase.open({
        name: options.name,
        ...(options.storagePath ? { storagePath: options.storagePath } : {}),
        ...(options.engine ? { engine: options.engine } : {}),
    });
    const report = await database.define(schema);
    return { database, report };
}
/**
 * Whether `error` is a TypeDB uniqueness violation on `attribute`.
 *
 * @privateRemarks
 * 🔴 **`[CNT9]` alone is not enough.** It is emitted for *every* `@key` and `@unique` violation, so a detector
 * matching only on it would report an unrelated constraint (one added later, somewhere else in the schema) as a
 * duplicate, sending an operator after the wrong problem. The attribute name is what makes the match specific, so
 * it is required, not optional.
 */
export function isUniqueConstraintViolation(error, attribute) {
    if (!(error instanceof Error))
        return false;
    return (error.message.includes("[CNT9] Constraint '@unique' has been violated") &&
        error.message.includes(`'${attribute}'`));
}
//# sourceMappingURL=typedblite-database.js.map