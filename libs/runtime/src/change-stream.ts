/**
 * The hub's side of the wire: an SSE stream out, and a POST in.
 *
 * Implements [ADR-003](../../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)
 * Decision 8.
 *
 * 🔴 **Named `ChangeStream`, not `EventSource`.** `EventSource` is a well-established name for the
 * source of a domain event; SSE's client class shares the name. Using it here creates exactly the
 * kind of collision that makes a codebase about events hard to read.
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
  /**
   * The largest POST body, in bytes. A larger one is refused with 413 before it is all read.
   * Default 64 MiB, far above a batch of 500 revisions of ordinary documents (about 2 MB in the load
   * test), and low enough that one request cannot exhaust a hub's memory.
   */
  readonly maxBodyBytes?: number;
  /**
   * The most SSE streams open at once. One more is refused with 503 and `retry-after`. Each stream
   * holds a connection and a timer that queries the log every `pollMs`. Default 256.
   */
  readonly maxStreams?: number;
  /**
   * Told about a failure inside the hub: a batch that could not be applied. The client is told only
   * "internal error", because the real message names tables and files. Without this, the failure is
   * invisible to whoever runs the hub.
   */
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STREAMS = 256;

/** A pushed record, as `applyRemoteBatch` takes it. */
type PushedRecord = Parameters<ChangeLog['applyRemoteBatch']>[0][number];

/**
 * A pushed batch, checked field by field, or the reason it is not one.
 *
 * Checked before anything is applied, so a malformed record is refused as a whole batch with a message
 * that names the record, and never as a `TypeError` from inside the engine.
 */
function parseBatch(body: string): PushedRecord[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'the body is not valid JSON';
  }
  if (!Array.isArray(parsed)) return 'the body must be a JSON array of changes';
  for (const [index, record] of parsed.entries()) {
    const bad = (field: string) => `change ${index} has an invalid ${field}`;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return `change ${index} is not an object`;
    const r = record as Record<string, unknown>;
    if (typeof r['entityId'] !== 'string' || r['entityId'] === '') return bad('entityId');
    if (typeof r['rev'] !== 'string' || r['rev'] === '') return bad('rev');
    if (typeof r['deleted'] !== 'boolean') return bad('deleted');
    if (r['parentRev'] !== undefined && r['parentRev'] !== null && typeof r['parentRev'] !== 'string') return bad('parentRev');
    const state = r['state'];
    if (state !== undefined && state !== null && (typeof state !== 'object' || Array.isArray(state))) return bad('state');
  }
  return parsed as PushedRecord[];
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
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
  const open = new Set<{ response: ServerResponse; timer: NodeJS.Timeout }>();

  const refuse = (response: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify({ error }));
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'POST' && url.pathname === path) {
      // 🔴 Only JSON. A page in a browser can POST `text/plain` to a hub on 127.0.0.1 from another
      // origin with no CORS preflight, so refusing every other type closes that door by itself.
      // (Authentication, which the caller adds in front of this handler, closes it for good.)
      const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/json') {
        request.resume();
        return refuse(response, 415, 'the body must be application/json');
      }
      // 🔴 Refused before it is read when the client says it is too big, and while it is read when it
      // does not say (chunked). Nothing past the limit is ever held.
      const declared = Number(request.headers['content-length']);
      const tooBig = () => {
        refuse(response, 413, `the body is larger than ${maxBodyBytes} bytes`, { connection: 'close' });
        response.once('finish', () => request.destroy());
      };
      if (Number.isFinite(declared) && declared > maxBodyBytes) return tooBig();

      // 🔴 Collect bytes and decode once, never `body += String(chunk)`.
      //
      // A chunk boundary falls wherever TCP puts it, which is not where a character ends. Stringify
      // per chunk and any multi-byte character split across two reads — every non-ASCII character
      // in a title, and every emoji this repository's own documents are full of — decodes to two
      // replacement characters. `JSON.parse` then throws, the hub answers 400, and the client
      // retries the identical batch forever: replication stops dead on one accented letter.
      const chunks: Buffer[] = [];
      let received = 0;
      let refused = false;
      request.on('data', (chunk: Buffer | string) => {
        if (refused) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        received += bytes.length;
        if (received > maxBodyBytes) {
          refused = true;
          chunks.length = 0;
          return tooBig();
        }
        chunks.push(bytes);
      });
      request.on('end', () => {
        if (refused) return;
        // 🔴 A cast, and a types-only one — at runtime a `Buffer` **is** a `Uint8Array`.
        //
        // Current `@types/node` declares `Buffer.concat(list: readonly Uint8Array<ArrayBuffer>[])`
        // while `Buffer` is `Buffer<ArrayBufferLike>`, whose `slice().buffer` may be a
        // `SharedArrayBuffer` — so the two are not assignable in either direction, and typing
        // `chunks` as `Uint8Array[]` only moves the error to the `push`.
        const batch = parseBatch(Buffer.concat(chunks as unknown as Uint8Array[]).toString('utf8'));
        if (typeof batch === 'string') return refuse(response, 400, batch);
        try {
          // All or none: a record that cannot be applied leaves the store as it was.
          const applied = log.applyRemoteBatch(batch);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ applied }));
        } catch (error) {
          // The client gets no detail: the message names tables and files. The operator does.
          options.onError?.(error);
          refuse(response, 500, 'internal error');
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

    // 🔴 Each stream holds a connection and a timer that queries the log, so an uncapped count is a way
    // to make a hub do unbounded work. Refused, with a hint for when to come back.
    if (open.size >= maxStreams) return refuse(response, 503, 'too many open streams', { 'retry-after': '5' });

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
