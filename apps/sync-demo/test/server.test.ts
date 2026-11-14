/**
 * The demo server's HTTP surface: the API the control page drives, the files it serves, and what a
 * device sees through its switchboard link when the link or the hub is down.
 *
 * `smoke.test.ts` drives the same server through its methods, as the demo driver does. This drives
 * it over HTTP, as the control page and the devices do. The server forks the real hub from
 * `out/hub/main.js`, which `test` builds first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDemoServer, type DemoServer } from '../src/server/server.js';

let root: string;
let server: DemoServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'sync-demo-server-'));
  const client = join(root, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'index.html'), '<title>client</title>');
  writeFileSync(join(client, 'app.js'), 'export {};');
  server = await startDemoServer({ port: 0, hubPort: 0, dataDir: join(root, 'hub'), clientDir: client, log: () => undefined });
});

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const call = (path: string, method = 'GET') => fetch(`${server.url}${path}`, { method });
const state = async () => (await call('/api/state')).json() as Promise<{ hub: { running: boolean; tasks?: unknown[] }; links: Record<string, boolean>; story: { paused: boolean } }>;

describe('the control API', () => {
  it('reports the hub, its tasks, every link and the story', async () => {
    expect(await state()).toEqual({
      hub: { running: true, tasks: [] },
      links: { pwa: true, electron: true, android: true },
      story: { active: false, paused: false },
    });
  });

  it('pauses, plays and toggles the story', async () => {
    expect(await (await call('/api/story/pause', 'POST')).json()).toEqual({ story: { active: false, paused: true } });
    expect(await (await call('/api/story/toggle', 'POST')).json()).toEqual({ story: { active: false, paused: false } });
    expect(await (await call('/api/story/toggle', 'POST')).json()).toEqual({ story: { active: false, paused: true } });
    expect(await (await call('/api/story/play', 'POST')).json()).toEqual({ story: { active: false, paused: false } });
  });

  it('answers a control route only for its method', async () => {
    expect((await call('/api/story/pause')).status).toBe(404);
  });

  it('cuts a link: a device behind it reaches nothing, until the link is up again', async () => {
    expect((await (await call('/api/link/pwa/down', 'POST')).json()).links.pwa).toBe(false);
    await expect(call('/net/pwa/hub/tasks')).rejects.toThrow();
    expect((await (await call('/api/link/pwa/up', 'POST')).json()).links.pwa).toBe(true);
    expect((await call('/net/pwa/hub/tasks')).status).toBe(200);
  });

  it('stops the hub: the state says so, and a device through its link gets a 502, until it starts again', async () => {
    expect(await (await call('/api/hub/stop', 'POST')).json()).toEqual({ running: false });
    expect((await state()).hub).toEqual({ running: false });
    const refused = await call('/net/electron/hub/tasks');
    expect(refused.status).toBe(502);
    expect(await refused.text()).toBe('the hub cannot be reached');
    expect(await (await call('/api/hub/start', 'POST')).json()).toEqual({ running: true });
    expect((await state()).hub.running).toBe(true);
  });
});

describe('the files it serves', () => {
  it('serves the control page, and the client build with each file’s type, uncached', async () => {
    const control = await call('/control');
    expect(control.status).toBe(200);
    expect(control.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const index = await call('/');
    expect(await index.text()).toBe('<title>client</title>');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect((await call('/app.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('answers 404 for a file the client build does not have', async () => {
    const missing = await call('/missing.png');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('not found');
  });
});
