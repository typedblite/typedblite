/**
 * `nx run sync-demo:demo` — opens every device and drives the story.
 *
 *   --fresh           wipe the hub's store and every device's store first
 *   --auto            run the story timed, without keypresses
 *   --open            only open the windows, to drive them by hand
 *   --no-android      leave the phone out (it is skipped anyway when `adb` lists no device)
 *   --start-playing   start at once instead of waiting for ▶ Play on the control page
 *   --record          record each window (silent video) and write the captions as an .srt
 *   --headless        no windows on screen (implies --auto and --start-playing): a verification run
 *
 * DEMO_PORT (4300; the phone needs 4300), HUB_PORT (4310), DEMO_DATA (.data), DEMO_DEBUG=1 (full errors).
 *
 * Every step passes because every device and the hub hold the same tasks — never because time went by.
 * The story starts PAUSED, so the presenter's first ▶ Play (or Space on the control page) starts it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { _android, _electron, chromium, type Browser, type BrowserContext, type ElectronApplication, type Page } from 'playwright-core';

import { startDemoServer, type DemoServer } from '../server/server.js';
import type { Task } from '../shared/schema.js';
import { cleanEnvironment, electronPath } from './environment.js';

const flags = new Set(process.argv.slice(2));
const HEADLESS = flags.has('--headless');
const AUTO = flags.has('--auto') || HEADLESS;
const OPEN_ONLY = flags.has('--open');
const FRESH = flags.has('--fresh');
const RECORD = flags.has('--record');
const START_PLAYING = flags.has('--start-playing') || HEADLESS;
const NO_ANDROID = flags.has('--no-android');
const PORT = Number(process.env['DEMO_PORT'] ?? 4300);
const APP = fileURLToPath(new URL('../../', import.meta.url));
const DATA = process.env['DEMO_DATA'] ?? join(APP, '.data');
const BUILD = join(APP, '.build');
const RECORDINGS = join(APP, 'recordings', new Date().toISOString().replace(/[:.]/g, '-'));
const PACKAGE = 'dev.typedblite.syncdemo';

type Name = 'pwa' | 'electron' | 'android';
interface Client {
  readonly name: Name;
  readonly label: string;
  readonly page: Page;
  readonly context?: BrowserContext;
}
interface DemoState {
  tasks: Task[];
  pending: number;
  online?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** The captions' zero: reset when the first window (and so the first video) opens. */
let started = Date.now();
const captions: Array<{ from: number; to?: number; text: string }> = [];
const closers: Array<() => Promise<unknown>> = [];
/** Pages being recorded, by the name their video is saved under. */
const recorded = new Map<string, Page>();
let server: DemoServer;

// ------------------------------------------------------------------------------------------ devices
function videoOptions(): { recordVideo?: { dir: string; size: { width: number; height: number } } } {
  return RECORD ? { recordVideo: { dir: RECORDINGS, size: { width: 420, height: 760 } } } : {};
}

async function openPwa(url: string): Promise<Client> {
  const context = await chromium.launchPersistentContext(join(DATA, 'profile-pwa'), {
    headless: HEADLESS,
    viewport: HEADLESS ? { width: 420, height: 760 } : null,
    args: HEADLESS ? [] : ['--window-position=0,0', '--window-size=430,820'],
    ...videoOptions(),
  });
  closers.push(() => context.close());
  const page = context.pages()[0] ?? (await context.newPage());
  recorded.set('pwa', page);
  await page.goto(`${url}/?device=pwa${FRESH ? '&fresh' : ''}`);
  return { name: 'pwa', label: 'Browser', page, context };
}

async function openElectron(url: string): Promise<Client> {
  const app: ElectronApplication = await _electron.launch({
    executablePath: electronPath(),
    args: [
      join(BUILD, 'electron-main.cjs'),
      '--url', url,
      '--profile', join(DATA, 'electron-profile'),
      '--x', '440', '--y', '0',
      ...(FRESH ? ['--fresh'] : []),
      ...(HEADLESS ? ['--hidden'] : []),
    ],
    env: cleanEnvironment(),
    ...(RECORD ? { recordVideo: { dir: RECORDINGS, size: { width: 420, height: 760 } } } : {}),
  });
  closers.push(() => app.close());
  const page = await app.firstWindow();
  recorded.set('electron', page);
  return { name: 'electron', label: 'Desktop', page };
}

