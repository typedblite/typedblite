/**
 * The wire between a device and the hub SharedWorker: a `fetch` over a MessagePort.
 *
 * The replicator calls the global `fetch`, so the device worker replaces it for `hub://` URLs and
 * leaves every other URL alone. The hub answers a request with a head, any number of chunks (an SSE
 * stream is one that never ends), and an end — or the requester cancels.
 */
export type HubRequest = {
  readonly type: 'request';
  readonly id: number;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
};
export type HubCancel = { readonly type: 'cancel'; readonly id: number };
export type HubControl = { readonly type: 'tasks' } | { readonly type: 'info' };
export type ToHub = HubRequest | HubCancel | HubControl;

export type FromHub =
  | { readonly type: 'head'; readonly id: number; readonly status: number; readonly headers: Record<string, string> }
  | { readonly type: 'chunk'; readonly id: number; readonly data: string }
  | { readonly type: 'end'; readonly id: number }
  | { readonly type: 'tasks'; readonly tasks: unknown[] }
  | { readonly type: 'info'; readonly info: HubInfo };

export interface HubInfo {
  readonly opfs: boolean;
  readonly lastOpenError: string;
  readonly openedAt: string;
  readonly peers: number;
  readonly requests: number;
  readonly openStreams: number;
  readonly openAttempts: number;
}

/** What `installHubFetch` hands back: the device worker gives it the current port, or `null` when the hub is gone. */
export function installHubFetch(): { setPort(port: MessagePort | null): void } {
  const realFetch = globalThis.fetch.bind(globalThis);
  let port: MessagePort | null = null;
  let next = 1;
  type Entry = { resolve(response: Response): void; reject(error: unknown): void; controller?: ReadableStreamDefaultController<Uint8Array>; headed: boolean };
  const pending = new Map<number, Entry>();
  const encoder = new TextEncoder();

  const failAll = (error: unknown): void => {
    for (const entry of pending.values()) {
      if (entry.headed) entry.controller?.error(error);
      else entry.reject(error);
    }
    pending.clear();
  };

  const onMessage = (event: MessageEvent<FromHub>): void => {
    const message = event.data;
    if (message.type !== 'head' && message.type !== 'chunk' && message.type !== 'end') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'head') {
      entry.headed = true;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => void (entry.controller = controller),
        cancel: () => {
          pending.delete(message.id);
          port?.postMessage({ type: 'cancel', id: message.id } satisfies HubCancel);
        },
      });
      entry.resolve(new Response(body, { status: message.status, headers: message.headers }));
    } else if (message.type === 'chunk') {
      entry.controller?.enqueue(encoder.encode(message.data));
    } else {
      pending.delete(message.id);
      entry.controller?.close();
    }
  };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('hub://')) return realFetch(input, init);
    // What a real fetch does with no network: a TypeError. The device reads it as "offline".
    if (!port) return Promise.reject(new TypeError('Failed to fetch'));
    const target = new URL(url);
    const id = next++;
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const abort = (): void => {
        const entry = pending.get(id);
        pending.delete(id);
        port?.postMessage({ type: 'cancel', id } satisfies HubCancel);
        const error = signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        if (entry?.headed) entry.controller?.error(error);
        else reject(error);
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(id, { resolve, reject, headed: false });
      port!.postMessage({
        type: 'request',
        id,
        method: init?.method ?? 'GET',
        path: target.pathname + target.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      } satisfies HubRequest);
    });
  }) as typeof fetch;

  return {
    setPort(next: MessagePort | null): void {
      if (port) port.onmessage = null;
      port?.close();
      port = next;
      if (port) port.onmessage = onMessage;
      else failAll(new TypeError('Failed to fetch'));
    },
  };
}
