/**
 * The in-browser hub's logic (`src/browser-hub/hub-core.ts`), on `node:sqlite`: every route, every refusal, SSE
 * framing and resume, and the port loop. Its answers are the Node hub's (`src/hub/main.ts`), which
 * `browser-hub-replication.test.ts` checks side by side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoDevice } from '../src/shared/device.js';
import { serveHubPort } from '../src/browser-hub/hub-core.js';
import type { FromHub } from '../src/browser-hub/wire.js';
import { AUTH, ask, lineTo, newDevice, newHub } from './browser-hub-support.js';

/** The records a device would push, as the wire carries them. */
function pushable(title: string): string {
  const { device, db } = newDevice('pusher');
  device.addTask(title);
  return JSON.stringify(db.changeLog.since(0, 100).map(({ entityId, rev, parentRev, deleted, state }) => ({ entityId, rev, parentRev, deleted, state })));
}
const post = (body: string, headers: Record<string, string> = { ...AUTH, 'content-type': 'application/json' }) => ({ method: 'POST', path: '/changes', headers, body });
const json = (body: string): unknown => JSON.parse(body);

describe('routes', () => {
  it('answers /health with plain text', () => {
    const { core } = newHub();
    const { got } = ask(core, { path: '/health' });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('text/plain');
    expect(got.body).toBe('ok');
    expect(got.ended).toBe(true);
  });

  it('answers /tasks with what the store holds, and it needs no token', () => {
    const { core, db } = newHub();
    expect(json(ask(core, { path: '/tasks' }).got.body)).toEqual([]);
    new DemoDevice('hub', db, 'hub://hub').addTask('Water the plants');
    const got = ask(core, { path: '/tasks' }).got;
    expect(got.headers['cache-control']).toBe('no-store');
    expect(json(got.body)).toMatchObject([{ title: 'Water the plants', done: false, origin: 'hub' }]);
    expect(core.tasks()).toHaveLength(1);
  });

  it.each([['/'], ['/nope'], ['/changes/extra'], ['/task']])('answers %s with 404', (path) => {
    const { core } = newHub();
    expect(ask(core, { path, headers: AUTH }).got.status).toBe(404);
  });

  it.each(['PUT', 'DELETE', 'PATCH'])('answers %s /changes with 404', (method) => {
    const { core } = newHub();
    expect(ask(core, { method, path: '/changes', headers: AUTH }).got.status).toBe(404);
  });

  it('counts the requests it answers', () => {
    const { core } = newHub();
    ask(core, { path: '/health' });
    ask(core, { path: '/nope' });
    expect(core.requests).toBe(2);
  });
});

describe('authentication', () => {
  it.each([
    ['no token', {}],
    ['a wrong token', { authorization: 'Bearer nope' }],
    ['the wrong scheme', { authorization: 'Basic typedblite-sync-demo' }],
  ])('refuses /changes with %s, for a read and a push', (_name, headers) => {
    const { core } = newHub();
    expect(ask(core, { path: '/changes', headers }).got.status).toBe(401);
    expect(ask(core, { method: 'POST', path: '/changes', headers: { ...headers, 'content-type': 'application/json' }, body: '[]' }).got.status).toBe(401);
    expect(core.openStreams).toBe(0);
  });

  it('takes the token it is given instead of the demo’s', () => {
    const { core } = newHub({ token: 'secret' });
    expect(ask(core, { path: '/changes', headers: AUTH }).got.status).toBe(401);
    const { got, cancel } = ask(core, { path: '/changes', headers: { authorization: 'Bearer secret' } });
    expect(got.status).toBe(200);
    cancel();
  });
});

