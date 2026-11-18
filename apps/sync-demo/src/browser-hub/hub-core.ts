/**
 * The hub's logic, with no worker in it: TypeDBLite's change stream as a request handler over a store, and the
 * loop that serves it to a `MessagePort`.
 *
 * It is what `src/hub/main.ts` does with `node:http`, without `node:http`: the same routes, the same bearer token,
 * the same SSE framing, the same 200 ms poll, and the same refusals (415 for a body that is not JSON, 400 for a
 * malformed batch or a revision not derived from its content, 401 without the token). `hub-worker.ts` is the part
 * that needs a browser (WASM SQLite on OPFS); this runs on any `TypeDBLiteInterpreter`, so Node tests it.
 */
import { DiagnosticCode, diagnosticOf, type ChangeRecord, type TypeDBLiteInterpreter } from '@typedblite/runtime';

import { DEMO_TOKEN } from '../shared/device.js';
import { readTasks } from '../shared/schema.js';
import type { FromHub, HubInfo, ToHub } from './wire.js';

export interface HubCoreOptions {
  /** How often an open stream looks for new changes. Default 200, as the Node hub. */
  readonly pollMs?: number;
  /** The bearer token a device must present. Default the demo's. */
  readonly token?: string;
  /** Told about a push that could not be applied. The device is told only "internal error". */
  readonly onError?: (error: unknown) => void;
}

