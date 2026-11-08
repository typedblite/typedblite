import { initWasmSqlite } from './wasm-sqlite.js';

// The WASM module initialises asynchronously; every test file waits for it here, once, so the
// synchronous opener the interpreter calls is ready before any engine is constructed.
await initWasmSqlite();
