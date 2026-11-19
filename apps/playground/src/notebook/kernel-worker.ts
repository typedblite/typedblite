/// <reference lib="webworker" />
/**
 * The browser notebook's engine: TypeDBLite on WASM SQLite in a dedicated Web Worker, answering the kernel's operations
 * (`kernel-core.ts`). Nothing is stored and nothing leaves the page. It imports only the public packages (ADR-009).
 */
import '../polyfills.js';
import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';

import { createKernel, KernelError } from './kernel-core.js';
import type { KernelReply, KernelRequest } from './kernel-protocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (reply: KernelReply): void => scope.postMessage(reply);

// Relative to the worker, not the origin's root, so the page works from any path (a project site).
const ready = initWasmSqlite({ moduleOptions: { locateFile: (file: string) => new URL(file, scope.location.href).href } });
const kernel = createKernel({ openDatabase: openWasmSqlite });

scope.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const { id, operation, input } = event.data;
  try {
    await ready;
    send({ id, ok: true, data: await kernel.call(operation, input) });
  } catch (error) {
    send({ id, ok: false, code: error instanceof KernelError ? error.code : 'FAILED', message: error instanceof Error ? error.message : String(error) });
  }
};