export interface HubCoreRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Where an answer goes: a head, any number of chunks, an end. */
export interface HubReply {
  head(status: number, headers: Record<string, string>): void;
  chunk(data: string): void;
  end(): void;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

/** One SSE frame. `id` is the change log's `seq`, which is what makes `Last-Event-ID` work. */
const frame = (record: ChangeRecord): string => `id: ${record.seq}\nevent: change\ndata: ${JSON.stringify(record)}\n\n`;

/** A pushed batch's shape, or the reason it is not one. The engine checks the revisions themselves. */
function batchProblem(parsed: unknown): string | undefined {
  if (!Array.isArray(parsed)) return 'the body must be a JSON array of changes';
  for (const [index, record] of parsed.entries()) {
    const bad = (field: string): string => `change ${index} has an invalid ${field}`;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return `change ${index} is not an object`;
    const r = record as Record<string, unknown>;
    if (typeof r['entityId'] !== 'string' || r['entityId'] === '') return bad('entityId');
    if (typeof r['rev'] !== 'string' || r['rev'] === '') return bad('rev');
    if (typeof r['deleted'] !== 'boolean') return bad('deleted');
    if (r['parentRev'] !== undefined && r['parentRev'] !== null && typeof r['parentRev'] !== 'string') return bad('parentRev');
    const state = r['state'];
    if (state !== undefined && state !== null && (typeof state !== 'object' || Array.isArray(state))) return bad('state');
  }
  return undefined;
}

export interface HubCore {
  /** Answer one request. Returns what cancels it: stops an SSE stream, and does nothing for the rest. */
  handle(request: HubCoreRequest, reply: HubReply): () => void;
  /** What the store holds. */
  tasks(): unknown[];
  readonly requests: number;
  readonly openStreams: number;
  /** End every open stream. The store is the caller's to close. */
  close(): void;
}

export function createHubCore(db: TypeDBLiteInterpreter, options: HubCoreOptions = {}): HubCore {
  const pollMs = options.pollMs ?? 200;
  const token = options.token ?? DEMO_TOKEN;
  const streams = new Set<() => void>();
  let requests = 0;

  const handle: HubCore['handle'] = (request, reply) => {
    requests++;
    const answer = (status: number, body = '', headers: Record<string, string> = JSON_HEADERS): (() => void) => {
      reply.head(status, headers);
      if (body) reply.chunk(body);
      reply.end();
      return () => undefined;
    };
    const refuse = (status: number, error: string): (() => void) => answer(status, JSON.stringify({ error }));
    const url = new URL(request.path, 'http://hub');

    if (url.pathname === '/health') return answer(200, 'ok', { 'content-type': 'text/plain' });
    if (url.pathname === '/tasks') return answer(200, JSON.stringify(readTasks(db)));
    if (url.pathname !== '/changes') return answer(404);
    if (request.headers['authorization'] !== `Bearer ${token}`) return answer(401);

    if (request.method === 'POST') {
      if ((request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return refuse(415, 'the body must be application/json');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body ?? '');
      } catch {
        return refuse(400, 'the body is not valid JSON');
      }
      const problem = batchProblem(parsed);
      if (problem !== undefined) return refuse(400, problem);
      try {
        // All or none: a record that cannot be applied leaves the store as it was.
        const applied = db.changeLog.applyRemoteBatch(parsed as Parameters<typeof db.changeLog.applyRemoteBatch>[0]);
        return answer(200, JSON.stringify({ applied }));
      } catch (error) {
        // A revision not derived from its content is the client's fault, so a 400 that names it.
        if (diagnosticOf(error)?.code === DiagnosticCode.revisionNotDerived) {
          return refuse(400, error instanceof Error ? error.message : 'a revision is not derived from its content');
        }
        options.onError?.(error);
        return refuse(500, 'internal error');
      }
    }
    if (request.method !== 'GET') return answer(404);

    const resume = request.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0;
    const since = Number(resume);
    let cursor = Number.isFinite(since) ? since : 0;
    reply.head(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const flush = (): void => {
      const batch = db.changeLog.since(cursor, 500);
      if (batch.length === 0) {
        // Caught up. A comment keeps the connection alive without being an event; a one-shot pull reads to it.
        reply.chunk(': caught-up\n\n');
        return;
      }
      for (const record of batch) reply.chunk(frame(record));
      cursor = batch[batch.length - 1]!.seq;
    };
    flush();
    const timer = setInterval(flush, pollMs);
    const stop = (): void => {
      clearInterval(timer);
      streams.delete(stop);
    };
    streams.add(stop);
    return stop;
  };

  return {
    handle,
    tasks: () => readTasks(db),
    get requests() {
      return requests;
    },
    get openStreams() {
      return streams.size;
    },
    close() {
      for (const stop of [...streams]) stop();
    },
  };
}

export type HubPortState = Pick<HubInfo, 'state' | 'openError' | 'openedAt' | 'openAttempts'>;

/**
 * Serve a hub to one `MessagePort`: its requests, its cancels, and the page's questions. `ready` resolves to the core
 * once the store is open, so a request that arrives while the store is still opening waits for it, and one that
 * arrives when it could not open is answered 503 rather than never. `peers` counts every port served.
 */
export function serveHubPort(port: MessagePort, ready: Promise<HubCore>, status: () => HubPortState, peers: () => number): void {
  const cancels = new Map<number, () => void>();
  const send = (message: FromHub): void => port.postMessage(message);
  port.onmessage = async (event: MessageEvent<ToHub>) => {
    const message = event.data;
    if (message.type === 'cancel') {
      cancels.get(message.id)?.();
      cancels.delete(message.id);
      return;
    }
    let core: HubCore | undefined;
    try {
      core = await ready;
    } catch {
      core = undefined;
    }
    if (message.type === 'request') {
      const { id } = message;
      if (!core) {
        send({ type: 'head', id, status: 503, headers: JSON_HEADERS });
        send({ type: 'chunk', id, data: JSON.stringify({ error: 'the hub could not open its store' }) });
        send({ type: 'end', id });
        return;
      }
      const cancel = core.handle(message, {
        head: (status, headers) => send({ type: 'head', id, status, headers }),
        chunk: (data) => send({ type: 'chunk', id, data }),
        end: () => send({ type: 'end', id }),
      });
      cancels.set(id, cancel);
    } else if (message.type === 'tasks') {
      send({ type: 'tasks', tasks: core?.tasks() ?? [] });
    } else if (message.type === 'info') {
      const info: HubInfo = { ...status(), peers: peers(), requests: core?.requests ?? 0, openStreams: core?.openStreams ?? 0 };
      send({ type: 'info', info });
    }
  };
  port.start();
}
