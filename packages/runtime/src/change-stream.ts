/**
 * The hub's side of the wire: an SSE stream out, and a POST in.
 *
 * Implements [ADR-020](../../../../../docs/architecture/adr-020-typeqlite-change-log-and-sync-as-a-port.md)
 * Decision 8.
 *
 * 🔴 **Named `ChangeStream`, not `EventSource`.** `libs/core/events/domain` already exports an
 * interface called `EventSource`, meaning the source of a domain event, and it keeps that meaning.
 * SSE's client class shares the name, which is exactly the kind of collision that makes a codebase
 * about events hard to read.
 *
 * The server needs no library — an SSE response is one whose body is never ended.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { ChangeLog, ChangeRecord } from './change-log.js';

export interface ChangeStreamOptions {
  /**
   * How often to look for new changes.
   *
   * This is the safety net, not the mechanism: a hub that performs its own writes publishes a
   * domain event and can wake immediately. What polling covers is a write that bypassed the
   * application — a CLI, a migration, a repair script — which emits nothing. `node:sqlite` exposes
   * no update or commit hook, so there is no way to be told about those.
   */
  readonly pollMs?: number;
  /** Batch size per flush. */
  readonly limit?: number;
  /**
   * Bind a specific port instead of an ephemeral one.
   *
   * Needed to restart a hub on the port a client is already retrying against — otherwise a
   * "survives a restart" test would be testing a client's ability to find a new address, which is
   * not what resume means.
   */
  readonly port?: number;
}

/** One SSE frame. `id` is the change log's `seq`, which is what makes `Last-Event-ID` work. */
function frame(record: ChangeRecord): string {
  return `id: ${record.seq}\nevent: change\ndata: ${JSON.stringify(record)}\n\n`;
}

/**
 * The change stream as a request handler, so a hub can mount it under its own routes and put its own
 * authentication in front.
 *
 * - `GET  <path>` — SSE. Resumes from `Last-Event-ID`, or `?since=`, or the beginning.
 * - `POST <path>` — accept revisions pushed by a spoke.
 *
 * `path` is where the handler believes it is mounted (default `/changes`); anything else is a 404.
 * `close()` ends every open stream — without that, a held-open response keeps the process alive and
 * a test hangs rather than failing.
 */
export function createChangeStreamHandler(
  log: ChangeLog,
  options: ChangeStreamOptions & { readonly path?: string } = {},
): {
  handle: (request: IncomingMessage, response: ServerResponse) => void;
  close: () => void;
} {
  const pollMs = options.pollMs ?? 250;
  const limit = options.limit ?? 500;
  const path = options.path ?? '/changes';
  const open = new Set<{ response: ServerResponse; timer: NodeJS.Timeout }>();

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'POST' && url.pathname === path) {
      // 🔴 Collect bytes and decode once, never `body += String(chunk)`.
      //
      // A chunk boundary falls wherever TCP puts it, which is not where a character ends. Stringify
      // per chunk and any multi-byte character split across two reads — every non-ASCII character
      // in a title, and every emoji this repository's own documents are full of — decodes to two
      // replacement characters. `JSON.parse` then throws, the hub answers 400, and the client
      // retries the identical batch forever: replication stops dead on one accented letter.
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer | string) => {
        chunks.push(
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
        );
      });
      request.on('end', () => {
        try {
          const records = JSON.parse(
            // 🔴 A cast, and a types-only one — at runtime a `Buffer` **is** a `Uint8Array`.
            //
            // Current `@types/node` declares `Buffer.concat(list: readonly Uint8Array<ArrayBuffer>[])`
            // while `Buffer` is `Buffer<ArrayBufferLike>`, whose `slice().buffer` may be a
            // `SharedArrayBuffer` — so the two are not assignable in either direction, and typing
            // `chunks` as `Uint8Array[]` only moves the error to the `push`.
            //
            // Nothing had type-checked this file through a bundler before: `skills` and `mvp` reach
            // the engine only through `persistence-infrastructure`'s deliberate runtime `import()`,
            // so `tsc` never saw it. `data-store` reaches it through a **type** import and
            // webpack's `tsc` compiler does — the first build to look, and it failed immediately.
            Buffer.concat(chunks as unknown as Uint8Array[]).toString('utf8'),
          ) as ChangeRecord[];
          let applied = 0;
          for (const record of records) {
            if (
              log.applyRemote({
                entityId: record.entityId,
                rev: record.rev,
                parentRev: record.parentRev,
                deleted: record.deleted,
                state: record.state,
              })
            ) {
              applied += 1;
            }
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ applied }));
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: String(error) }));
        }
      });
      return;
    }

    if (request.method !== 'GET' || url.pathname !== path) {
      response.writeHead(404);
      response.end();
      return;
    }

    // 🔴 `Last-Event-ID` is the resume mechanism, and it maps onto `seq` directly. Reimplementing
    // resume alongside a protocol that already provides it would give two sources of truth for the
    // same position.
    const lastEventId = request.headers['last-event-id'];
    const since = Number(
      (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ??
        url.searchParams.get('since') ??
        0,
    );
    let cursor = Number.isFinite(since) ? since : 0;

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const flush = () => {
      const batch = log.since(cursor, limit);
      if (batch.length === 0) {
        // Caught up. A comment keeps the connection alive through proxies without being an event.
        response.write(': caught-up\n\n');
        return;
      }
      for (const record of batch) response.write(frame(record));
      cursor = batch[batch.length - 1].seq;
    };

    flush();
    const timer = setInterval(flush, pollMs);
    const entry = { response, timer };
    open.add(entry);

    request.on('close', () => {
      clearInterval(timer);
      open.delete(entry);
    });
  };

  const close = (): void => {
    for (const entry of open) {
      clearInterval(entry.timer);
      entry.response.end();
    }
    open.clear();
  };

  return { handle, close };
}

/**
 * Serve a change log over HTTP on its own port.
 *
 * Returns the server plus a `close()` that also ends every open stream.
 */
export function serveChangeStream(
  log: ChangeLog,
  options: ChangeStreamOptions = {},
): { server: Server; port: Promise<number>; close: () => Promise<void> } {
  const handler = createChangeStreamHandler(log, options);
  const server = createServer(handler.handle);

  const port = new Promise<number>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    server,
    port,
    close: async () => {
      handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
