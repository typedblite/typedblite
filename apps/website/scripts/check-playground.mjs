/**
 * Opens the built site's playground in Chromium: the page Astro built inside Starlight's layout, with the
 * playground's scripts beside it. It checks that the shell is there (Starlight's header and theme), that the
 * engine ran the first example on WASM SQLite in a worker and drew its results, that nothing failed to load,
 * and that the editor follows the site's light and dark switch. Needs Playwright's Chromium
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
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ colorScheme: 'light' })).newPage();
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('requestfailed', (request) => errors.push(`failed: ${request.url()}`));
  page.on('response', (response) => response.status() >= 400 && errors.push(`${response.status()}: ${response.url()}`));

  await page.goto(`${origin}/playground/`);
  expect((await page.locator('header.header').count()) === 1, "Starlight's header is not on the playground page");
  expect((await page.locator('starlight-theme-select').count()) > 0, "Starlight's theme switch is not on the playground page");
  expect((await page.locator('nav.sidebar a[aria-current="page"]').textContent())?.trim() === 'Playground', 'the sidebar does not mark Playground as the current page');

  await page.waitForFunction(() => /^Ran in/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 60_000 });
  const results = await page.locator('#output').innerText();
  expect(results.includes('Alice') && results.includes('Acme'), `the first example did not draw its results: ${results.slice(0, 120)}`);
  expect(await page.locator('.monaco-editor').count() > 0, 'the editor did not start');

  const dark = () => page.evaluate(() => document.querySelector('.monaco-editor')?.classList.contains('vs-dark') ?? null);
  const surface = () =>
    page.evaluate(() => ({
      editor: getComputedStyle(document.querySelector('.monaco-editor-background')).backgroundColor,
    }));
  expect((await dark()) === false, 'the editor is dark on the light theme');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.waitForFunction(() => document.querySelector('.monaco-editor')?.classList.contains('vs-dark'));
  const darkSurface = await surface();
  expect(darkSurface.editor !== 'rgb(255, 255, 255)', `the editor keeps a light surface in the dark theme: ${darkSurface.editor}`);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.waitForFunction(() => !document.querySelector('.monaco-editor')?.classList.contains('vs-dark'));

  expect(errors.length === 0, `the page logged errors:\n    ${errors.join('\n    ')}`);
} catch (error) {
  failures.push(`${String(error).split('\n')[0]}${errors.length ? `\n    the page logged:\n    ${errors.join('\n    ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`check-playground: ${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('check-playground: the playground runs inside the site shell and follows its theme');
