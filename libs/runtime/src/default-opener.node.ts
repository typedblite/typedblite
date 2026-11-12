/**
 * The interpreter's default opener under the `node` condition: `node:sqlite`
 * ([ADR-009](../../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D4).
 * Selected by the `#default-opener` import in this package's `package.json`.
 */
export { openNodeSqlite as defaultOpener } from './node-sqlite.js';