function adbDevice(): boolean {
  const adb = join(process.env['ANDROID_HOME'] ?? join(process.env['HOME'] ?? '', 'Android/Sdk'), 'platform-tools/adb');
  if (!existsSync(adb)) return false;
  try {
    return execFileSync(adb, ['devices'], { encoding: 'utf8' }).split('\n').slice(1).some((line) => /\tdevice$/.test(line.trim()));
  } catch {
    return false;
  }
}

async function openAndroid(): Promise<Client | undefined> {
  if (NO_ANDROID) return undefined;
  if (PORT !== 4300) {
    console.log('  phone: skipped (the app loads localhost:4300 through adb reverse; DEMO_PORT is not 4300)');
    return undefined;
  }
  if (!adbDevice()) {
    console.log('  phone: skipped — no Android device. Start one with: npm exec nx -- run sync-demo:android-emulator');
    return undefined;
  }
  const [device] = await _android.devices();
  if (!device) return undefined;
  closers.push(() => device.close());
  await device.shell(`am start -n ${PACKAGE}/.MainActivity`);
  const page = await (await device.webView({ pkg: PACKAGE })).page();
  if (FRESH) await page.goto('http://localhost:4300/?device=android&fresh');
  return { name: 'android', label: 'Phone', page };
}

async function openControl(url: string): Promise<Page> {
  const browser: Browser = await chromium.launch({ headless: HEADLESS, args: HEADLESS ? [] : ['--window-position=880,0', '--window-size=560,820'] });
  closers.push(() => browser.close());
  const context = await browser.newContext({ viewport: HEADLESS ? { width: 560, height: 760 } : null, ...(RECORD ? { recordVideo: { dir: RECORDINGS, size: { width: 560, height: 760 } } } : {}) });
  const page = await context.newPage();
  recorded.set('control', page);
  await page.goto(`${url}/control`);
  return page;
}

// ---------------------------------------------------------------------------------------- the story
// Evaluated in the page, so written as an expression: this program is Node, and has no DOM types.
const state = (client: Client): Promise<DemoState> => client.page.evaluate('window.typedbliteDemo.state()') as Promise<DemoState>;
const fingerprint = (tasks: readonly Task[]): string => JSON.stringify(tasks.map((task) => [task.id, task.title, task.done]));

/** Hold while the presenter has paused the story. Called before each step and each action. */
async function gate(): Promise<void> {
  while (server.story().paused) await sleep(200);
}

async function act(what: () => Promise<unknown>): Promise<void> {
  await gate();
  await what();
  if (!AUTO) await sleep(400);
}

/** Type a task and press Enter, as a user would, then wait until the device's own store has it. */
async function add(client: Client, title: string): Promise<void> {
  await act(async () => {
    await client.page.fill('#title', title);
    await client.page.press('#title', 'Enter');
  });
  await until(client, (s) => s.tasks.some((task) => task.title === title), `shows '${title}'`);
}

/** Click a task's checkbox, then wait until the device's own store has the new state. */
async function toggle(client: Client, title: string): Promise<void> {
  const before = (await state(client)).tasks.find((task) => task.title === title)?.done;
  await act(() => client.page.locator('li', { hasText: title }).locator('input').click());
  await until(client, (s) => s.tasks.find((task) => task.title === title)?.done === !before, `'${title}' toggled`);
}

/** What a step expects every store to hold once it has converged. */
const has = (...titles: string[]) => (tasks: readonly Task[]): boolean => titles.every((title) => tasks.some((task) => task.title === title));
const done = (title: string, value: boolean) => (tasks: readonly Task[]): boolean => tasks.find((task) => task.title === title)?.done === value;

async function until(client: Client, predicate: (state: DemoState) => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await state(client).catch(() => undefined);
    if (current && predicate(current)) return;
    if (Date.now() > deadline) throw new Error(`${client.label}: ${what} (not within ${timeoutMs / 1000} s)`);
    await sleep(200);
  }
}

async function hubTasks(): Promise<Task[] | undefined> {
  const answer = (await (await fetch(`${server.url}/api/state`)).json()) as { hub: { tasks?: Task[] } };
  return answer.hub.tasks;
}

/**
 * Wait until `clients` and the hub hold the same tasks, AND those tasks are what the step expects —
 * agreeing on the state before the step's own change would otherwise pass in no time at all.
 */