describe('a push', () => {
  it('applies a batch, answers how many were new, and answers 0 when it is pushed again', () => {
    const { core } = newHub();
    const body = pushable('Book the room');
    expect(json(ask(core, post(body)).got.body)).toEqual({ applied: 1 });
    expect(json(ask(core, post(body)).got.body)).toEqual({ applied: 0 });
    expect(core.tasks()).toHaveLength(1);
  });

  it('accepts a content type with parameters, in any case', () => {
    const { core } = newHub();
    const got = ask(core, post(pushable('x'), { ...AUTH, 'content-type': 'Application/JSON; charset=utf-8' })).got;
    expect(got.status).toBe(200);
  });

  it.each([['text/plain'], ['']])('refuses a body that is %j with 415, whatever it holds', (type) => {
    const { core } = newHub();
    const got = ask(core, post(pushable('x'), type ? { ...AUTH, 'content-type': type } : AUTH)).got;
    expect(got.status).toBe(415);
    expect(json(got.body)).toEqual({ error: 'the body must be application/json' });
    expect(core.tasks()).toEqual([]);
  });

  it('refuses a body that is not JSON, and one that is not an array', () => {
    const { core } = newHub();
    expect(json(ask(core, post('{oops')).got.body)).toEqual({ error: 'the body is not valid JSON' });
    expect(ask(core, post('{oops')).got.status).toBe(400);
    expect(json(ask(core, post('{}')).got.body)).toEqual({ error: 'the body must be a JSON array of changes' });
    expect(ask(core, post('')).got.status).toBe(400);
  });

  it.each([
    ['a change that is not an object', '[1]', 'change 0 is not an object'],
    ['a null change', '[null]', 'change 0 is not an object'],
    ['an array for a change', '[[]]', 'change 0 is not an object'],
    ['no entityId', '[{"rev":"r","deleted":false}]', 'change 0 has an invalid entityId'],
    ['an empty entityId', '[{"entityId":"","rev":"r","deleted":false}]', 'change 0 has an invalid entityId'],
    ['no rev', '[{"entityId":"task/a","deleted":false}]', 'change 0 has an invalid rev'],
    ['a numeric rev', '[{"entityId":"task/a","rev":1,"deleted":false}]', 'change 0 has an invalid rev'],
    ['a string for deleted', '[{"entityId":"task/a","rev":"r","deleted":"no"}]', 'change 0 has an invalid deleted'],
    ['a numeric parentRev', '[{"entityId":"task/a","rev":"r","deleted":false,"parentRev":3}]', 'change 0 has an invalid parentRev'],
    ['an array for state', '[{"entityId":"task/a","rev":"r","deleted":false,"state":[]}]', 'change 0 has an invalid state'],
    ['a bad change after a good one', `[${(JSON.parse(pushable('ok')) as unknown[]).map((r) => JSON.stringify(r)).join(',')},3]`, 'change 1 is not an object'],
  ])('refuses %s with 400 that names the change', (_name, body, message) => {
    const { core } = newHub();
    const got = ask(core, post(body)).got;
    expect(got.status).toBe(400);
    expect(json(got.body)).toEqual({ error: message });
    expect(core.tasks()).toEqual([]);
  });

  it('takes a null parentRev and a null state', () => {
    const { core } = newHub();
    const records = JSON.parse(pushable('x')) as Array<Record<string, unknown>>;
    const got = ask(core, post(JSON.stringify(records.map((r) => ({ ...r, parentRev: null }))))).got;
    expect(got.status).toBe(200);
  });

  it('refuses a revision that is not derived from its content with 400, and applies none of the batch', () => {
    const { core } = newHub();
    const good = JSON.parse(pushable('good')) as Array<Record<string, unknown>>;
    const bad = { ...good[0], entityId: 'task/forged', rev: '1-abc' };
    const got = ask(core, post(JSON.stringify([...good, bad]))).got;
    expect(got.status).toBe(400);
    expect((json(got.body) as { error: string }).error).toMatch(/revision|derived/i);
    // All or none: the good record before the bad one was rolled back too.
    expect(core.tasks()).toEqual([]);
  });

  it('answers 500 "internal error" for a store that fails, tells the operator, and never the device', () => {
    const onError = vi.fn();
    const { core, db } = newHub({ onError });
    const body = pushable('x');
    db.close();
    const got = ask(core, post(body)).got;
    expect(got.status).toBe(500);
    expect(json(got.body)).toEqual({ error: 'internal error' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).not.toBe('');
  });
});

describe('the change stream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const seqOf = (body: string): number[] => [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

  it('opens an event stream and says it is caught up when there is nothing', () => {
    const { core } = newHub();
    const { got, cancel } = ask(core, { path: '/changes', headers: AUTH });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('text/event-stream');
    expect(got.headers['cache-control']).toBe('no-cache');
    expect(got.body).toBe(': caught-up\n\n');
    expect(got.ended).toBe(false); // an SSE response is one that never ends
    expect(core.openStreams).toBe(1);
    cancel();
  });

  it('sends each change as one frame whose id is its seq, then a caught-up marker on the next poll', () => {
    const { core, db } = newHub();
    new DemoDevice('hub', db, 'hub://hub').addTask('First');
    const { got, cancel } = ask(core, { path: '/changes', headers: AUTH });
    const frames = got.chunks.filter((c) => c.startsWith('id:'));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatch(/^id: \d+\nevent: change\ndata: \{.*\}\n\n$/);
    expect(seqOf(got.body)).toEqual(db.changeLog.since(0, 100).map((r) => r.seq));
    vi.advanceTimersByTime(200);
    expect(got.chunks.at(-1)).toBe(': caught-up\n\n');
    cancel();
  });

  it('delivers a change written after the stream opened, on the next poll', () => {
    const { core, db } = newHub();
    const { got, cancel } = ask(core, { path: '/changes', headers: AUTH });
    expect(seqOf(got.body)).toEqual([]);
    new DemoDevice('hub', db, 'hub://hub').addTask('Later');
    vi.advanceTimersByTime(200);
    expect(seqOf(got.body).length).toBeGreaterThan(0);
    // …and not again.
    const seen = seqOf(got.body).length;
    vi.advanceTimersByTime(1_000);
    expect(seqOf(got.body)).toHaveLength(seen);
    cancel();
  });

  it('polls at the interval it is given', () => {
    const { core, db } = newHub({ pollMs: 1_000 });
    const { got, cancel } = ask(core, { path: '/changes', headers: AUTH });
    new DemoDevice('hub', db, 'hub://hub').addTask('Slow');
    vi.advanceTimersByTime(999);
    expect(seqOf(got.body)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seqOf(got.body).length).toBeGreaterThan(0);
    cancel();
  });

  it('resumes after Last-Event-ID, or ?since=, and Last-Event-ID wins', () => {
    const { core, db } = newHub();
    const device = new DemoDevice('hub', db, 'hub://hub');
    device.addTask('One');
    device.addTask('Two');
    const all = db.changeLog.since(0, 100).map((r) => r.seq);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const last = all.at(-1)!;
    const first = all[0]!;

    const byHeader = ask(core, { path: '/changes', headers: { ...AUTH, 'last-event-id': String(first) } });
    expect(seqOf(byHeader.got.body)).toEqual(all.filter((s) => s > first));
    const byQuery = ask(core, { path: `/changes?since=${first}`, headers: AUTH });
    expect(seqOf(byQuery.got.body)).toEqual(all.filter((s) => s > first));
    const both = ask(core, { path: `/changes?since=${last}`, headers: { ...AUTH, 'last-event-id': String(first) } });
    expect(seqOf(both.got.body)).toEqual(all.filter((s) => s > first));
    const past = ask(core, { path: `/changes?since=${last}`, headers: AUTH });
    expect(seqOf(past.got.body)).toEqual([]);
    for (const { cancel } of [byHeader, byQuery, both, past]) cancel();
  });

  it('reads from the beginning when since is not a number', () => {
    const { core, db } = newHub();
    new DemoDevice('hub', db, 'hub://hub').addTask('One');
    const { got, cancel } = ask(core, { path: '/changes?since=banana', headers: AUTH });
    expect(seqOf(got.body)).toEqual(db.changeLog.since(0, 100).map((r) => r.seq));
    cancel();
  });

  it('stops a stream when it is cancelled: no timer, no more frames, and cancelling twice is harmless', () => {
    const { core, db } = newHub();
    const { got, cancel } = ask(core, { path: '/changes', headers: AUTH });
    expect(core.openStreams).toBe(1);
    cancel();
    cancel();
    expect(core.openStreams).toBe(0);
    new DemoDevice('hub', db, 'hub://hub').addTask('After');
    vi.advanceTimersByTime(1_000);
    expect(seqOf(got.body)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends every open stream on close()', () => {
    const { core } = newHub();
    ask(core, { path: '/changes', headers: AUTH });
    ask(core, { path: '/changes', headers: AUTH });
    expect(core.openStreams).toBe(2);
    core.close();
    expect(core.openStreams).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serves several streams at once, each from its own cursor', () => {
    const { core, db } = newHub();
    const a = ask(core, { path: '/changes', headers: AUTH });
    new DemoDevice('hub', db, 'hub://hub').addTask('Shared');
    const b = ask(core, { path: '/changes', headers: AUTH });
    vi.advanceTimersByTime(200);
    expect(seqOf(a.got.body)).toEqual(seqOf(b.got.body));
    a.cancel();
    expect(core.openStreams).toBe(1);
    b.cancel();
  });
});

describe('serving a MessagePort', () => {
  /** Collect what the hub sends on `port` until `until` says stop. */
  function listen(port: MessagePort): { messages: FromHub[]; next: (match: (m: FromHub) => boolean) => Promise<FromHub> } {
    const messages: FromHub[] = [];
    const waiters: Array<{ match: (m: FromHub) => boolean; resolve: (m: FromHub) => void }> = [];
    port.onmessage = (event: MessageEvent<FromHub>) => {
      messages.push(event.data);
      for (const [i, waiter] of waiters.entries()) {
        if (waiter.match(event.data)) {
          waiters.splice(i, 1);
          waiter.resolve(event.data);
          break;
        }
      }
    };
    return {
      messages,
      next: (match) => {
        const found = messages.find(match);
        return found ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ match, resolve }));
      },
    };
  }
  const closeAll = (...ports: MessagePort[]): void => ports.forEach((p) => p.close());

  it('answers a request with a head, its chunks and an end, tagged with the request id', async () => {
    const { core } = newHub();
    const { port, server } = lineTo(core);
    const heard = listen(port);
    port.postMessage({ type: 'request', id: 7, method: 'GET', path: '/health', headers: {} });
    await heard.next((m) => m.type === 'end');
    expect(heard.messages).toEqual([
      { type: 'head', id: 7, status: 200, headers: { 'content-type': 'text/plain' } },
      { type: 'chunk', id: 7, data: 'ok' },
      { type: 'end', id: 7 },
    ]);
    closeAll(port, server);
  });

  it('cancels a stream on request, and a cancel for a request it does not know is ignored', async () => {
    const { core } = newHub();
    const { port, server } = lineTo(core);
    const heard = listen(port);
    port.postMessage({ type: 'request', id: 1, method: 'GET', path: '/changes', headers: AUTH });
    await heard.next((m) => m.type === 'chunk');
    expect(core.openStreams).toBe(1);
    port.postMessage({ type: 'cancel', id: 99 });
    port.postMessage({ type: 'cancel', id: 1 });
    port.postMessage({ type: 'info' });
    await heard.next((m) => m.type === 'info');
    expect(core.openStreams).toBe(0);
    closeAll(port, server);
  });

  it('answers the page: the tasks, and the hub’s info', async () => {
    const { core, db } = newHub();
    new DemoDevice('hub', db, 'hub://hub').addTask('Shown');
    const { port, server } = lineTo(core, 4);
    const heard = listen(port);
    port.postMessage({ type: 'tasks' });
    port.postMessage({ type: 'info' });
    const tasks = await heard.next((m) => m.type === 'tasks');
    const info = await heard.next((m) => m.type === 'info');
    expect(tasks).toMatchObject({ tasks: [{ title: 'Shown' }] });
    expect(info).toMatchObject({ info: { state: 'open', peers: 4, requests: 0, openStreams: 0, openAttempts: 1 } });
    closeAll(port, server);
  });

  it('holds a request until the store is open', async () => {
    const { core } = newHub();
    let open!: () => void;
    const ready = new Promise<typeof core>((resolve) => (open = () => resolve(core)));
    const { port, server } = lineTo(ready);
    const heard = listen(port);
    port.postMessage({ type: 'request', id: 1, method: 'GET', path: '/health', headers: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heard.messages).toEqual([]);
    open();
    await heard.next((m) => m.type === 'end');
    expect(heard.messages[0]).toMatchObject({ type: 'head', status: 200 });
    closeAll(port, server);
  });

  it('answers 503 when the store could not open, and says so to the page', async () => {
    const channel = new MessageChannel();
    const failed = Promise.reject(new Error('no store'));
    failed.catch(() => undefined); // the hub's own `ready.catch`; serveHubPort awaits it again
    serveHubPort(channel.port2 as unknown as MessagePort, failed as never, () => ({ state: 'failed', openError: 'NoModificationAllowedError: held', openedAt: '', openAttempts: 40 }), () => 1);
    const port = channel.port1 as unknown as MessagePort;
    const heard = listen(port);
    port.postMessage({ type: 'request', id: 3, method: 'GET', path: '/changes', headers: AUTH });
    port.postMessage({ type: 'tasks' });
    port.postMessage({ type: 'info' });
    const info = await heard.next((m) => m.type === 'info');
    await heard.next((m) => m.type === 'end');
    expect(heard.messages.find((m) => m.type === 'head')).toMatchObject({ id: 3, status: 503 });
    expect(heard.messages.find((m) => m.type === 'chunk')).toMatchObject({ data: expect.stringContaining('could not open') });
    expect(heard.messages.find((m) => m.type === 'tasks')).toEqual({ type: 'tasks', tasks: [] });
    expect(info).toMatchObject({ info: { state: 'failed', openError: 'NoModificationAllowedError: held', requests: 0 } });
    closeAll(port, channel.port2 as unknown as MessagePort);
  });
});
