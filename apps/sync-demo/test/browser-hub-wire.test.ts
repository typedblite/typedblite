/**
 * The device side of the in-browser hub's wire (`src/browser-hub/wire.ts`): `fetch` over a `MessagePort`. The replicator
 * calls the global `fetch`, so these test what it sees: a `Response` whose body streams, an abort that reaches the hub,
 * and a cut line that looks like no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installHubFetch, type FromHub, type ToHub } from '../src/browser-hub/wire.js';
import { AUTH, lineTo, newHub } from './browser-hub-support.js';

const realFetch = globalThis.fetch;
const open: MessagePort[] = [];
const track = (...ports: MessagePort[]): void => void open.push(...ports);
let passthrough: ReturnType<typeof vi.fn>;
let shim: ReturnType<typeof installHubFetch>;

beforeEach(() => {
  passthrough = vi.fn(async () => new Response('real'));
  globalThis.fetch = passthrough as unknown as typeof fetch; // what `installHubFetch` keeps as the real one
  shim = installHubFetch();
});
afterEach(() => {
  shim.setPort(null);
  for (const port of open.splice(0)) port.close();
  globalThis.fetch = realFetch;
});

/** A hub that records what it is asked and answers only when told: for the cases a real core answers too fast. */
function scripted(): { port: MessagePort; seen: ToHub[]; send: (message: FromHub) => void; next: () => Promise<ToHub> } {
  const channel = new MessageChannel();
  const hub = channel.port2 as unknown as MessagePort;
  const seen: ToHub[] = [];
  const waiting: Array<(m: ToHub) => void> = [];
  hub.onmessage = (event: MessageEvent<ToHub>) => {
    seen.push(event.data);
    waiting.shift()?.(event.data);
  };
  const port = channel.port1 as unknown as MessagePort;
  track(port, hub);
  return {
    port,
    seen,
    send: (message) => hub.postMessage(message),
    next: () => (seen.length > waiting.length ? Promise.resolve(seen[waiting.length]!) : new Promise((resolve) => waiting.push(resolve))),
  };
}
const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('which requests it takes', () => {
  it('leaves every URL that is not hub:// to the real fetch, with its arguments', async () => {
    const init = { method: 'POST', body: 'x' };
    expect(await (await fetch('https://example.test/a', init)).text()).toBe('real');
    expect(passthrough).toHaveBeenCalledWith('https://example.test/a', init);
  });

  it('fails a hub:// request at once, as fetch does with no network, when there is no line', async () => {
    await expect(fetch('hub://hub/health')).rejects.toThrow(new TypeError('Failed to fetch'));
    await expect(fetch('hub://hub/health')).rejects.toBeInstanceOf(TypeError);
    expect(passthrough).not.toHaveBeenCalled();
  });

  it('reads the URL from a URL or a Request as well as a string', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    void fetch(new URL('hub://hub/a?x=1')).catch(() => undefined);
    void fetch(new Request('hub://hub/b')).catch(() => undefined);
    await tick();
    expect(hub.seen.map((m) => (m.type === 'request' ? m.path : m.type))).toEqual(['/a?x=1', '/b']);
  });
});

