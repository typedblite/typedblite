/**
 * The spoke's side of the wire: a hand-rolled SSE client, and a POST for pushing.
 *
 * 🔴 **Hand-rolled over `fetch`, not `EventSource`.** Node v24 has no global `EventSource` without
 * `--experimental-eventsource`, and this substrate already depends on one experimental API
 * (`node:sqlite`, which warns on every use). Taking a second flag for a protocol whose framing is
 * half a page of parsing is a poor trade.
 *
 * Named `ChangeStreamClient` because `EventSource` already means something else here — see
 * `change-stream.ts`.
 */
import type { ChangeRecord } from './change-log.js';

/**
 * What a subscription calls as the hub's stream delivers changes and as its own state changes.
 *
 * @category Change stream
 */
export interface ChangeStreamHandlers {
  /**
   * Called with each change, in order. If it throws, the subscription stops without reconnecting and `onFailed` is
   * called with `'apply'`; the change is not counted as seen, so a resume starts at it.
   */
  onChange(record: ChangeRecord): void;
  /** Caught up — nothing further for now. Not a terminal state. */
  onPaused?(): void;
  /** Receiving. */
  onActive?(): void;
  /**
   * `'transport'` is the connection; `'apply'` is `onChange` itself throwing.
   *
   * They are not the same failure and must not be retried the same way — a transport error is worth
   * reconnecting through, while a handler that throws will throw again on the identical record.
   */
  onFailed?(error: Error, cause?: 'transport' | 'apply'): void;
}

/**
 * A running subscription to a hub's change stream.
 *
 * @category Change stream
 */
export interface ChangeStreamSubscription {
  /** Stops it: no more reconnects and no more calls to the handlers. */
  cancel(): Promise<void>;
  /** The last `seq` seen, which is what a reconnect resumes from. */
  readonly lastEventId: number;
}

/**
 * How a {@link ChangeStreamClient} connects and retries.
 *
 * @category Change stream
 */
export interface ChangeStreamClientOptions {
  /** Retry delay after a dropped connection, in milliseconds. It grows linearly with each failed attempt. Default 200. */
  readonly retryMs?: number;
  /**
   * How many failed connection attempts in a row to retry before giving up, calling `onFailed` with `'transport'`.
   * A connection that succeeds resets the count. Default 5.
   */
  readonly maxRetries?: number;
  /**
   * Headers to send with every request — a bearer token, for a hub that wants one. A function, and
   * called per request, because a token expires and a long-lived subscription must not keep
   * presenting the one it started with.
   */
  readonly headers?: () =>
    | Record<string, string>
    | Promise<Record<string, string>>;
}

/**
 * Parse an SSE byte stream into frames.
 *
 * Frames are separated by a blank line; a line beginning `:` is a comment and carries no event.
 * The parser holds a buffer across chunks because a frame can straddle a network read — assuming
 * one chunk is one frame is the classic way an SSE client works locally and fails under load.
 */
function parseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

function readFrame(frame: string): { id?: number; data?: string } {
  const result: { id?: number; data?: string } = {};
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id:')) result.id = Number(line.slice(3).trim());
    else if (line.startsWith('data:')) result.data = line.slice(5).trim();
  }
  return result;
}

/**
 * The spoke's side of a hub's change stream: subscribes to the hub's server-sent events and pushes revisions to it. Reconnects
 * on a dropped connection, resuming from the last change it delivered.
 *
 * @category Change stream
 */
export class ChangeStreamClient {
  private controller?: AbortController;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;
  private seen = 0;

  /**
   * Creates a client for one hub.
   *
   * @param url The hub's base URL. Changes are read and pushed at `<url>/changes`.
   * @param options How it retries, and the headers to send.
   */
  public constructor(
    /** Public so a replicator can read the stream once without reaching into a private field. */
    public readonly url: string,
    private readonly options: ChangeStreamClientOptions = {},
  ) {}

  /** The `seq` of the last change delivered, which a reconnect resumes from. */
  public get lastEventId(): number {
    return this.seen;
  }

  /** The extra headers for the next request (empty when none were configured). */
  public async requestHeaders(): Promise<Record<string, string>> {
    return (await this.options.headers?.()) ?? {};
  }

