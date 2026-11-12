/**
 * The desktop device: the real Electron app, its own profile, syncing with a headless device through
 * the demo server. Needs a display (WSLg, or `xvfb-run` when headless).
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';

import { DemoDevice } from '../src/shared/device.js';
import { startDemoServer, type DemoServer } from '../src/server/server.js';

const BUILD = fileURLToPath(new URL('../.build', import.meta.url));
const electronPath = createRequire(import.meta.url)('electron') as unknown as string;

/** 🔴 Run from a VS Code terminal, `ELECTRON_RUN_AS_NODE` would start Electron as plain Node. */
export function cleanEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_')) continue;
    env[name] = value;
  }
  return env;
}

let root: string;
let server: DemoServer;
let app: ElectronApplication;
let page: Page;
let phone: DemoDevice;
let phoneDb: TypeDBLiteInterpreter;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'typedblite-sync-electron-'));
  server = await startDemoServer({ port: 0, hubPort: 0, dataDir: join(root, 'hub'), clientDir: BUILD, log: () => undefined });
  app = await _electron.launch({
    executablePath: electronPath,
    args: [join(BUILD, 'electron-main.cjs'), '--url', server.url, '--profile', join(root, 'electron-profile'), '--fresh'],
    env: cleanEnvironment(),
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => (window as any).typedbliteDemo?.state()?.online === true, undefined, { timeout: 30_000 });
  phoneDb = new TypeDBLiteInterpreter(join(root, 'phone.db'));
  phone = new DemoDevice('android', phoneDb, `${server.url}/net/android/hub`, { timeoutMs: 3_000 });
}, 90_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  phoneDb?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the Electron device', () => {
  it('is its own device, in its own window', async () => {
    assert.equal(await page.title(), 'Tasks · Desktop');
    assert.equal(await page.evaluate(() => (window as any).typedbliteDemo.device), 'electron');
  });

  it('sends what it writes, and receives what another device writes', async () => {
    await page.fill('#title', 'Send the agenda');
    await page.press('#title', 'Enter');
    for (let i = 0; i < 40 && !phone.tasks().some((t) => t.title === 'Send the agenda'); i++) {
      await phone.syncOnce();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(phone.tasks().some((t) => t.title === 'Send the agenda'), 'the phone received the desktop task');

    phone.addTask('Print the one-pager');
    await phone.syncOnce();
    await page.waitForFunction(() => (window as any).typedbliteDemo.state().tasks.some((t: any) => t.title === 'Print the one-pager'), undefined, { timeout: 15_000 });
  }, 60_000);
});
