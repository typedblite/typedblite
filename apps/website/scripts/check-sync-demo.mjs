/**
 * Opens the built site's sync demo in Chromium: the page Astro built inside Starlight's layout, with the demo's
 * scripts beside it. It checks that the shell is there (Starlight's header, theme switch and sidebar), that the hub
 * and the three embedded devices started on WASM SQLite and OPFS, that a task typed into one device reaches another and
 * the hub, that the highlight takes the colour of the device that made the change, that each device has its own colour on its card, on the chip that says where a task was made and in the hub's list, that a device can be cut off and reconnected, that the devices follow the site's light and dark switch, that
 * the page also works at the URL without its trailing slash, and that nothing failed to load. Needs Playwright's Chromium
 * (`npx playwright-core install chromium`). Run by `website:check`, after the build.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIST = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf' };

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep) && file !== DIST) return response.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const expect = (ok, message) => {
  if (!ok) failures.push(message);
};
const errors = [];
const NAMES = ['a', 'b', 'c'];

/** Poll until `check` is true. A page that is not ready yet throws, and that is "not yet". */
async function until(message, check, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not ready
    }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((done) => setTimeout(done, 150));
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('requestfailed', (request) => errors.push(`failed: ${request.url()}`));
  page.on('response', (response) => response.status() >= 400 && errors.push(`${response.status()}: ${response.url()}`));
  const frame = (name) => {
    const found = page.frames().find((f) => new URL(f.url()).searchParams.get('device') === name);
    if (!found) throw new Error(`no frame for ${name}`);
    return found;
  };
  const state = (name) => frame(name).evaluate(() => window.typedbliteDemo.state());

  await page.goto(`${origin}/sync-demo/`);
  expect((await page.locator('header.header').count()) === 1, "Starlight's header is not on the sync demo page");
  expect((await page.locator('starlight-theme-select').count()) > 0, "Starlight's theme switch is not on the sync demo page");
  expect((await page.locator('nav.sidebar a[aria-current="page"]').textContent())?.trim() === 'Sync demo', 'the sidebar does not mark Sync demo as the current page');

  await until('the hub is up', async () => (await page.locator('#bh-state').innerText()) === 'Hub up');
  await until('all three devices online', async () => (await Promise.all(NAMES.map(state))).every((s) => s?.online === true));
  expect((await page.locator('#bh-info').innerText()).includes('Store open on OPFS'), 'the hub did not report its store open on OPFS');

  await frame('a').fill('#title', 'Checked by the site');
  await frame('a').press('#title', 'Enter');
  await until('the task reaches B, C and the hub', async () => {
    const lists = await Promise.all(['b', 'c'].map((name) => frame(name).locator('#tasks li .title').allInnerTexts()));
    return lists.every((titles) => titles.includes('Checked by the site')) && (await page.locator('#bh-tasks').innerText()).includes('Checked by the site — Device A');
  });

  // Each device has its own colour, the same on its card, on the chip that says where a task was made, and in the hub's list.
  const colour = (target, selector) => target.locator(selector).first().evaluate((element) => getComputedStyle(element).color);
  const cardColours = await Promise.all(NAMES.map((name) => colour(frame(name), '#device')));
  expect(new Set(cardColours).size === 3, `the devices do not have three different colours: ${cardColours.join(', ')}`);
  const hubChipA = await colour(page, '#bh-tasks .bh-origin[data-origin="a"]');
  expect(hubChipA === cardColours[0], `the hub lists Device A in ${hubChipA}, not its card's ${cardColours[0]}`);
  expect((await colour(frame('b'), 'li .origin[data-origin="a"]')) === cardColours[0], "the chip on B for A's task is not A's colour");

  // Who made a change, not who made the task, decides the highlight: B checks A's task and A's row says B made the change.
  await frame('b').locator('#tasks li input').first().check();
  await until("A's row says B made the change, and still says A made the task", async () => {
    const row = frame('a').locator('#tasks li').first();
    return (await row.getAttribute('data-editor')) === 'b' && (await row.locator('.origin').getAttribute('data-origin')) === 'a';
  });

  await frame('c').click('#link');
  await until('C says it is offline', async () => /^Offline/.test(await frame('c').locator('#status').innerText()));
  expect((await frame('c').locator('#link').getAttribute('aria-pressed')) === 'true', 'the Disconnect switch is not pressed after a click');
  await frame('c').click('#link');
  await until('C is back in sync', async () => (await frame('c').locator('#status').innerText()) === 'Online · in sync');

  const background = (name) => frame(name).evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await background('a');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await until('every device follows the dark theme', async () => (await Promise.all(NAMES.map(background))).every((color) => color !== light));
  await until('the device colours change with the theme', async () => (await colour(frame('a'), '#device')) !== cardColours[0]);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await until('every device follows the light theme again', async () => (await Promise.all(NAMES.map(background))).every((color) => color === light));

  // The site answers with or without the trailing slash, so the page must not depend on it. Another page in the same
  // browser profile would contend for the stores, so the first one is closed.
  await page.close();
  const bare = await context.newPage();
  bare.on('pageerror', (error) => errors.push(String(error)));
  await bare.goto(`${origin}/sync-demo`);
  await until('the demo starts without the trailing slash', async () =>
    (await Promise.all(NAMES.map((name) => bare.frames().find((f) => new URL(f.url()).searchParams.get('device') === name)?.evaluate(() => window.typedbliteDemo.state())))).every((s) => s?.online === true),
  );

  expect(errors.length === 0, `the page logged errors:\n    ${errors.join('\n    ')}`);
} catch (error) {
  failures.push(`${String(error).split('\n')[0]}${errors.length ? `\n    the page logged:\n    ${errors.join('\n    ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`check-sync-demo: ${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('check-sync-demo: the sync demo runs inside the site shell, syncs, and follows its theme');
