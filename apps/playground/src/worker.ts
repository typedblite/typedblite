/// <reference lib="webworker" />
/**
 * The playground's engine: TypeDBLite on WASM SQLite, in a dedicated Web Worker.
 *
 * Each run opens a fresh in-memory database and closes it, so a run never sees an earlier one, and a
 * shared link always reproduces what its sender saw. Nothing is stored and nothing leaves the page.
 * It imports only the public packages (ADR-009).
 */
import './polyfills.js';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';

import type { FromWorker, ToWorker } from './protocol.js';
import { runProgram } from './run.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: FromWorker): void => scope.postMessage(message);

// Relative to the worker, not the origin's root, so the page works from any path (a project site).
const ready = initWasmSqlite({ moduleOptions: { locateFile: (file: string) => new URL(file, scope.location.href).href } });

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const { id, source } = event.data;
  try {
    await ready;
    const result = runProgram(source, () => new TypeDBLiteInterpreter(':memory:', undefined, { openDatabase: openWasmSqlite }));
    send({ type: 'result', id, result });
  } catch (error) {
    send({ type: 'fatal', id, message: error instanceof Error ? error.message : String(error) });
  }
};
