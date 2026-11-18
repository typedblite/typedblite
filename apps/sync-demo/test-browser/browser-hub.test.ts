/**
 * `nx run sync-demo:test-browser` — the in-browser hub in a real Chromium: one page that owns the hub (a dedicated
 * Worker on WASM SQLite and OPFS) and embeds three devices, each its own Worker and its own OPFS store.
 *
 * The page is served under `/nested/sync-demo/`, not `/`, so that every test also proves it works from any path, as
 * the website needs. Each `describe` opens its own browser context, so its OPFS is its own and starts empty; the
 * tests inside one `describe` build on each other, in order, as `pwa.test.ts` does.
 *
 * Needs the build (`nx run sync-demo:build-browser`) and Playwright's Chromium (`npx playwright-core install chromium`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core';
import { fileURLToPath } from 'node:url';

import { startStaticServer, type StaticServer } from '../src/browser-hub/static-server.js';
import type { Task } from '../src/shared/schema.js';

const BUILD = fileURLToPath(new URL('../.build-browser', import.meta.url));
type DeviceState = { tasks: Task[]; pending: number; online?: boolean; lastError?: string; lastSyncedAt?: string };
type HubState = { up: boolean; info?: { state: string; openError: string; openAttempts: number; peers: number; requests: number }; tasks: Array<{ title: string; done: boolean; origin: string }> };

let browser: Browser;
let site: StaticServer;
let root: StaticServer;

beforeAll(async () => {
  site = await startStaticServer(BUILD, { prefix: '/nested/sync-demo' });
  root = await startStaticServer(BUILD);
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await site?.close();
  await root?.close();
});

/** Everything a page logged that a user would have seen go wrong. */
interface Problems {
  errors: string[];
}
function watch(page: Page): Problems {
  const problems: Problems = { errors: [] };
  page.on('console', (message) => message.type() === 'error' && problems.errors.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => problems.errors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => problems.errors.push(`request failed: ${request.url()}`));
  page.on('response', (response) => response.status() >= 400 && problems.errors.push(`${response.status()}: ${response.url()}`));
  return problems;
}

const NAMES = ['a', 'b', 'c'] as const;
const frame = (page: Page, name: string): Frame => {
  const found = page.frames().find((candidate) => new URL(candidate.url()).searchParams.get('device') === name);
  if (!found) throw new Error(`no frame for device ${name}`);
  return found;
};
const device = (page: Page, name: string): Promise<DeviceState> => frame(page, name).evaluate(() => (window as unknown as { typedbliteDemo: { state(): DeviceState } }).typedbliteDemo.state());
const hub = (page: Page): Promise<HubState> => page.evaluate(() => (window as unknown as { browserHub: { state(): HubState } }).browserHub.state());
const titles = async (page: Page, name: string): Promise<string[]> => (await device(page, name)).tasks.map((task) => task.title).sort();
const online = async (page: Page, names: readonly string[] = NAMES): Promise<boolean> => (await Promise.all(names.map((name) => device(page, name)))).every((state) => state.online === true);
const offline = async (page: Page, names: readonly string[] = NAMES): Promise<boolean> => (await Promise.all(names.map((name) => device(page, name)))).every((state) => state.online === false);
const status = (page: Page, name: string): Promise<string> => frame(page, name).locator('#status').innerText();

/** Poll until `check` is true; the failure says what was being waited for, and the last error `check` threw. */
async function until(message: string, check: () => Promise<boolean>, timeout = 20_000): Promise<void> {
  const end = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      if (await check()) return;
      last = undefined;
    } catch (error) {
      last = error; // a frame or a page that is not there yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${message}${last ? ` (${String(last).split('\n')[0]})` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function open(context: BrowserContext, server: StaticServer = site): Promise<{ page: Page; problems: Problems }> {
  const page = await context.newPage();
  const problems = watch(page);
  await page.goto(server.url);
  await until('all three devices online', () => online(page), 30_000);
  return { page, problems };
}