async function converge(clients: readonly Client[], expect: (tasks: readonly Task[]) => boolean, timeoutMs = 30_000): Promise<Task[]> {
  const from = Date.now();
  for (;;) {
    const hub = await hubTasks();
    if (hub && expect(hub)) {
      const views = await Promise.all(clients.map(async (client) => fingerprint((await state(client)).tasks)));
      if (views.every((view) => view === fingerprint(hub))) {
        console.log(`    converged: ${clients.map((client) => client.label).join(', ')} and the hub agree on ${hub.length} task(s), in ${((Date.now() - from) / 1000).toFixed(1)} s`);
        return hub;
      }
    }
    if (Date.now() - from > timeoutMs) throw new Error(`no convergence within ${timeoutMs / 1000} s`);
    await sleep(250);
  }
}

interface Step {
  readonly title: string;
  readonly caption: string;
  readonly run: () => Promise<void>;
}

function story(clients: readonly Client[]): Step[] {
  const [pwa, electron] = clients as [Client, Client];
  const phone = clients.find((client) => client.name === 'android');
  const other = phone ?? pwa;
  const all = clients;
  return [
    {
      title: 'Three devices, one hub',
      caption: 'Every device has its own TypeDBLite store. Each adds a task, and every store converges on all of them.',
      run: async () => {
        await add(pwa, 'Confirm meeting room');
        await add(electron, 'Send the agenda');
        if (phone) await add(phone, 'Print the one-pager');
        await converge(all, has('Confirm meeting room', 'Send the agenda', ...(phone ? ['Print the one-pager'] : [])));
      },
    },
    {
      title: 'Write anywhere',
      caption: 'A task added in the browser lands in its local store first, then reaches the others in a second or two.',
      run: async () => {
        await add(pwa, 'Book the taxi');
        await converge(all, has('Book the taxi'));
      },
    },
    {
      title: 'Edit elsewhere',
      caption: 'The desktop completes the task the browser created.',
      run: async () => {
        await toggle(electron, 'Book the taxi');
        await converge(all, done('Book the taxi', true));
      },
    },
    {
      title: 'The desktop loses its connection',
      caption: 'Its link is cut. It keeps working — two new tasks and a reopened one wait in its change log — while another device writes without it.',
      run: async () => {
        await act(async () => server.setLink('electron', false));
        await add(electron, 'Draft the follow-up');
        await add(electron, 'Collect the slides');
        await toggle(electron, 'Book the taxi');
        await until(electron, (s) => s.online === false && s.pending === 3, 'offline, with 3 changes waiting');
        console.log('    the desktop: offline, 3 changes waiting to sync');
        await add(other, 'Order lunch');
        await converge(all.filter((client) => client !== electron), has('Order lunch'));
        if ((await state(electron)).tasks.some((task) => task.title === 'Order lunch')) throw new Error('the desktop received a task while cut off');
      },
    },
    {
      title: 'Reconnect',
      caption: 'The link comes back. The change log replays, and everyone converges.',
      run: async () => {
        await act(async () => server.setLink('electron', true));
        await converge(all, (tasks) => has('Draft the follow-up', 'Collect the slides', 'Order lunch')(tasks) && done('Book the taxi', false)(tasks));
      },
    },
    {
      title: 'The hub goes down',
      caption: 'The hub process is stopped. Every device shows that it is offline — none claims to be in sync — and keeps writing.',
      run: async () => {
        await act(() => server.stopHub());
        for (const client of all) await until(client, (s) => s.online === false, 'offline');
        for (const client of all) await add(client, `Written while the hub was down (${client.label})`);
        for (const client of all) await until(client, (s) => s.pending >= 1, 'a change waiting');
      },
    },
    {
      title: 'The hub comes back',
      caption: 'The hub restarts with its store intact. Every device replays what it wrote, and they converge.',
      run: async () => {
        await act(() => server.startHub());
        await converge(all, has(...all.map((client) => `Written while the hub was down (${client.label})`)));
      },
    },
    {
      title: 'Truly offline',
      caption: 'The browser goes fully offline and reloads. The service worker serves the app, OPFS serves the data, and it keeps working.',
      run: async () => {
        const expected = (await state(pwa)).tasks.length;
        await act(async () => {
          await pwa.page.evaluate('navigator.serviceWorker.ready.then(() => true)');
          await pwa.context?.setOffline(true);
          await pwa.page.reload();
        });
        await until(pwa, (s) => s.online === false && s.tasks.length === expected, 'reloaded offline with its tasks');
        await add(pwa, 'Written with no network');
        await until(pwa, (s) => s.pending === 1, 'a change waiting');
      },
    },
    {
      title: 'Back online',
      caption: 'The network returns, and everything converges.',
      run: async () => {
        await act(async () => pwa.context?.setOffline(false));
        await converge(all, has('Written with no network'));
      },
    },
  ];
}

