/// <reference lib="webworker" />
/**
 * The hub, in a dedicated Worker: a TypeDBLite store on WASM SQLite in OPFS, served to every connected port by
 * `hub-core.ts`. The page that owns it kills it with `worker.terminate()`: memory is gone, OPFS stays.
 *
 * 🔴 A dedicated Worker, not a SharedWorker. Chromium exposes no synchronous OPFS handles in a SharedWorker (the
 * store would not open: "Missing required OPFS APIs") and no `Worker` constructor there, so a SharedWorker cannot
 * hold the store, nor delegate to a worker that can. So one page owns the hub, and hands every device a port.
 * `?fresh` wipes the store before opening it.
 *
 * Excluded from the unit coverage floor, because it needs a browser; `test-browser/browser-hub.test.ts` runs it.
 */
import '../client/polyfills.js';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite, wipeOpfsPool } from '@typedblite/runtime/wasm';

import { SCHEMA } from '../shared/schema.js';
import { createHubCore, serveHubPort, type HubCore, type HubPortState } from './hub-core.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const RETRY_MS = 250;
const MAX_ATTEMPTS = 40;

let status: HubPortState = { state: 'opening', openError: '', openedAt: '', openAttempts: 0 };
let peers = 0;

/** Another page or a worker just killed still holds the store's handles for a moment. Anything else is final. */
const heldElsewhere = (error: unknown): boolean => error instanceof Error && (error.name === 'NoModificationAllowedError' || /access handle/i.test(error.message));

async function open(): Promise<HubCore> {
  const fresh = new URL(scope.location.href).searchParams.has('fresh');
  for (;;) {
    status = { ...status, openAttempts: status.openAttempts + 1 };
    try {
      await initWasmSqlite({
        moduleOptions: { locateFile: (file: string) => new URL(file, scope.location.href).href },
        sahPool: { name: 'typedblite-browser-hub', directory: '/typedblite-browser-hub' },
      });
      if (fresh) await wipeOpfsPool();
      const db = new TypeDBLiteInterpreter('/hub.db', undefined, { openDatabase: openWasmSqlite });
      db.define(SCHEMA);
      status = { ...status, state: 'open', openError: '', openedAt: new Date().toISOString() };
      return createHubCore(db, { onError: (error) => console.error('hub: a push could not be applied', error) });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (!heldElsewhere(error) || status.openAttempts >= MAX_ATTEMPTS) {
        status = { ...status, state: 'failed', openError: message };
        throw error;
      }
      status = { ...status, openError: message };
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

const ready = open();
ready.catch(() => undefined); // reported through `status`; serveHubPort answers 503 for it

/** The page hands over one MessagePort per peer: its own panel, and each device's engine. */
scope.onmessage = (event: MessageEvent<{ type: string }>) => {
  const port = event.ports[0];
  if (event.data.type !== 'connect' || !port) return;
  peers++;
  serveHubPort(port, ready, () => status, () => peers);
};