async function add(page: Page, name: string, title: string): Promise<void> {
  await frame(page, name).fill('#title', title);
  await frame(page, name).press('#title', 'Enter');
}
const everyDeviceHas = (page: Page, title: string) => async (): Promise<boolean> => (await Promise.all(NAMES.map((name) => titles(page, name)))).every((list) => list.includes(title));

describe('the page', () => {
  let context: BrowserContext;
  let page: Page;
  let problems: Problems;
  beforeAll(async () => {
    context = await browser.newContext();
    ({ page, problems } = await open(context));
  }, 60_000);
  afterAll(() => context?.close());

  it('is served under a path, not the root, and finds everything it needs there', async () => {
    expect(new URL(page.url()).pathname).toBe('/nested/sync-demo/');
    expect(problems.errors).toEqual([]);
    expect(page.frames().filter((f) => f.url().includes('/nested/sync-demo/device.html'))).toHaveLength(3);
  });

  it('needs no cross-origin isolation: no COOP/COEP headers, and OPFS persistence still works', async () => {
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    await until('the hub reports its store open', async () => (await hub(page)).info?.state === 'open');
  });

  it('starts the hub on a store in OPFS, in a dedicated Worker, and shows it', async () => {
    await until('the hub panel says it is up', async () => (await page.locator('#bh-state').innerText()) === 'Hub up');
    expect(await page.locator('#bh-info').innerText()).toMatch(/Store open on OPFS, in a dedicated Worker · \d+ connections/);
    expect((await hub(page)).info?.peers).toBe(4); // the panel and three devices
    expect(await page.locator('#bh-count').innerText()).toBe('0');
    expect(await page.locator('#bh-alert').isHidden()).toBe(true);
  });

  it('shows each device online, named, with its own Disconnect switch and an empty list', async () => {
    for (const [name, label] of [['a', 'Device A'], ['b', 'Device B'], ['c', 'Device C']] as const) {
      const f = frame(page, name);
      expect(await f.locator('#device').innerText()).toBe(label);
      expect(await f.locator('#status').innerText()).toBe('Online · in sync');
      expect(await f.locator('#link').innerText()).toBe('Disconnect');
      expect(await f.locator('#link').getAttribute('aria-pressed')).toBe('false');
      expect(await f.locator('#empty').isVisible()).toBe(true);
    }
  });

  it('stores each device in its own OPFS pool and the hub in another', async () => {
    const names = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const found: string[] = [];
      for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) found.push(name);
      return found.sort();
    });
    for (const pool of ['typedblite-browser-hub', 'typedblite-browser-hub-a', 'typedblite-browser-hub-b', 'typedblite-browser-hub-c']) expect(names).toContain(pool);
  });

  it('logged no error while it ran', () => {
    expect(problems.errors).toEqual([]);
  });
});

describe('syncing', () => {
  let context: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    context = await browser.newContext();
    ({ page } = await open(context));
  }, 60_000);
  afterAll(() => context?.close());

  it('a task typed into one device appears on the others and on the hub, with its origin', async () => {
    await add(page, 'a', 'Book the room');
    await until('B and C list it', everyDeviceHas(page, 'Book the room'));
    await until('the hub panel lists it', async () => (await page.locator('#bh-tasks').innerText()).includes('Book the room — Device A'));
    expect(await page.locator('#bh-count').innerText()).toBe('1');
    expect(await frame(page, 'b').locator('li .origin').innerText()).toBe('Device A');
  });

  it('completing a task on one device shows it done on the others and the hub', async () => {
    await frame(page, 'c').locator('li input').check();
    await until('A and B show it done', async () => (await Promise.all(['a', 'b'].map((name) => device(page, name)))).every((state) => state.tasks[0]?.done === true));
    expect(await frame(page, 'a').locator('li input').isChecked()).toBe(true);
    await until('the hub shows it done', async () => (await page.locator('#bh-tasks').innerText()).startsWith('✓ Book the room'));
  });

  it('an empty title adds nothing', async () => {
    await frame(page, 'a').fill('#title', '   ');
    await frame(page, 'a').press('#title', 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await device(page, 'a')).tasks).toHaveLength(1);
  });

  it('carries text that is not ASCII, and HTML, as text', async () => {
    await add(page, 'b', '<b>Café ☕ 日本語</b>');
    await until('everyone has it', everyDeviceHas(page, '<b>Café ☕ 日本語</b>'));
    expect(await frame(page, 'a').locator('li .title', { hasText: 'Café' }).innerText()).toBe('<b>Café ☕ 日本語</b>');
    expect(await frame(page, 'a').locator('li b').count()).toBe(0);
  });

  it('gives every device the same tasks, in the same order', async () => {
    await add(page, 'c', 'Third');
    await until('everyone has it', everyDeviceHas(page, 'Third'));
    const orders = await Promise.all(NAMES.map(async (name) => (await device(page, name)).tasks.map((task) => task.id)));
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });
});

