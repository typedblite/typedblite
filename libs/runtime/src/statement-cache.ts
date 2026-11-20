import type { SqliteDatabase, SqliteStatement } from './sqlite-database.js';

/**
 * The connection with `prepare()` memoised by SQL text, least recently used first out.
 *
 * 🔴 **The engine prepares inline, at ~250 call sites, and calls them per row.** `readAttributes`
 * alone prepares once per owner per `has $x` binding: listing 7,000 observations with six
 * bindings prepared 42,000 statements, and preparing cost more than running them. Caching here, in
 * one place, makes every call site's `db.prepare(sql)` a map lookup without touching any of them —
 * 2.8× on that listing and ~1.9× on a keyed read (docs/development/performance.md).
 *
 * Safe to share a statement because the `SqliteStatement` contract is `get`/`all`/`run` only — each
 * completes and resets the statement (`node:sqlite` resets on return), so nothing is left stepping,
 * and no caller can change a statement's settings for the next one. A statement whose table a later
 * DDL changed is re-prepared by SQLite itself on its next use.
 *
 * A binding that prepares lazily (the WASM one prepares and finalizes per call, `wasm.ts`) loses
 * nothing here: it caches the wrapper, which is cheap either way.
 */
export function cachingStatements(db: SqliteDatabase, capacity = 512): SqliteDatabase {
  const cache = new Map<string, SqliteStatement>();
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string): SqliteStatement => {
          const cached = cache.get(sql);
          if (cached !== undefined) {
            // Re-inserting moves it to the back: Map iteration order is the LRU order.
            cache.delete(sql);
            cache.set(sql, cached);
            return cached;
          }
          const statement = target.prepare(sql);
          cache.set(sql, statement);
          if (cache.size > capacity) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          return statement;
        };
      }
      if (property === 'close') {
        return (): void => {
          cache.clear();
          target.close();
        };
      }
      // `isTransaction` is a getter on `node:sqlite`'s DatabaseSync: read it from the target.
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
