import type {
  ChangeStreamOptions,
  ExecutionReport,
  ReplicationEvents,
  ReplicationOptions,
  ReplicationSession,
  TypeDBLiteOptions,
  TypeDBLiteReplicator,
  createChangeStreamHandler,
} from '@typedblite/runtime';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { installedRuntimeEntry } from './installed-runtime-entry.js';
import { moduleDirectoryFrom } from './module-directory.js';

/**
 * The engine package's exports that a host reaches for at run time.
 *
 * @privateRemarks
 * 🔴 **Option bags and results are the runtime's own types; only the change log is `unknown`.** A host holds its
 * change log as an opaque value (it gets it from its own store registry), so the log parameter stays `unknown`
 * rather than forcing every caller to import and cast to the runtime's `ChangeLog`. Everything else is taken from
 * the runtime, not redeclared, so a new option (such as `replicateOnce`'s `timeoutMs`) is visible here the day the
 * runtime adds it. `runtime-type.test.ts` fails to compile if the real module stops satisfying this shape.
 */
export interface TypeDbLiteRuntime {
  /** The default engine class: a store at `location`, or in memory. */
  readonly SqliteEngine: new (location?: string, options?: TypeDBLiteOptions) => EmbeddedDatabase;
  /** The replicator class, which syncs a change log with a hub. */
  readonly TypeDBLiteReplicator: new (
    log: unknown,
    hubUrl: string,
    pushIntervalMs?: number,
    headers?: () => Record<string, string> | Promise<Record<string, string>>,
  ) => {
    replicateOnce(options: ReplicationOptions): ReturnType<TypeDBLiteReplicator['replicateOnce']>;
    replicateContinuously(options: ReplicationOptions, events?: ReplicationEvents): ReplicationSession;
  };
  /** Builds the HTTP handler that serves a change log as a stream. */
  readonly createChangeStreamHandler: (
    log: unknown,
    options?: ChangeStreamOptions & { readonly path?: string },
  ) => ReturnType<typeof createChangeStreamHandler>;
}

/**
 * The directory of this module, for resolving the installed engine from it. The choice between `__dirname` and
 * `import.meta.url` is {@link moduleDirectoryFrom}'s, where it is tested.
 */
function thisModuleDirectory(): string {
  return moduleDirectoryFrom(() => __dirname, import.meta.url);
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
export async function loadTypeDbLiteRuntime(): Promise<TypeDbLiteRuntime> {
  type Runtime = TypeDbLiteRuntime;

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
  let runtime: Runtime;
  try {
    // 🔴 A **literal**, not `specifier`. Webpack cannot statically analyze a variable request and warns
    // "critical dependency: the request of a dependency is an expression", which also stops `webpackIgnore`
    // applying to it.
    runtime = (await import(/* webpackIgnore: true */ '@typedblite/runtime')) as unknown as Runtime;
    // 🔴 Webpack caches a partially-initialized module (an empty `{}`) when module-level initialization throws, as
    // `require` of an ESM-only dependency does in a CommonJS bundle. The error is swallowed by the cache and never
    // reaches here, so check the export and let the fallback run.
    if (!runtime.SqliteEngine) {
      throw new Error('webpack returned empty module for @typedblite/runtime');
    }
  } catch (nativeError) {
    try {
      // 🔴 Resolve the installed package from this module's directory, not from `process.cwd()`: a bare specifier
      // resolves from the cwd, which is whatever directory the host was started in. The engine is an ordinary
      // dependency, hoisted beside this package or nested under it, never vendored inside a bundle.
      const esmPath = pathToFileURL(installedRuntimeEntry(thisModuleDirectory())).href;
      runtime = await (new Function('p', 'return import(p);') as (p: string) => Promise<Runtime>)(esmPath);
      if (!runtime.SqliteEngine) {
        throw new Error('@typedblite/runtime loaded from the installed package but SqliteEngine is missing');
      }
    } catch (trickError) {
      // Both failed, so this is not the interop seam: carry both messages rather than reporting only the
      // fallback's, which is the second symptom rather than the cause.
      const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
      throw new Error(
        `Could not load ${specifier}. ` +
          `Native import: ${reason(nativeError)}. ` +
          `CommonJS fallback: ${reason(trickError)}.`,
      );
    }
  }

  return runtime;
}

async function loadSqliteEngine(): Promise<new (location?: string) => EmbeddedDatabase> {
  return (await loadTypeDbLiteRuntime()).SqliteEngine;
}

/**
 * A new engine at `location` (`:memory:` when omitted), for a composition root that needs to keep hold of it: to
 * reach its change log and replicate it.
 */
export async function createSqliteEngine(location?: string): Promise<EmbeddedDatabase> {
  const SqliteEngine = await loadSqliteEngine();
  return new SqliteEngine(location ?? ':memory:');
}

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
  /** The open database. */
  readonly database: TypeDBLiteDatabase;
  /** What applying the schema reported. */
  readonly report: WriteOutcome;
}

