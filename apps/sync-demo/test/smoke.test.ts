/**
 * `nx run sync-demo:smoke` — the demo's story, headless: three devices, a real hub process, and the
 * real switchboard, driven through every network event the windowed demo shows. Each step passes
 * because every store and the hub hold the same tasks, never because time went by.
 *
 * The devices here run the same `DemoDevice` as the browser client, on `node:sqlite` files instead
 * of WASM SQLite and OPFS — which is the point of a platform-neutral device.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';

import { DemoDevice } from '../src/shared/device.js';
import type { Task } from '../src/shared/schema.js';
import { startDemoServer, type DemoServer } from '../src/server/server.js';

let root: string;
let server: DemoServer;
const devices = new Map<string, { device: DemoDevice; db: TypeDBLiteInterpreter }>();

function open(name: string, cursor?: DemoDevice['state'] extends () => infer S ? S extends { cursor: infer C } ? C : never : never): DemoDevice {
  const db = new TypeDBLiteInterpreter(join(root, `${name}.db`));
  const device = new DemoDevice(name, db, `${server.url}/net/${name}/hub`, { cursor, timeoutMs: 3_000 });
  devices.set(name, { device, db });
  return device;
}

const device = (name: string): DemoDevice => devices.get(name)!.device;
const fingerprint = (tasks: readonly Task[]): string => JSON.stringify(tasks.map((t) => [t.id, t.title, t.done]));

async function hubTasks(): Promise<Task[] | undefined> {
  const state = (await (await fetch(`${server.url}/api/state`)).json()) as { hub: { tasks?: Task[] } };
  return state.hub.tasks;
}

/** Sync `names` until they and the hub agree, and return what they agree on. */
async function converge(names: readonly string[], rounds = 12): Promise<Task[]> {
  for (let round = 0; round < rounds; round++) {
    for (const name of names) await device(name).syncOnce();
    const hub = await hubTasks();
    const views = names.map((name) => fingerprint(device(name).tasks()));
    if (hub && views.every((view) => view === fingerprint(hub))) return hub;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const detail = names.map((name) => `${name}: ${fingerprint(device(name).tasks())}`).join('\n');
  throw new Error(`did not converge:\nhub: ${fingerprint((await hubTasks()) ?? [])}\n${detail}`);
}

const titles = (tasks: readonly Task[]): string[] => tasks.map((task) => task.title).sort();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'typedblite-sync-smoke-'));
  server = await startDemoServer({ port: 0, hubPort: 0, dataDir: join(root, 'hub'), log: () => undefined });
  for (const name of ['pwa', 'electron', 'android']) open(name);
}, 30_000);

afterAll(async () => {
  for (const { db } of devices.values()) db.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the sync demo, headless', () => {
  it('1. three devices, one hub: one task each, and all converge on three', async () => {
    device('pwa').addTask('Confirm meeting room');
    device('electron').addTask('Send the agenda');
    device('android').addTask('Print the one-pager');
    const tasks = await converge(['pwa', 'electron', 'android']);
    assert.deepEqual(titles(tasks), ['Confirm meeting room', 'Print the one-pager', 'Send the agenda']);
  });

  it('2. write anywhere: a task added on one device reaches the others', async () => {
    device('pwa').addTask('Book the taxi');
    const tasks = await converge(['pwa', 'electron', 'android']);
    assert.ok(titles(tasks).includes('Book the taxi'));
  });

  it('3. edit elsewhere: completing it on another device completes it everywhere', async () => {
    const taxi = device('electron').tasks().find((task) => task.title === 'Book the taxi')!;
    device('electron').setDone(taxi.id, true);
    const tasks = await converge(['pwa', 'electron', 'android']);
    assert.equal(tasks.find((task) => task.id === taxi.id)?.done, true);
  });

  it('4. a device loses its link: it keeps working, its changes wait, and it misses the others', async () => {
    server.setLink('electron', false);
    device('electron').addTask('Draft the follow-up');
    device('electron').addTask('Collect the slides');
    const taxi = device('electron').tasks().find((task) => task.title === 'Book the taxi')!;
    device('electron').setDone(taxi.id, false);
    assert.equal(device('electron').pending(), 3, 'three tasks changed and not yet sent');

    device('android').addTask('Order lunch');
    await converge(['pwa', 'android']);
    assert.equal(await device('electron').syncOnce(), undefined, 'the sync fails');
    assert.equal(device('electron').state().online, false);
    assert.ok(!titles(device('electron').tasks()).includes('Order lunch'));
    assert.equal(device('electron').pending(), 3, 'still waiting');
  });

  it('5. the link comes back: the journal replays, and everyone converges', async () => {
    server.setLink('electron', true);
    const tasks = await converge(['pwa', 'electron', 'android']);
    assert.equal(device('electron').pending(), 0);
    for (const title of ['Draft the follow-up', 'Collect the slides', 'Order lunch']) assert.ok(titles(tasks).includes(title), title);
    assert.equal(tasks.find((task) => task.title === 'Book the taxi')?.done, false, 'reopened on electron, everywhere');
  });

  it('6. the hub goes down: every device is offline, and keeps writing', async () => {
    await server.stopHub();
    device('pwa').addTask('Written while the hub was down (pwa)');
    device('android').addTask('Written while the hub was down (android)');
    for (const name of ['pwa', 'electron', 'android']) {
      assert.equal(await device(name).syncOnce(), undefined, `${name} must not report itself in sync`);
      assert.equal(device(name).state().online, false, name);
      assert.match(device(name).state().lastError ?? '', /502|cannot be reached|fail/i, name);
    }
    assert.equal(device('pwa').pending(), 1);
  });

  it('7. the hub comes back: everyone replays and converges, and the hub kept its store', async () => {
    await server.startHub();
    const tasks = await converge(['pwa', 'electron', 'android']);
    assert.equal(tasks.length, 9);
    assert.ok(titles(tasks).includes('Confirm meeting room'), 'what the hub held before it went down');
  });

  it('8. a device restarts while offline: its store and its journal survive, then converge', async () => {
    server.setLink('pwa', false);
    const before = device('pwa').state();
    devices.get('pwa')!.db.close();
    open('pwa', before.cursor);
    assert.equal(device('pwa').tasks().length, 9, 'the store survived the restart');
    device('pwa').addTask('Written after a restart, offline');
    assert.equal(device('pwa').pending(), 1, 'the journal is the change log, and the cursor was kept');
    server.setLink('pwa', true);
    const tasks = await converge(['pwa', 'electron', 'android']);
    assert.ok(titles(tasks).includes('Written after a restart, offline'));
  });
});
