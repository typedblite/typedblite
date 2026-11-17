import { DatabaseSync } from 'node:sqlite';
import type { SqliteDatabase, SqliteOpener } from './sqlite-database.js';

/**
 * The default binding: `node:sqlite`.
 *
 * @privateRemarks
 * 🔴 The only file in this package that imports `node:sqlite`. Keeping it that way is what lets a
 * browser bundle include the interpreter without pulling in a Node built-in; do not import
 * `node:sqlite` from anywhere else in `src/`.
 */
export const openNodeSqlite: SqliteOpener = (location: string): SqliteDatabase => new DatabaseSync(location);