  /** Push revisions to the hub. The other half of duplex — SSE has no back-channel. */
  public async push(records: readonly ChangeRecord[], signal?: AbortSignal): Promise<number> {
    const response = await fetch(`${this.url}/changes`, {
      signal,
      method: 'POST',
      headers: {
        ...(await this.requestHeaders()),
        'content-type': 'application/json',
      },
      body: JSON.stringify(records),
    });
    if (!response.ok) throw new Error(`push failed: ${response.status}`);
    const body = (await response.json()) as { applied: number };
    return body.applied;
  }

  /**
   * Subscribe. Reconnects on a dropped connection, resuming from `Last-Event-ID`.
   *
   * @privateRemarks
   * 🔴 Being caught up is `paused`, never terminal. Prior art's coordinator returned early once it
   * had synced, so it replicated exactly once and its suite proved the gate rather than the loop.
   */
  public subscribe(
    handlers: ChangeStreamHandlers,
    from = 0,
  ): ChangeStreamSubscription {
    this.stopped = false;
    this.seen = from;
    const retryMs = this.options.retryMs ?? 200;
    const maxRetries = this.options.maxRetries ?? 5;
    let attempt = 0;

    const connect = async (): Promise<void> => {
      if (this.stopped) return;
      this.controller = new AbortController();
      try {
        const response = await fetch(`${this.url}/changes`, {
          headers: {
            ...(await this.requestHeaders()),
            accept: 'text/event-stream',
            ...(this.seen > 0 ? { 'last-event-id': String(this.seen) } : {}),
          },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`stream failed: ${response.status}`);
        }

        attempt = 0;
        handlers.onActive?.();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseFrames(buffer);
          buffer = rest;

          let delivered = false;
          for (const raw of frames) {
            const { id, data } = readFrame(raw);
            if (data === undefined) continue;
            // 🔴 Advance *after* the handler succeeds, never before.
            //
            // `this.seen` is what `Last-Event-ID` resumes from, so marking a record seen and then
            // handing it to a handler that throws loses it: the throw was caught by the transport
            // `catch` below, reported as a reconnect-worthy blip, and the reconnect asked to resume
            // *past* the record that had just failed to apply. A permanent apply failure looked
            // like a network hiccup and silently dropped data.
            try {
              handlers.onChange(JSON.parse(data) as ChangeRecord);
            } catch (error) {
              // 🔴 Release the stream before giving up on it. Returning straight out left the
              // reader open and the controller un-aborted, so the hub's flush interval went on
              // writing into a socket nobody reads — its `request.on('close')` never fires — and
              // the spoke's process would not exit. That is the symptom `cancel()`'s own comment
              // calls the worst possible one, and `fetchSince` already avoids it with a `finally`.
              this.stopped = true;
              await reader.cancel().catch(() => undefined);
              this.controller?.abort();
              this.controller = undefined;
              handlers.onFailed?.(error as Error, 'apply');
              return;
            }
            if (id !== undefined) this.seen = id;
            delivered = true;
          }
          if (delivered) handlers.onActive?.();
          else handlers.onPaused?.();
        }
      } catch (error) {
        if (this.stopped || (error as Error).name === 'AbortError') return;
        attempt += 1;
        if (attempt > maxRetries) {
          handlers.onFailed?.(error as Error, 'transport');
          return;
        }
        // Linear backoff, matching prior art's coordinator rather than inventing a second policy.
        this.retryTimer = setTimeout(() => void connect(), retryMs * attempt);
        return;
      }
      // The stream ended without an error — the hub closed it. Reconnect unless cancelled.
      if (!this.stopped) {
        this.retryTimer = setTimeout(() => void connect(), retryMs);
      }
    };

    void connect();

    // A closure rather than an alias of `this`: the object literal below has its own `this`, and
    // aliasing the class's into it is exactly what `no-this-alias` exists to catch.
    const seen = () => this.seen;
    return {
      // 🔴 Was a hardcoded `0`, against this property's documented contract. A caller persisting it
      // across a restart — which is the entire reason it is exposed — resumed from the start of the
      // log every time, replaying the whole history as if it were new.
      get lastEventId() {
        return seen();
      },
      cancel: async () => {
        // 🔴 Both, and in this order. Aborting without clearing the timer leaves a pending
        // reconnect that keeps the event loop alive, so a process hangs on exit instead of failing
        // a test — the worst possible symptom.
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.controller?.abort();
        this.controller = undefined;
      },
    };
  }
}