/** One result row. Values are read through the engine's concept wrappers (`asString`, `asInteger`, …). */
export interface TypeDBLiteRow {
  readonly [variable: string]: { asString?: () => string } | unknown;
}

/** What a read answered. */
export interface TypeDBLiteQueryResult {
  /** The matched rows. */
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
  query(query: string): Promise<{ rows: readonly TypeDBLiteRow[] }>;
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
export class TransactionsNotSupportedError extends Error {
  /** Names the database whose engine cannot run a transaction. */
  public constructor(databaseName: string) {
    super(
      `The engine behind '${databaseName}' does not support transactions, so the work was not run. ` +
        'It will not be run without atomicity.',
    );
    this.name = 'TransactionsNotSupportedError';
  }
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
export function rowString(row: TypeDBLiteRow, variable: string): string | null {
  const value = row[variable] as { asString?: () => string } | undefined;
  if (!value) return null;
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
export function rowNumber(row: TypeDBLiteRow, variable: string): number | null {
  const value = row[variable] as { asInteger?: () => number; asDouble?: () => number } | undefined;
  if (!value) return null;

  if (typeof value.asInteger === 'function') {
    try {
      return value.asInteger();
    } catch {
      // Not an integer attribute: fall through to double.
    }
  }
  if (typeof value.asDouble === 'function') return value.asDouble();
  return null;
}

/** Throws when the variable is absent or is not numeric. */
export function requiredRowNumber(row: TypeDBLiteRow, variable: string): number {
  const value = rowNumber(row, variable);
  if (value === null) {
    throw new Error(`Result row has no numeric variable '${variable}' — check the query's select clause`);
  }
  return value;
}

/** Throws when the variable is absent: a missing `select` is a bug, not an empty result. */
export function requiredRowString(row: TypeDBLiteRow, variable: string): string {
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
  /**
   * Set while a transaction is open. Every other method waits on it, and a second transaction queues behind it: one
   * handle is one SQLite connection, so an outsider's write during a transaction would otherwise land inside it.
   */
  private openTransaction: Promise<void> | null = null;

  /**
   * Marks the async context of a running transaction's work, so a call back into this database from inside it is
   * refused instead of waiting on the transaction it is part of (a deadlock). Each handle has its own storage, so a
   * different `TypeDBLiteDatabase` never sees this one's mark: no identity comparison is needed.
   */
  private readonly insideTransaction = new AsyncLocalStorage<{ ended: boolean }>();

  private constructor(
    private readonly database: EmbeddedDatabase,
    /** The database's name. */
    public readonly name: string,
    /**
     * Whether a `storagePath` was given: false for an in-memory database, where a snapshot has nowhere to go. With an
     * `engine` supplied it only repeats what the caller said, since this handle cannot see where that engine keeps its
     * data.
     */
    public readonly durable: boolean,
  ) {}

  /**
   * Open a database. Construct through `open`, not `new`: the engine is loaded asynchronously, and an un-awaited
   * constructor cannot do that.
   *
   * With `storagePath`, the database is file-backed and reopening finds what was written.
   */
  public static async open(options: TypeDBLiteDatabaseOptions): Promise<TypeDBLiteDatabase> {
    // 🔴 TypeDBLite is the default engine for the local path only. `engine` still accepts any implementation of the
    // port, so a TypeDB server adapter remains injectable.
    const SqliteEngine = options.engine ? undefined : await loadSqliteEngine();
    const engine =
      options.engine ??
      new SqliteEngine!(options.storagePath ? join(options.storagePath, `${options.name}.db`) : ':memory:');
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
  public async define(schema: string): Promise<WriteOutcome> {
    const report = (await this.whenNoTransaction(() => this.database.define(schema))) as
      | { diagnostics?: ExecutionReport['diagnostics'] }
      | undefined;
    return { diagnostics: report?.diagnostics ?? [] };
  }

  /**
   * Run a write, and hand back what the engine reported about it.
   *
   * A caller that wants the diagnostics reads them, and one that does not is unaffected. Anything that must **not**
   * be ignored is still a thrown error rather than a diagnostic.
   */
  public async execute(query: string): Promise<WriteOutcome> {
    return this.whenNoTransaction(() => this.executeOnEngine(query));
  }

  /** Run a read (`match … select …`). */
  public async query(query: string): Promise<TypeDBLiteQueryResult> {
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
  public async transaction<T>(work: (transaction: TypeDBLiteTransaction) => Promise<T>): Promise<T> {
    const engine = this.database;
    if (typeof engine.transaction !== 'function') {
      throw new TransactionsNotSupportedError(this.name);
    }
    this.refuseFromInsideTransaction('nested transactions are not supported; use the transaction handle');
    // 🔴 Inline, not through `whenNoTransaction()`: that helper runs an operation, and this one must set the flag
    // itself. A separate async helper yields once even when no transaction is open, so two calls in the same tick
    // both passed the check before either set the flag, and the second hit "already open". The check and the set
    // must have no `await` between them.
    while (this.openTransaction) await this.openTransaction;
    let release!: () => void;
    this.openTransaction = new Promise<void>((resolve) => {
      release = resolve;
    });
    const token = { ended: false };
    const stillOpen = (): void => {
      // The handle outlives the callback if the work leaks it; using it later would write outside this transaction,
      // or inside the next one.
      if (token.ended) {
        throw new Error(`The transaction has ended: its handle on '${this.name}' can no longer be used.`);
      }
    };
    try {
      return await engine.transaction(() =>
        this.insideTransaction.run(token, () =>
          work({
            execute: async (query) => {
              stillOpen();
              return this.executeOnEngine(query);
            },
            query: async (query) => {
              stillOpen();
              return engine.query(query);
            },
          }),
        ),
      );
    } finally {
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
  private async whenNoTransaction<T>(operation: () => Promise<T>): Promise<T> {
    this.refuseFromInsideTransaction('use the transaction handle');
    while (this.openTransaction) await this.openTransaction;
    return operation();
  }

  private refuseFromInsideTransaction(what: string): void {
    const store = this.insideTransaction.getStore();
    // A callback that outlives its transaction still carries the store; once the transaction ended it is an
    // ordinary caller again.
    if (store && !store.ended) {
      throw new Error(
        `Called '${this.name}' from inside a transaction on it: ${what}. ` +
          'The database waits for its transaction to end, so this would never return.',
      );
    }
  }

  private async executeOnEngine(query: string): Promise<WriteOutcome> {
    const report = (await this.database.execute(query)) as { diagnostics?: ExecutionReport['diagnostics'] } | undefined;
    return { diagnostics: report?.diagnostics ?? [] };
  }

  /**
   * A no-op for TypeDBLite, which a caller may keep calling after a write.
   *
   * Each write pipeline commits as it runs, so there is nothing to flush. The call is still passed to the engine,
   * because another engine behind the port may need it.
   */
  public async persist(): Promise<void> {
    await this.whenNoTransaction(() => this.database.persist());
  }

  /** Release the store, once no transaction is open. */
  public async close(): Promise<void> {
    await this.whenNoTransaction(() => this.database.close());
  }
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
 *
 * If the schema is refused, the error is rethrown. An engine this call created is closed first; an engine passed in
 * as `options.engine` is left open, because it belongs to the caller.
 *
 * @privateRemarks
 * The schema error is rethrown only once closing settles. An engine whose `close` never settles would hold it back;
 * that is the engine's bug, and is not raced with a timeout here.
 */
export async function openSchemaDatabase(options: OpenSchemaDatabaseOptions, schema: string): Promise<StoreOpenResult> {
  if (options.ensureDirectory && options.storagePath) {
    await mkdir(options.storagePath, { recursive: true });
  }
  const database = await TypeDBLiteDatabase.open({
    name: options.name,
    ...(options.storagePath ? { storagePath: options.storagePath } : {}),
    ...(options.engine ? { engine: options.engine } : {}),
  });
  // 🔴 On a refused schema, close the engine **only if this call created it**. The caller gets only the error, so
  // an engine made here would otherwise stay open until exit (for a file store, its connection and lock files), and
  // a host that retries would hold two. An engine the caller passed in is the caller's: closing it would break a
  // caller that keeps it and retries.
  // Falsy, not `=== undefined`: `open` creates an engine for any falsy `engine` (a `null` from untyped JavaScript
  // too), so ownership must follow the same test or that engine leaks.
  const ownsEngine = !options.engine;
  try {
    const report = await database.define(schema);
    return { database, report };
  } catch (error) {
    if (ownsEngine) await database.close().catch(() => undefined);
    throw error;
  }
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
export function isUniqueConstraintViolation(error: unknown, attribute: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("[CNT9] Constraint '@unique' has been violated") &&
    error.message.includes(`'${attribute}'`)
  );
}
