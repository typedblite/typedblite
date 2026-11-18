/**
 * The in-browser hub end to end, in Node: real devices (`DemoDevice`, the class the browser runs) replicating with
 * a real hub core through the real wire shim, over `MessageChannel`s. The shim is global, so one line serves one
 * device at a time and each sync switches it, which is also how the page switches a device's line.
 *
 * And the claim the feature rests on, checked directly: the same scenario against the Node hub
 * (`serveChangeStream`, what `src/hub/main.ts` serves) ends in the same place.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveChangeStream, TypeDBLiteInterpreter } from '@typedblite/runtime';

import { DemoDevice } from '../src/shared/device.js';
import { readTasks, type Task } from '../src/shared/schema.js';
import { createHubCore, serveHubPort, type HubCore } from '../src/browser-hub/hub-core.js';
import { installHubFetch } from '../src/browser-hub/wire.js';
import { lineTo, newDevice, newStore } from './browser-hub-support.js';

const realFetch = globalThis.fetch;
const shim = installHubFetch();
afterAll(() => {
  shim.setPort(null);
  globalThis.fetch = realFetch;
});

let hubDb: TypeDBLiteInterpreter;
let core: HubCore;
const lines: MessagePort[] = [];
const devices = new Map<string, DemoDevice>();
const stores = new Map<string, TypeDBLiteInterpreter>();

beforeEach(() => {
  hubDb = newStore();
  core = createHubCore(hubDb, { pollMs: 20 });
});
afterEach(() => {
  core.close();
  shim.setPort(null);
  for (const port of lines.splice(0)) port.close();
  devices.clear();
  stores.clear();
});

function device(name: string): DemoDevice {
  let existing = devices.get(name);
  if (!existing) {
    const made = newDevice(name);
    existing = made.device;
    devices.set(name, existing);
    stores.set(name, made.db);
  }
  return existing;
}

/** Sync `name` through a fresh line to the hub, or through none (the line is cut). */
async function sync(name: string, connected = true): Promise<number | undefined> {
  if (connected) {
    const { port, server } = lineTo(core);
    lines.push(port, server);
    shim.setPort(port);
  } else shim.setPort(null);
  return device(name).syncOnce();
}

/** Round-robin until every device and the hub agree. */
async function converge(names: string[], rounds = 6): Promise<Task[]> {
  for (let i = 0; i < rounds; i++) for (const name of names) await sync(name);
  return core.tasks() as Task[];
}
const view = (tasks: readonly Task[]): string => JSON.stringify(tasks.map((t) => [t.title, t.done]).sort());
const titles = (tasks: readonly Task[]): string[] => tasks.map((t) => t.title).sort();

describe('devices through the hub', () => {
  it('delivers a task from one device to the others, and to the hub', async () => {
    device('a').addTask('Book the room');
    expect(await sync('a')).toBeGreaterThanOrEqual(0);
    await sync('b');
    await sync('c');
    for (const name of ['a', 'b', 'c']) expect(titles(device(name).tasks())).toEqual(['Book the room']);
    expect(titles(core.tasks() as Task[])).toEqual(['Book the room']);
  });

  it('reports the sync as online, with no error, and the time', async () => {
    await sync('a');
    expect(device('a').state()).toMatchObject({ online: true, lastError: undefined, pending: 0 });
    expect(device('a').state().lastSyncedAt).toBeDefined();
  });

  it('carries a completed task, and an edit made elsewhere reaches the device that made the task', async () => {
    device('a').addTask('Send invoice');
    await converge(['a', 'b']);
    const id = device('b').tasks()[0]!.id;
    device('b').setDone(id, true);
    await converge(['a', 'b']);
    expect(device('a').tasks()[0]).toMatchObject({ id, done: true });
  });

  it('keeps the origin of a task and every device’s own copy identical', async () => {
    device('a').addTask('From A');
    device('b').addTask('From B');
    device('c').addTask('From C');
    await converge(['a', 'b', 'c']);
    const hub = core.tasks() as Task[];
    expect(hub.map((t) => t.origin).sort()).toEqual(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) expect(view(device(name).tasks())).toBe(view(hub));
  });

  it('carries text that is not ASCII across the wire intact', async () => {
    device('a').addTask('Café ☕ 日本語 🚀');
    await converge(['a', 'b']);
    expect(titles(device('b').tasks())).toEqual(['Café ☕ 日本語 🚀']);
  });

  it('resumes from its cursor: a second sync pulls nothing and pushes nothing', async () => {
    device('a').addTask('Once');
    await sync('a');
    await sync('b');
    expect(await sync('b')).toBe(0);
    expect(device('b').pending()).toBe(0);
  });
});

