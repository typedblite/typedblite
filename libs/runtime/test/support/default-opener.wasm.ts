/**
 * The interpreter's default opener when the runtime's own suite runs on WASM SQLite
 * (`vitest.wasm.config.ts` aliases `#default-opener` here). Not part of the package.
 */
export { openWasmSqlite as defaultOpener } from '../../src/wasm.js';
