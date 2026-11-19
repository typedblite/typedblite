import 'reflect-metadata';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loopbackOnly } from '../src/http.js';
import { runApi } from '../src/main.js';

let app: INestApplication;
let base: string;
let port: number;

beforeEach(async () => {
  vi.stubEnv('TYPEDBLITE_HOST_PORT', '0');
  app = await runApi();
  port = (app.getHttpServer().address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/api/typedblite-host`;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

const post = async (operation: string, body: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}/ops/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

/** A request with a `Host` header of our choosing, which `fetch` will not send. */
const withHost = (host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/typedblite-host/help', headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

describe('HTTP', () => {
  // 🔴 `defineApp` calls `listen(port)`, which binds every interface. Nest's application is a Proxy that silently
  // discards `app.listen = …`, so a patch there looks right and leaves the host open to the network.
  it('listens on the loopback address and nothing else', () => {
    expect(app.getHttpServer().address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  it('lists the operations at /help', async () => {
    const body = (await (await fetch(`${base}/help`)).json()) as { operations: { name: string }[] };
    const names = body.operations.map((operation) => operation.name);
    expect(names).toContain('session.run');
    expect(names).toHaveLength(12);
  });

  it('dispatches any operation through one route, and keeps a session across requests', async () => {
    const opened = await post('session.open', { schema: 'define attribute name, value string; entity person, owns name;' });
    expect(opened).toMatchObject({ status: 200, body: { id: 's1', hasSchema: true } });

    await post('session.run', { session: 's1', statement: 'insert $p isa person, has name "Ada";' });
    const read = await post('session.run', { session: 's1', statement: 'match $p isa person, has name $n; select $n;' });
    expect(read).toMatchObject({ status: 200, body: { kind: 'rows', rows: [{ n: 'Ada' }] } });
    expect((await post('session.list', {})).body).toHaveLength(1);
  });

  it('answers an engine refusal as a 200 with the refusal as data, as the CLI exits 0', async () => {
    await post('session.open', { schema: 'define entity a;' });
    expect(await post('session.run', { session: 's1', statement: 'insert $x isa nonexistent-type;' })).toMatchObject({
      status: 200,
      body: { kind: 'refused', reason: 'engine' },
    });
  });

  it('maps a fault to the status its exit code means, with a code to branch on', async () => {
    expect(await post('session.get', { session: 's9' })).toMatchObject({ status: 404, body: { code: 'SESSION_NOT_FOUND' } });
    expect(await post('session.run', { statement: 'x' })).toMatchObject({ status: 400, body: { code: 'INVALID_INPUT' } });
    expect(await post('session.get', { session: 's1', extra: 1 })).toMatchObject({ status: 400, body: { code: 'INVALID_INPUT' } });
    expect(await post('no.such.operation', {})).toMatchObject({ status: 404, body: { code: 'UNKNOWN_OPERATION' } });
  });

  it('treats a body that is not an object as no input, and stays up', async () => {
    expect(await post('session.get', [1, 2])).toMatchObject({ status: 400 });
    expect(await post('session.list', {})).toMatchObject({ status: 200 });
  });
});

describe('the loopback fence', () => {
  it('answers a request that names a host other than loopback with 403 (DNS rebinding)', async () => {
    expect(await withHost('evil.example')).toBe(403);
    expect(await withHost(`evil.example:${port}`)).toBe(403);
    expect(await withHost(`localhost:${port}`)).toBe(200);
    expect(await withHost(`127.0.0.1:${port}`)).toBe(200);
  });

  it.each([
    ['127.0.0.1', '127.0.0.1:3470', true],
    ['::1', '[::1]:3470', true],
    ['::ffff:127.0.0.1', 'localhost', true],
    ['192.168.1.20', '127.0.0.1:3470', false],
    ['10.0.0.5', 'localhost', false],
    ['127.0.0.1', '192.168.1.20:3470', false],
    ['127.0.0.1', 'localhost.evil.example', false],
    ['127.0.0.1', '', false],
    [undefined, 'localhost', false],
  ])('peer %s, Host %j: allowed %s', (peer, host, allowed) => {
    const next = vi.fn();
    loopbackOnly({ socket: { remoteAddress: peer }, headers: { host } }, undefined, next);
    expect(next).toHaveBeenCalledTimes(1);
    const argument = next.mock.calls[0]![0];
    if (allowed) expect(argument).toBeUndefined();
    else expect(argument).toMatchObject({ status: 403 });
  });
});
