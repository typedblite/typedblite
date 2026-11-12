/**
 * `nx run sync-demo:test-browser` — the PWA client in a real Chromium: two devices, each a separate
 * browser profile and so a separate OPFS store, syncing through the demo server's switchboard and hub.
 *
 * Needs Playwright's Chromium (`npx playwright-core install chromium`).
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

import { startDemoServer, type DemoServer } from '../src/server/server.js';
import type { Task } from '../src/shared/schema.js';

type DemoState = { tasks: Task[]; pending: number; online?: boolean };
const BUILD = fileURLToPath(new URL('../.build', import.meta.url));

let root: string;
let server: DemoServer;
const contexts: BrowserContext[] = [];

async function openDevice(name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(join(root, `profile-${name}`), { headless: true });
  contexts.push(context);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${server.url}/?device=${name}&fresh`);
  await page.waitForFunction(() => (window as any).typedbliteDemo?.state()?.online === true, undefined, { timeout: 20_000 });
  return { context, page };
}

const state = (page: Page): Promise<DemoState> => page.evaluate(() => (window as any).typedbliteDemo.state());
const until = (page: Page, predicate: string, timeout = 15_000) =>
  page.waitForFunction(`(() => { const s = window.typedbliteDemo.state(); return !!s && (${predicate}); })()`, undefined, { timeout });
const titles = async (page: Page): Promise<string[]> => (await state(page)).tasks.map((task) => task.title).sort();

let pwa: { context: BrowserContext; page: Page };
let electron: { context: BrowserContext; page: Page };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'typedblite-sync-pwa-'));
  server = await startDemoServer({ port: 0, hubPort: 0, dataDir: join(root, 'hub'), clientDir: BUILD, log: () => undefined });
  pwa = await openDevice('pwa');
  electron = await openDevice('electron');
}, 60_000);

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the PWA client', () => {
  it('adds a task through the page, and the other device receives it', async () => {
    await pwa.page.fill('#title', 'Confirm meeting room');
    await pwa.page.press('#title', 'Enter');
    await until(electron.page, `s.tasks.some((t) => t.title === 'Confirm meeting room')`);
    assert.deepEqual(await titles(pwa.page), ['Confirm meeting room']);
  }, 30_000);

  it('completes a task on one device, and the other shows it done', async () => {
    await electron.page.click('li label');
    await until(pwa.page, `s.tasks[0]?.done === true`);
    assert.ok(await pwa.page.isChecked('li input'));
  }, 30_000);

  it('works offline when its link is cut, counts what waits, and converges when it returns', async () => {
    server.setLink('pwa', false);
    await pwa.page.fill('#title', 'Written with the link cut');
    await pwa.page.press('#title', 'Enter');
    await until(pwa.page, 's.online === false && s.pending === 1');
    assert.match(await pwa.page.textContent('#status') ?? '', /Offline/);
    assert.match(await pwa.page.textContent('#pending') ?? '', /1 change waiting to sync/);
    server.setLink('pwa', true);
    await until(electron.page, `s.tasks.some((t) => t.title === 'Written with the link cut')`);
    await until(pwa.page, 's.online === true && s.pending === 0');
  }, 45_000);

  it('reloads with no network at all: the shell from the service worker, the data from OPFS', async () => {
    await pwa.page.evaluate(() => navigator.serviceWorker.ready);
    await pwa.context.setOffline(true);
    await pwa.page.reload();
    await until(pwa.page, 's.tasks.length === 2 && s.online === false');
    await pwa.page.fill('#title', 'Written with no network');
    await pwa.page.press('#title', 'Enter');
    await until(pwa.page, 's.pending === 1');
    await pwa.context.setOffline(false);
    await until(electron.page, `s.tasks.some((t) => t.title === 'Written with no network')`, 30_000);
    assert.deepEqual(await titles(electron.page), await titles(pwa.page));
  }, 60_000);
});