// ------------------------------------------------------------------------------------------- run it
function writeCaptions(): void {
  const time = (ms: number): string => {
    const date = new Date(ms);
    return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')},${String(date.getUTCMilliseconds()).padStart(3, '0')}`;
  };
  const srt = captions.map((caption, index) => `${index + 1}\n${time(caption.from)} --> ${time(caption.to ?? caption.from + 5_000)}\n${caption.text}\n`).join('\n');
  writeFileSync(join(RECORDINGS, 'captions.srt'), srt);
}

async function shutdown(code: number): Promise<never> {
  // 🔴 Videos are saved page by page BEFORE the browsers close: a recording cannot be fetched through
  // a browser that has already gone.
  if (RECORD) {
    for (const [name, page] of recorded) {
      const video = page.video();
      await page.close().catch(() => undefined);
      if (!video) continue;
      await video.saveAs(join(RECORDINGS, `${name}.webm`)).catch(() => undefined);
      await video.delete().catch(() => undefined);
    }
    writeCaptions();
    console.log(`Recording (one silent video per window, and captions.srt): ${RECORDINGS}`);
  }
  for (const close of closers.reverse()) await close().catch(() => undefined);
  await server?.close();
  process.exit(code);
}

async function main(): Promise<void> {
  if (!existsSync(join(BUILD, 'electron-main.cjs'))) throw new Error('No client build. Run: npm exec nx -- run sync-demo:build');
  if (FRESH) rmSync(join(DATA), { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  if (RECORD) mkdirSync(RECORDINGS, { recursive: true });

  server = await startDemoServer({ port: PORT, hubPort: Number(process.env['HUB_PORT'] ?? 4310), dataDir: join(DATA, 'hub'), clientDir: BUILD });
  console.log('Opening the devices…');
  started = Date.now();
  const clients: Client[] = [await openPwa(server.url), await openElectron(server.url)];
  const phone = await openAndroid();
  if (phone) clients.push(phone);
  await openControl(server.url);
  for (const client of clients) await until(client, (s) => s.online === true, 'connected to the hub', 60_000);
  console.log(`Opened: ${clients.map((client) => client.label).join(', ')} and the hub control page.`);

  if (OPEN_ONLY) {
    console.log('Windows open. Drive them by hand; Ctrl-C to quit.');
    return;
  }

  const steps = story(clients);
  server.setStory({ active: true, paused: !START_PLAYING, caption: 'Ready.' });
  if (!START_PLAYING) console.log('PAUSED — press ▶ Play on the hub control page (or Space there) to start.');
  const prompt = AUTO ? undefined : createInterface({ input: process.stdin, output: process.stdout });

  for (const [index, step] of steps.entries()) {
    if (prompt) await prompt.question(`\n${index + 1}. ${step.title} — press Enter `);
    else await sleep(index === 0 ? 500 : 2_500);
    await gate();
    const last = captions.at(-1);
    if (last) last.to = Date.now() - started;
    captions.push({ from: Date.now() - started, text: `${index + 1}. ${step.title} — ${step.caption}` });
    server.setStory({ step: `${index + 1}/${steps.length} ${step.title}`, caption: step.caption });
    console.log(`\n${index + 1}. ${step.title}\n    ${step.caption}`);
    await step.run();
    console.log(`  ✓ ${step.title}`);
  }
  const last = captions.at(-1);
  if (last) last.to = Date.now() - started + 3_000;
  server.setStory({ step: undefined, caption: 'The story is complete. Every device and the hub agree.' });
  prompt?.close();
  console.log('\n✓ The story is complete: every step converged.');
  if (AUTO) await shutdown(0);
  console.log('Windows stay open; Ctrl-C to quit.');
}

process.on('SIGINT', () => void shutdown(0));
main().catch(async (error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  if (process.env['DEMO_DEBUG']) console.error(error);
  await shutdown(1);
});
