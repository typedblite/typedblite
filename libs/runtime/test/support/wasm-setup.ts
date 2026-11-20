import { initWasmSqlite } from '../../src/wasm.js';

// The WASM module initializes asynchronously. Every test file waits for it here, once, so the
// synchronous opener the interpreter calls is ready before any engine is constructed.
await initWasmSqlite();