describe("a device's own switch", () => {
  let context: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    context = await browser.newContext();
    ({ page } = await open(context));
  }, 60_000);
  afterAll(() => context?.close());

  it('Disconnect cuts one device off at once and leaves the others online', async () => {
    await frame(page, 'a').click('#link');
    expect(await frame(page, 'a').locator('#link').innerText()).toBe('Reconnect');
    expect(await frame(page, 'a').locator('#link').getAttribute('aria-pressed')).toBe('true');
    await until('A is offline', () => offline(page, ['a']));
    await until('A says so', async () => /^Offline/.test(await status(page, 'a')));
    expect(await online(page, ['b', 'c'])).toBe(true);
    expect((await device(page, 'a')).lastError).toBe('Failed to fetch');
  });

  it('a disconnected device keeps working, and counts what waits to sync', async () => {
    await add(page, 'a', 'Written while A is cut off');
    await until('it counts it', async () => /1 change waiting to sync/.test(await frame(page, 'a').locator('#pending').innerText()));
    expect(await titles(page, 'a')).toEqual(['Written while A is cut off']);
    await new Promise((resolve) => setTimeout(resolve, 3_500)); // more than two sync periods
    expect(await titles(page, 'b')).toEqual([]);
    expect(await titles(page, 'c')).toEqual([]);
    expect((await hub(page)).tasks).toEqual([]);
  });

  it('a device cut off cannot read from the hub either', async () => {
    await add(page, 'b', 'Written on B meanwhile');
    await until('C has it', async () => (await titles(page, 'c')).includes('Written on B meanwhile'));
    expect(await titles(page, 'a')).toEqual(['Written while A is cut off']);
  });

  it('Reconnect sends what waited, receives what it missed, and the status follows', async () => {
    await frame(page, 'a').click('#link');
    expect(await frame(page, 'a').locator('#link').innerText()).toBe('Disconnect');
    expect(await frame(page, 'a').locator('#link').getAttribute('aria-pressed')).toBe('false');
    await until('everyone has both', async () => (await Promise.all(NAMES.map((name) => titles(page, name)))).every((list) => list.length === 2));
    await until('A is online and clear', async () => (await status(page, 'a')) === 'Online · in sync' && (await frame(page, 'a').locator('#pending').innerText()) === '');
    expect((await hub(page)).tasks).toHaveLength(2);
  });

  it('two devices cut off at once both converge when they return', async () => {
    await frame(page, 'b').click('#link');
    await frame(page, 'c').click('#link');
    await until('both offline', () => offline(page, ['b', 'c']));
    await add(page, 'b', 'B offline');
    await add(page, 'c', 'C offline');
    await frame(page, 'b').click('#link');
    await frame(page, 'c').click('#link');
    await until('all four everywhere', async () => (await Promise.all(NAMES.map((name) => titles(page, name)))).every((list) => list.length === 4));
  });

  it('works from the keyboard', async () => {
    const link = frame(page, 'c').locator('#link');
    await link.press('Enter');
    await until('C is offline', () => offline(page, ['c']));
    await link.press('Space');
    await until('C is online', () => online(page, ['c']));
  });
});

