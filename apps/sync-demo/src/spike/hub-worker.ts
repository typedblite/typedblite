/// <reference lib="webworker" />
/**
 * The hub, in a dedicated Worker (a SharedWorker cannot hold the store: Chromium exposes no synchronous OPFS handles there, and no nested Worker): a TypeDBLite store on WASM SQLite in OPFS, and TypeDBLite's change
 * stream (SSE out, POST in) served to every connected page over MessagePorts.
 *
 * It is `apps/sync-demo/src/hub/main.ts` with `node:http` swapped for a message wire. Nothing else
 * changes: the same store, the same schema, the same bearer token, the same 200 ms poll.
 *
 * The page kills it with `worker.terminate()`: memory is gone, OPFS stays.
 */
import '../client/polyfills.js';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';

import { DEMO_TOKEN } from '../shared/device.js';
import { SCHEMA, readTasks } from '../shared/schema.js';
import type { FromHub, HubInfo, HubRequest, ToHub } from './wire.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const POLL_MS = 200;
const json = { 'content-type': 'application/json', 'cache-control': 'no-store' };

let openAttempts = 0;
let lastOpenError = '';
let requests = 0;
let openedAt = '';
const peers = new Set<MessagePort>();
const streams = new Map<string, () => void>(); // `${peer}:${id}` → stop

/**
 * Opening can lose a race with the previous hub: `terminate()` releases OPFS's sync access handles a
 * moment after the worker is gone, so a hub restarted at once sees NoModificationAllowedError.
 */
async function open(): Promise<TypeDBLiteInterpreter> {
  for (;;) {
    openAttempts++;
    try {
      await initWasmSqlite({
        moduleOptions: { locateFile: (file: string) => `/${file}` },
        sahPool: { name: 'typedblite-spike-hub', directory: '/typedblite-spike-hub' },
      });
      const db = new TypeDBLiteInterpreter('/hub.db', undefined, { openDatabase: openWasmSqlite });
      db.define(SCHEMA);
      openedAt = new Date().toISOString();
      return db;
    } catch (error) {
      lastOpenError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (openAttempts > 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
const ready = open();
ready.catch((error: unknown) => console.error('hub failed to open', error));

const frame = (record: { seq: number }): string => `id: ${record.seq}\nevent: change\ndata: ${JSON.stringify(record)}\n\n`;

async function serve(port: MessagePort, peer: number, request: HubRequest): Promise<void> {
  const send = (message: FromHub): void => port.postMessage(message);
  const { id } = request;
  const reply = (status: number, body = '', headers: Record<string, string> = json): void => {
    send({ type: 'head', id, status, headers });
    if (body) send({ type: 'chunk', id, data: body });
    send({ type: 'end', id });
  };
  requests++;
  let db: TypeDBLiteInterpreter;
  try {
    db = await ready;
  } catch {
    return reply(503, JSON.stringify({ error: 'the hub could not open its store' }));
  }
  const url = new URL(request.path, 'http://hub');
  if (url.pathname === '/health') return reply(200, 'ok', { 'content-type': 'text/plain' });
  if (url.pathname === '/tasks') return reply(200, JSON.stringify(readTasks(db)));
  if (url.pathname !== '/changes') return reply(404);
  if (request.headers['authorization'] !== `Bearer ${DEMO_TOKEN}`) return reply(401);

  if (request.method === 'POST') {
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, JSON.stringify({ error: 'the body must be application/json' }));
    try {
      const batch = JSON.parse(request.body ?? '') as unknown;
      if (!Array.isArray(batch)) return reply(400, JSON.stringify({ error: 'the body must be a JSON array of changes' }));
      // Whole batch or none, as the Node handler's `applyRemoteBatch` call. (The Node handler also
      // pre-validates each field; the spike relies on the engine's own refusal.)
      const applied = db.changeLog.applyRemoteBatch(batch as Parameters<typeof db.changeLog.applyRemoteBatch>[0]);
      return reply(200, JSON.stringify({ applied }));
    } catch (error) {
      console.error('push failed', error);
      return reply(500, JSON.stringify({ error: 'internal error' }));
    }
  }
  if (request.method !== 'GET') return reply(404);

  const since = Number(request.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
  let cursor = Number.isFinite(since) ? since : 0;
  send({ type: 'head', id, status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  const flush = (): void => {
    const batch = db.changeLog.since(cursor, 500);
    if (batch.length === 0) return send({ type: 'chunk', id, data: ': caught-up\n\n' });
    for (const record of batch) send({ type: 'chunk', id, data: frame(record) });
    cursor = batch[batch.length - 1].seq;
  };
  flush();
  const timer = setInterval(flush, POLL_MS);
  const key = `${peer}:${id}`;
  streams.set(key, () => {
    clearInterval(timer);
    streams.delete(key);
  });
}

let nextPeer = 1;
/** One peer: a page's own port, or a channel a page handed over for one device. */
function attach(port: MessagePort): void {
  const peer = nextPeer++;
  peers.add(port);
  port.onmessage = async (message: MessageEvent<ToHub>) => {
    const data = message.data as ToHub | { type: 'connect' };
    // A page connects, then hands over a MessagePort per device engine.
    if (data.type === 'connect') return message.ports[0] ? attach(message.ports[0]) : undefined;
    if (data.type === 'request') return void serve(port, peer, data);
    if (data.type === 'cancel') return void streams.get(`${peer}:${data.id}`)?.();
    const db = await ready.catch(() => undefined);
    if (data.type === 'tasks') return port.postMessage({ type: 'tasks', tasks: db ? readTasks(db) : [] } satisfies FromHub);
    if (data.type === 'info') {
      const info: HubInfo = { lastOpenError, opfs: db !== undefined, openedAt, peers: peers.size, requests, openStreams: streams.size, openAttempts };
      return port.postMessage({ type: 'info', info } satisfies FromHub);
    }
  };
  port.start();
}

/** The embedding page hands over one MessagePort per peer: its own panel, and each device engine. */
scope.onmessage = (event: MessageEvent<{ type: string }>) => {
  if (event.data.type === 'connect' && event.ports[0]) attach(event.ports[0]);
};
