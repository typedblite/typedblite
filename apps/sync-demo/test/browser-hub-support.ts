/**
 * What the in-browser hub's unit tests share: a store, a hub core over it, and a `MessagePort` line to it, all on
 * `node:sqlite`. (The browser runs the same `hub-core.ts` on WASM SQLite; `hub-worker.ts` is the part this cannot reach.)
 */
import { TypeDBLiteInterpreter } from '@typedblite/runtime';

import { DemoDevice } from '../src/shared/device.js';
import { SCHEMA } from '../src/shared/schema.js';
import { createHubCore, serveHubPort, type HubCore, type HubCoreOptions, type HubCoreRequest, type HubReply } from '../src/browser-hub/hub-core.js';

export function newStore(): TypeDBLiteInterpreter {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(SCHEMA);
  return db;
}

export function newHub(options: HubCoreOptions = {}): { db: TypeDBLiteInterpreter; core: HubCore } {
  const db = newStore();
  return { db, core: createHubCore(db, options) };
}

/** A device on its own `:memory:` store, pointing at `hub://hub` (the shim routes it). */
export function newDevice(name: string, hubUrl = 'hub://hub'): { device: DemoDevice; db: TypeDBLiteInterpreter } {
  const db = newStore();
  return { device: new DemoDevice(name, db, hubUrl, { timeoutMs: 3_000 }), db };
}

export const AUTH = { authorization: 'Bearer typedblite-sync-demo' };

export interface Collected {
  status?: number;
  headers: Record<string, string>;
  chunks: string[];
  ended: boolean;
  /** Everything the reply wrote, joined. */
  readonly body: string;
}

/** A reply that records what it is given. */
export function collect(): { reply: HubReply; got: Collected } {
  const got: Collected = {
    headers: {},
    chunks: [],
    ended: false,
    get body() {
      return this.chunks.join('');
    },
  };
  const reply: HubReply = {
    head: (status, headers) => {
      got.status = status;
      got.headers = headers;
    },
    chunk: (data) => void got.chunks.push(data),
    end: () => void (got.ended = true),
  };
  return { reply, got };
}

/** Answer one request on a core and return what it said, and what cancels it. */
export function ask(core: HubCore, request: Partial<HubCoreRequest> & { path: string }): { got: Collected; cancel: () => void } {
  const { reply, got } = collect();
  const cancel = core.handle({ method: 'GET', headers: {}, ...request }, reply);
  return { got, cancel };
}

/** A port to `core`, served the way the worker serves a device's. The caller closes both ends. */
export function lineTo(core: HubCore | Promise<HubCore>, peers = 1): { port: MessagePort; server: MessagePort } {
  const channel = new MessageChannel();
  const status = { state: 'open', openError: '', openedAt: 'now', openAttempts: 1 } as const;
  serveHubPort(channel.port2 as unknown as MessagePort, Promise.resolve(core), () => status, () => peers);
  return { port: channel.port1 as unknown as MessagePort, server: channel.port2 as unknown as MessagePort };
}