describe('the hub going down and coming back', () => {
  let context: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    context = await browser.newContext();
    ({ page } = await open(context));
    await add(page, 'a', 'Before the outage');
    await until('everyone has it', everyDeviceHas(page, 'Before the outage'));
  }, 60_000);
  afterAll(() => context?.close());

  it('taking the hub down shows it, empties its panel, and puts every device offline', async () => {
    await page.click('#bh-toggle');
    expect(await page.locator('#bh-state').innerText()).toBe('Hub down');
    expect(await page.locator('#bh-toggle').innerText()).toBe('Bring the hub back up');
    expect(await page.locator('#bh-count').innerText()).toBe('–');
    expect(await page.locator('#bh-tasks li').count()).toBe(0);
    expect(await page.locator('#bh-info').innerText()).toMatch(/process is gone.*still in this browser/);
    await until('every device offline', () => offline(page));
    expect((await device(page, 'a')).lastError).toBe('Failed to fetch');
    expect((await hub(page)).up).toBe(false);
  });

  it('devices keep working while the hub is down, and queue their changes', async () => {
    await add(page, 'b', 'During the outage on B');
    await add(page, 'c', 'During the outage on C');
    await until('they are counted', async () => (await device(page, 'b')).pending >= 1 && (await device(page, 'c')).pending >= 1);
    expect(await titles(page, 'a')).toEqual(['Before the outage']);
  });

  it('bringing the hub back reopens the store it left, and every device converges', async () => {
    await page.click('#bh-toggle');
    await until('the hub is up', async () => (await page.locator('#bh-state').innerText()) === 'Hub up');
    await until('every device online', () => online(page));
    await until('all three tasks everywhere', async () => (await Promise.all(NAMES.map((name) => titles(page, name)))).every((list) => list.length === 3));
    await until('the hub holds all three', async () => (await hub(page)).tasks.length === 3);
    expect((await hub(page)).tasks.map((task) => task.title).sort()).toEqual(['Before the outage', 'During the outage on B', 'During the outage on C']);
  });

  it('survives being killed and restarted five times over, reopening its store each time', async () => {
    for (let cycle = 1; cycle <= 5; cycle++) {
      await page.click('#bh-toggle');
      await until(`cycle ${cycle}: hub down`, async () => (await page.locator('#bh-state').innerText()) === 'Hub down');
      await page.click('#bh-toggle');
      await until(`cycle ${cycle}: hub up`, async () => (await hub(page)).info?.state === 'open', 15_000);
      await until(`cycle ${cycle}: store intact`, async () => (await hub(page)).tasks.length === 3);
    }
    await until('every device online again', () => online(page));
    expect((await hub(page)).info?.openError).toBe('');
  }, 90_000);

  it('a task added after the restarts still reaches everyone', async () => {
    await add(page, 'a', 'After the restarts');
    await until('everyone has it', everyDeviceHas(page, 'After the restarts'));
  });
});

describe('a device cut off by hand stays cut off when the hub returns', () => {
  it('only the other devices reconnect, and it joins when it is told to', async () => {
    const context = await browser.newContext();
    try {
      const { page } = await open(context);
      await frame(page, 'c').click('#link');
      await until('C offline', () => offline(page, ['c']));
      await page.click('#bh-toggle');
      await until('A and B offline', () => offline(page, ['a', 'b']));
      await page.click('#bh-toggle');
      await until('A and B back', () => online(page, ['a', 'b']));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect((await device(page, 'c')).online).toBe(false);
      await add(page, 'a', 'Without C');
      await until('B has it', async () => (await titles(page, 'b')).includes('Without C'));
      expect(await titles(page, 'c')).toEqual([]);
      await frame(page, 'c').click('#link');
      await until('C has it', async () => (await titles(page, 'c')).includes('Without C'));
    } finally {
      await context.close();
    }
  }, 90_000);

  it('a device that reconnects while the hub is down stays offline, and joins when the hub comes back', async () => {
    const context = await browser.newContext();
    try {
      const { page } = await open(context);
      await frame(page, 'a').click('#link');
      await page.click('#bh-toggle'); // hub down
      await frame(page, 'a').click('#link'); // A reconnects to nothing
      await until('A is offline', () => offline(page, ['a']));
      await page.click('#bh-toggle'); // hub up
      await until('everyone online', () => online(page), 30_000);
    } finally {
      await context.close();
    }
  }, 90_000);
});