describe('a cut line', () => {
  it('shows the device offline with the no-network error, and keeps its writes locally and counted', async () => {
    await sync('a');
    expect(await sync('a', false)).toBeUndefined();
    expect(device('a').state()).toMatchObject({ online: false, lastError: 'Failed to fetch' });
    device('a').addTask('While offline');
    device('a').addTask('Also offline');
    expect(device('a').pending()).toBe(2);
    expect(titles(device('a').tasks())).toEqual(['Also offline', 'While offline']);
    expect(core.tasks()).toEqual([]);
  });

  it('converges everything written offline when the lines come back', async () => {
    device('a').addTask('Shared before');
    await converge(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) await sync(name, false);
    device('a').addTask('Offline on A');
    device('b').addTask('Offline on B');
    device('c').addTask('Offline on C');
    for (const name of ['a', 'b', 'c']) expect(device(name).pending()).toBeGreaterThan(0);
    const all = await converge(['a', 'b', 'c']);
    expect(titles(all)).toEqual(['Offline on A', 'Offline on B', 'Offline on C', 'Shared before']);
    for (const name of ['a', 'b', 'c']) {
      expect(view(device(name).tasks())).toBe(view(all));
      expect(device(name).pending()).toBe(0);
      expect(device(name).state().online).toBe(true);
    }
  });

  it('settles an edit made to one task on two devices at once, the same everywhere', async () => {
    device('a').addTask('Contested');
    await converge(['a', 'b']);
    const id = device('a').tasks()[0]!.id;
    await sync('a', false);
    await sync('b', false);
    device('a').setDone(id, true);
    device('b').setDone(id, false);
    const all = await converge(['a', 'b', 'c']);
    expect(all).toHaveLength(1);
    expect(view(device('a').tasks())).toBe(view(all));
    expect(view(device('b').tasks())).toBe(view(all));
    expect(view(device('c').tasks())).toBe(view(all));
  });

  it('one device being cut does not stop the others syncing with the hub', async () => {
    await sync('c', false);
    device('a').addTask('Reaches B');
    await sync('a');
    await sync('b');
    expect(titles(device('b').tasks())).toEqual(['Reaches B']);
    expect(device('c').tasks()).toEqual([]);
    await sync('c');
    expect(titles(device('c').tasks())).toEqual(['Reaches B']);
  });
});

