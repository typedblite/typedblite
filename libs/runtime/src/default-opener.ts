import type { SqliteOpener } from './sqlite-database.js';

/**
 * The interpreter's default opener everywhere but Node: there is no SQLite to default to
 * ([ADR-009](../../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D4).
 *
 * 🔴 It refuses rather than guessing. A browser that constructs `new TypeDBLiteInterpreter()` without
 * an opener is told what to pass, instead of failing later on a missing `node:sqlite`.
 */
export const defaultOpener: SqliteOpener = (location) => {
  throw new Error(
    `TypeDBLite has no default SQLite outside Node, so it cannot open '${location}'. ` +
      "Pass one: new TypeDBLiteInterpreter(location, undefined, { openDatabase: openWasmSqlite }), " +
      "with openWasmSqlite from '@typedblite/runtime/wasm'.",
  );
};