describe('persistence', () => {
  it('a reload loses the workers and keeps the data: the hub and every device resume', async () => {
    const context = await browser.newContext();
    try {
      const { page } = await open(context);
      await add(page, 'a', 'Survives a reload');
      await until('everyone has it', everyDeviceHas(page, 'Survives a reload'));
      await frame(page, 'b').click('#link');
      await add(page, 'b', 'Written on B, never synced');
      await until('it waits', async () => (await device(page, 'b')).pending === 1);
      const before = (await hub(page)).tasks.length;
      expect(before).toBe(1);

      await page.reload();
      await until('the hub reopened its store', async () => (await hub(page)).info?.state === 'open', 30_000);
      await until('the hub holds what it held', async () => (await hub(page)).tasks.length >= 1);
      await until('every device online', () => online(page), 30_000);
      // B's unsent write was in its own store, so it is sent now, and reaches everyone.
      await until('B’s unsent write reaches everyone', everyDeviceHas(page, 'Written on B, never synced'), 30_000);
      expect(await titles(page, 'a')).toEqual(['Survives a reload', 'Written on B, never synced']);
      expect((await hub(page)).tasks).toHaveLength(2);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a second visit in a new page of the same browser finds the same data', async () => {
    const context = await browser.newContext();
    try {
      const first = await open(context);
      await add(first.page, 'c', 'Seen on the next visit');
      await until('the hub has it', async () => (await hub(first.page)).tasks.length === 1);
      await first.page.close();
      const second = await open(context);
      await until('it is still there', everyDeviceHas(second.page, 'Seen on the next visit'));
    } finally {
      await context.close();
    }
  }, 120_000);
});

describe('reset', () => {
  it('wipes the hub and every device, starts them again, and what was wiped does not come back', async () => {
    const context = await browser.newContext();
    try {
      const { page } = await open(context);
      await add(page, 'a', 'Gone after the reset');
      await until('everyone has it', everyDeviceHas(page, 'Gone after the reset'));
      await frame(page, 'b').click('#link');

      await page.click('#bh-reset');
      await until('the hub is up and empty', async () => (await hub(page)).info?.state === 'open' && (await hub(page)).tasks.length === 0, 30_000);
      await until('every device online and empty', async () => (await online(page)) && (await Promise.all(NAMES.map((name) => titles(page, name)))).every((list) => list.length === 0), 30_000);
      // The disconnect was undone, too: B is a new page.
      expect(await frame(page, 'b').locator('#link').innerText()).toBe('Disconnect');
      expect(await page.locator('#bh-count').innerText()).toBe('0');

      await add(page, 'c', 'After the reset');
      await until('the new task syncs', everyDeviceHas(page, 'After the reset'));
      await page.reload();
      await until('it is back', async () => (await online(page)) && (await titles(page, 'a')).length === 1, 30_000);
      expect(await titles(page, 'a')).toEqual(['After the reset']);
      expect((await hub(page)).tasks.map((task) => task.title)).toEqual(['After the reset']);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('works while the hub is down, and brings it back up', async () => {
    const context = await browser.newContext();
    try {
      const { page } = await open(context);
      await page.click('#bh-toggle');
      await page.click('#bh-reset');
      await until('the hub is up', async () => (await page.locator('#bh-state').innerText()) === 'Hub up');
      await until('every device online', () => online(page), 30_000);
    } finally {
      await context.close();
    }
  }, 90_000);
});

describe('a second tab of the same page', () => {
  it('cannot open any store, says why, and recovers when the first tab is closed', async () => {
    const context = await browser.newContext();
    try {
      const first = await open(context);
      await add(first.page, 'a', 'Owned by the first tab');
      await until('the hub has it', async () => (await hub(first.page)).tasks.length === 1);

      const second = await context.newPage();
      await second.goto(site.url);
      // The hub retries for ten seconds before it gives up.
      await until('the second tab’s hub gives up', async () => (await hub(second)).info?.state === 'failed', 30_000);
      expect(await second.locator('#bh-state').innerText()).toBe('Hub cannot open its store');
      expect(await second.locator('#bh-alert').innerText()).toMatch(/Another tab of this page has the hub’s store open/);
      expect((await hub(second)).info?.openAttempts).toBe(40);
      // Its devices cannot open their own stores either (the first tab holds them), and say so rather than looking in sync.
      for (const name of NAMES) {
        await until(`device ${name} reports it cannot open its store`, async () => /Access Handle/i.test(await frame(second, name).locator('#error').innerText()), 30_000);
        expect(await frame(second, name).locator('#status').innerText()).not.toBe('Online · in sync');
      }

      // The first tab is untouched.
      expect(await online(first.page)).toBe(true);
      expect((await hub(first.page)).info?.state).toBe('open');

      await first.page.close();
      await second.reload();
      await until('the second tab now owns the hub', async () => (await hub(second)).info?.state === 'open', 30_000);
      await until('and it has what the first tab wrote', async () => (await hub(second)).tasks.length === 1, 30_000);
      await until('its devices are online', () => online(second), 30_000);
    } finally {
      await context.close();
    }
  }, 150_000);
});

describe('the theme', () => {
  const background = (page: Page, name: string): Promise<string> => frame(page, name).evaluate(() => getComputedStyle(document.body).backgroundColor);
  const LIGHT = 'rgb(246, 247, 249)'; // #f6f7f9
  const DARK = 'rgb(17, 21, 28)'; // #11151c

  it('every device follows the embedding page’s data-theme, in both directions, and the media query when it has none', async () => {
    const context = await browser.newContext({ colorScheme: 'light' });
    try {
      const { page } = await open(context);
      for (const name of NAMES) expect(await background(page, name)).toBe(LIGHT);

      await page.evaluate(() => (document.documentElement.dataset['theme'] = 'dark'));
      await until('every device is dark', async () => (await Promise.all(NAMES.map((name) => background(page, name)))).every((color) => color === DARK));
      for (const name of NAMES) expect(await frame(page, name).evaluate(() => document.documentElement.dataset['theme'])).toBe('dark');

      await page.evaluate(() => (document.documentElement.dataset['theme'] = 'light'));
      await until('every device is light', async () => (await Promise.all(NAMES.map((name) => background(page, name)))).every((color) => color === LIGHT));

      await page.evaluate(() => delete document.documentElement.dataset['theme']);
      await until('the attribute is gone', async () => (await Promise.all(NAMES.map((name) => frame(page, name).evaluate(() => document.documentElement.dataset['theme'])))).every((theme) => theme === undefined));
      for (const name of NAMES) expect(await background(page, name)).toBe(LIGHT);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('with no data-theme at all, the operating system’s colour scheme decides, standalone and embedded', async () => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    try {
      const { page } = await open(context);
      expect(await frame(page, 'a').evaluate(() => document.documentElement.dataset['theme'])).toBeUndefined();
      expect(await background(page, 'a')).toBe(DARK);
      const standalone = await context.newPage();
      await standalone.goto(new URL('device.html?device=z&fresh', site.url).href);
      expect(await standalone.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(DARK);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe('at the root of a site', () => {
  it('works at /, too: nothing about the path is assumed either way', async () => {
    const context = await browser.newContext();
    try {
      const { page, problems } = await open(context, root);
      expect(new URL(page.url()).pathname).toBe('/');
      await add(page, 'a', 'At the root');
      await until('it syncs', everyDeviceHas(page, 'At the root'));
      expect(problems.errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