describe('the hub going away and coming back', () => {
  it('shows every device offline while the hub is down, and recovers on the same store when it is back', async () => {
    device('a').addTask('Before the outage');
    await converge(['a', 'b']);
    // The hub is killed: nothing is flushed or closed; its streams end and the lines are gone.
    core.close();
    for (const name of ['a', 'b']) await sync(name, false);
    expect(device('a').state().online).toBe(false);
    device('b').addTask('During the outage');
    // A new hub over the same store: what it held is still there.
    core = createHubCore(hubDb, { pollMs: 20 });
    expect(titles(core.tasks() as Task[])).toEqual(['Before the outage']);
    const all = await converge(['a', 'b']);
    expect(titles(all)).toEqual(['Before the outage', 'During the outage']);
    expect(titles(device('a').tasks())).toEqual(['Before the outage', 'During the outage']);
  });

  it('refuses a device whose token the hub does not know, and the device shows it as offline with the reason', async () => {
    core.close();
    core = createHubCore(hubDb, { pollMs: 20, token: 'another-token' });
    expect(await sync('a')).toBeUndefined();
    expect(device('a').state()).toMatchObject({ online: false });
    expect(device('a').state().lastError).toMatch(/401/);
  });

  it('shows a hub that cannot open its store as offline, never as in sync', async () => {
    const channel = new MessageChannel();
    const failed = Promise.reject(new Error('no store'));
    failed.catch(() => undefined);
    serveHubPort(channel.port2 as unknown as MessagePort, failed as never, () => ({ state: 'failed', openError: 'x', openedAt: '', openAttempts: 40 }), () => 1);
    lines.push(channel.port1 as unknown as MessagePort, channel.port2 as unknown as MessagePort);
    shim.setPort(channel.port1 as unknown as MessagePort);
    device('a').addTask('Stuck');
    expect(await device('a').syncOnce()).toBeUndefined();
    expect(device('a').state()).toMatchObject({ online: false });
    expect(device('a').state().lastError).toMatch(/503/);
    expect(device('a').pending()).toBe(1);
  });
});

describe('the same as the Node hub', () => {
  /** What a scenario leaves behind, with nothing in it that differs between two runs (ids, times). */
  interface Outcome {
    tasks: string;
    hubChanges: number;
    perDevice: Record<string, string>;
    applied: Array<number | undefined>;
  }

  /** One story, told to whichever hub `syncDevice` reaches: three devices write, edit and converge. */
  async function scenario(
    deviceFor: (name: string) => DemoDevice,
    syncDevice: (name: string) => Promise<number | undefined>,
    hub: { tasks: () => Task[]; changes: () => number },
  ): Promise<Outcome> {
    const names = ['a', 'b', 'c'];
    const applied: Array<number | undefined> = [];
    const round = async (times: number): Promise<void> => {
      for (let i = 0; i < times; i++) for (const name of names) applied.push(await syncDevice(name));
    };
    await round(1);
    deviceFor('a').addTask('One');
    deviceFor('a').addTask('Two');
    deviceFor('b').addTask('Three');
    await round(3);
    deviceFor('c').setDone(deviceFor('c').tasks().find((task) => task.title === 'Two')!.id, true);
    await round(3);
    return {
      tasks: view(hub.tasks()),
      hubChanges: hub.changes(),
      perDevice: Object.fromEntries(names.map((name) => [name, view(deviceFor(name).tasks())])),
      applied,
    };
  }

  it('ends in the same tasks, on the hub and on every device, with the same changes, as the Node hub does', async () => {
    // The in-browser hub, through the wire.
    const inBrowser = await scenario(device, sync, { tasks: () => core.tasks() as Task[], changes: () => hubDb.changeLog.since(0, 10_000).length });

    // The Node hub, over HTTP: what `src/hub/main.ts` serves (it adds the token check, which has its own tests above).
    const nodeDb = newStore();
    const served = serveChangeStream(nodeDb.changeLog, { pollMs: 20 });
    const url = `http://127.0.0.1:${await served.port}`;
    try {
      const nodeDevices = new Map<string, DemoDevice>();
      const nodeDevice = (name: string): DemoDevice => {
        if (!nodeDevices.has(name)) nodeDevices.set(name, new DemoDevice(name, newStore(), url, { timeoutMs: 3_000 }));
        return nodeDevices.get(name)!;
      };
      const onNode = await scenario(nodeDevice, (name) => nodeDevice(name).syncOnce(), { tasks: () => readTasks(nodeDb), changes: () => nodeDb.changeLog.since(0, 10_000).length });

      expect(inBrowser.tasks).toBe(onNode.tasks);
      expect(inBrowser.hubChanges).toBe(onNode.hubChanges);
      expect(inBrowser.perDevice).toEqual(onNode.perDevice);
      expect(inBrowser.applied).toEqual(onNode.applied);
      expect(JSON.parse(inBrowser.tasks)).toEqual([['One', false], ['Three', false], ['Two', true]]);
    } finally {
      await served.close();
    }
  });
});
