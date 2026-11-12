/// <reference lib="webworker" />
/**
 * One device's engine, in a dedicated Web Worker: TypeDBLite on WASM SQLite, its store in OPFS, and a
 * sync with the hub every 1.5 s through this device's line on the switchboard.
 *
 * It imports only the public packages — `@typedblite/runtime` (the browser entry, chosen by the
 * bundler's `browser` condition) and `@typedblite/runtime/wasm` — and the demo's own `DemoDevice`,
 * the same class the headless smoke run uses on `node:sqlite`.
 */
import './polyfills.js';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite, wipeOpfsPool } from '@typedblite/runtime/wasm';

import { DemoDevice, type DeviceState } from '../shared/device.js';
import type { FromWorker, ToWorker } from './protocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const SYNC_EVERY_MS = 1_500;

let device: DemoDevice | undefined;
let syncing = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const send = (message: FromWorker): void => scope.postMessage(message);

function publish(synced: readonly string[] = []): void {
  if (device) send({ type: 'state', syncing, synced, ...device.state() });
}

async function open(name: string, cursor: DeviceState['cursor'] | undefined, fresh: boolean): Promise<void> {
  await initWasmSqlite({
    moduleOptions: { locateFile: (file: string) => `/${file}` },
    // One pool per device name: the Electron window and a browser tab on one origin stay apart.
    sahPool: { name: `typedblite-demo-${name}`, directory: `/typedblite-demo-${name}` },
  });
  if (fresh) await wipeOpfsPool();
  const db = new TypeDBLiteInterpreter('/tasks.db', undefined, { openDatabase: openWasmSqlite });
  device = new DemoDevice(name, db, `${scope.location.origin}/net/${name}/hub`, { cursor: fresh ? {} : cursor, timeoutMs: 8_000 });
  publish();
  void tick();
}

async function syncNow(): Promise<void> {
  if (!device || syncing) return;
  syncing = true;
  publish();
  const fingerprint = (tasks: ReturnType<DemoDevice['tasks']>) => new Map(tasks.map((task) => [task.id, `${task.title}\u0000${task.done}`]));
  const before = fingerprint(device.tasks());
  const applied = await device.syncOnce();
  syncing = false;
  // Tasks this sync brought in or changed, for the page to highlight. A local edit is published when
  // it is made, so it is already in `before` and does not flash.
  const synced = applied ? [...fingerprint(device.tasks())].filter(([id, print]) => before.get(id) !== print).map(([id]) => id) : [];
  publish(synced);
}

/**
 * One sync loop, however many writes ask for a sync: a tick that arrives mid-sync is remembered and
 * run straight after, and only one timer is ever pending.
 */
async function tick(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (syncing) {
    again = true;
    return;
  }
  await syncNow();
  if (again) {
    again = false;
    return tick();
  }
  timer = setTimeout(() => void tick(), SYNC_EVERY_MS);
}

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    if (message.type === 'open') return await open(message.device, message.cursor, message.fresh === true);
    if (!device) throw new Error('The store is not open yet.');
    if (message.type === 'add') device.addTask(message.title);
    if (message.type === 'toggle') device.setDone(message.id, message.done);
    publish();
    if (message.type === 'sync' || message.type === 'add' || message.type === 'toggle') {
      // A local write syncs at once rather than waiting for the next tick.
      void tick();
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