describe('a round trip', () => {
  it('reaches a real hub core and returns its Response', async () => {
    const { core } = newHub();
    const { port, server } = lineTo(core);
    track(port, server);
    shim.setPort(port);
    const response = await fetch('hub://hub/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(await response.text()).toBe('ok');
  });

  it('carries the method, path with its query, headers and body', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    void fetch('hub://hub/changes?since=3', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '[1]' }).catch(() => undefined);
    expect(await hub.next()).toEqual({
      type: 'request',
      id: expect.any(Number),
      method: 'POST',
      path: '/changes?since=3',
      headers: { 'content-type': 'application/json', authorization: AUTH.authorization },
      body: '[1]',
    });
  });

  it('sends a GET with no body and no body key', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    void fetch('hub://hub/tasks').catch(() => undefined);
    const message = (await hub.next()) as Extract<ToHub, { type: 'request' }>;
    expect(message.method).toBe('GET');
    expect('body' in message).toBe(false);
  });

  it('gives each request its own id, so answers cannot cross', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const a = fetch('hub://hub/a');
    const b = fetch('hub://hub/b');
    await tick();
    const ids = hub.seen.map((m) => (m as { id: number }).id);
    expect(new Set(ids).size).toBe(2);
    // Answer b first.
    hub.send({ type: 'head', id: ids[1]!, status: 201, headers: {} });
    hub.send({ type: 'head', id: ids[0]!, status: 202, headers: {} });
    expect([(await a).status, (await b).status]).toEqual([202, 201]);
  });

  it('streams the body: a chunk arrives as it is sent, and the body ends on `end`', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const pending = fetch('hub://hub/changes');
    const { id } = (await hub.next()) as { id: number };
    hub.send({ type: 'head', id, status: 200, headers: { 'content-type': 'text/event-stream' } });
    const response = await pending;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    hub.send({ type: 'chunk', id, data: 'id: 1\n\n' });
    expect(decoder.decode((await reader.read()).value)).toBe('id: 1\n\n');
    hub.send({ type: 'chunk', id, data: ': caught-up\n\n' });
    expect(decoder.decode((await reader.read()).value)).toBe(': caught-up\n\n');
    hub.send({ type: 'end', id });
    expect((await reader.read()).done).toBe(true);
  });

  it('encodes a multi-byte chunk as UTF-8, so a reader decodes it back whole', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const pending = fetch('hub://hub/x');
    const { id } = (await hub.next()) as { id: number };
    hub.send({ type: 'head', id, status: 200, headers: {} });
    hub.send({ type: 'chunk', id, data: 'Café 🚀 日本' });
    hub.send({ type: 'end', id });
    expect(await (await pending).text()).toBe('Café 🚀 日本');
  });

  it('ignores a message for a request it no longer knows, and one that is not an answer', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    hub.send({ type: 'head', id: 999, status: 200, headers: {} });
    hub.send({ type: 'chunk', id: 999, data: 'x' });
    hub.send({ type: 'end', id: 999 });
    hub.send({ type: 'tasks', tasks: [] });
    hub.send({ type: 'info', info: {} as never });
    await tick();
    const pending = fetch('hub://hub/ok');
    const { id } = (await hub.next()) as { id: number };
    hub.send({ type: 'head', id, status: 200, headers: {} });
    expect((await pending).status).toBe(200);
  });
});

describe('cancelling', () => {
  it('tells the hub when the caller aborts before it answers, and rejects with the abort', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const controller = new AbortController();
    const pending = fetch('hub://hub/slow', { signal: controller.signal });
    const { id } = (await hub.next()) as { id: number };
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(hub.seen).toContainEqual({ type: 'cancel', id });
  });

  it('rejects with the signal’s own reason, as fetch does, such as a timeout', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const pending = fetch('hub://hub/slow', { signal: AbortSignal.timeout(30) });
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    await expect(fetch('hub://hub/x', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(hub.seen.filter((m) => m.type === 'request')).toEqual([]);
  });

  it('errors a body that is being read when the caller aborts, and tells the hub', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const controller = new AbortController();
    const pending = fetch('hub://hub/changes', { signal: controller.signal });
    const { id } = (await hub.next()) as { id: number };
    hub.send({ type: 'head', id, status: 200, headers: {} });
    const reader = (await pending).body!.getReader();
    const read = reader.read();
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(hub.seen).toContainEqual({ type: 'cancel', id });
  });

  it('tells the hub when a reader cancels the body, which is how a one-shot pull stops a stream', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const pending = fetch('hub://hub/changes');
    const { id } = (await hub.next()) as { id: number };
    hub.send({ type: 'head', id, status: 200, headers: {} });
    await (await pending).body!.cancel();
    await tick();
    expect(hub.seen).toContainEqual({ type: 'cancel', id });
  });
});

describe('a cut line', () => {
  it('fails a request waiting for its answer with the no-network TypeError', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const pending = fetch('hub://hub/slow');
    await hub.next();
    shim.setPort(null);
    await expect(pending).rejects.toThrow(new TypeError('Failed to fetch'));
  });

  it('errors a body being read, so a sync that is mid-stream fails rather than hangs', async () => {
    const hub = scripted();
    shim.setPort(hub.port);
    const pending = fetch('hub://hub/changes');
    const { id } = (await hub.next()) as { id: number };
    hub.send({ type: 'head', id, status: 200, headers: {} });
    const reader = (await pending).body!.getReader();
    const read = reader.read();
    shim.setPort(null);
    await expect(read).rejects.toThrow(new TypeError('Failed to fetch'));
  });

  it('refuses new requests until a line is back, then works on the new line', async () => {
    shim.setPort(null);
    await expect(fetch('hub://hub/health')).rejects.toBeInstanceOf(TypeError);
    const { core } = newHub();
    const { port, server } = lineTo(core);
    track(port, server);
    shim.setPort(port);
    expect(await (await fetch('hub://hub/health')).text()).toBe('ok');
  });

  it('moves to a replacement port, closing the old one, so the old hub is no longer asked', async () => {
    const first = scripted();
    shim.setPort(first.port);
    const { core } = newHub();
    const second = lineTo(core);
    track(second.port, second.server);
    shim.setPort(second.port);
    expect(await (await fetch('hub://hub/health')).text()).toBe('ok');
    await tick();
    expect(first.seen).toEqual([]);
  });
});
