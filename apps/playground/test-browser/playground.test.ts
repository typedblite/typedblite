/**
 * `nx run playground:test-browser` — the page and its worker in a real Chromium, with the engine on
 * WASM SQLite. The unit tests prove the logic on `node:sqlite`; only this proves the WASM binding,
 * the worker, the bundle and the page work together.
 *
 * Needs Playwright's Chromium (`npx playwright-core install chromium`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

import { serveDirectory } from '../src/dev/static-server.js';

const BUILD = fileURLToPath(new URL('../.build', import.meta.url));
let site: Awaited<ReturnType<typeof serveDirectory>>;
let browser: Browser;

beforeAll(async () => {
  site = await serveDirectory(BUILD);
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const open = async (hash = ''): Promise<Page> => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${site.url}/${hash}`);
  return page;
};
/** The page has finished a run: the status says so, and the button is back. */
const settled = async (page: Page) => {
  await page.waitForFunction(() => /^(Ran in|Stopped at an error)/.test(document.getElementById('status')?.textContent ?? ''), undefined, { timeout: 30_000 });
  expect(await page.locator('#run').isEnabled()).toBe(true);
};
const run = async (page: Page, program: string) => {
  await page.locator('#editor').fill(program);
  await page.locator('#run').click();
  await settled(page);
};

const SCHEMA = 'define attribute name, value string; entity person, owns name @key;';

describe('the playground in Chromium', () => {
  it('runs the first example when it opens, on the engine in a worker, and shows the answer', async () => {
    const page = await open();
    await settled(page);
    expect(page.workers().length).toBeGreaterThanOrEqual(1);
    expect(await page.locator('#output .step').count()).toBe(3);
    const rows = await page.locator('#output .step[data-kind="read"] tbody tr').allInnerTexts();
    expect(rows.map((row) => row.split(/\s+/))).toEqual([['Alice', 'Acme'], ['Bob', 'Acme']]);
    expect(await page.locator('#output .step.has-error').count()).toBe(0);
  });

  it('runs entirely on its own origin: after it loads, nothing is sent anywhere else', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await page.goto(`${site.url}/`);
    await settled(page);
    await run(page, `${SCHEMA}\ninsert $a isa person, has name "secret-value";\nend;\nmatch $p isa person, has name $n; select $n;`);
    const foreign = requested.filter((url) => !url.startsWith(site.url) && !url.startsWith('blob:') && !url.startsWith('data:'));
    expect(foreign).toEqual([]);
    expect(requested.some((url) => url.endsWith('sqlite3.wasm'))).toBe(true);
  });

  it('switches examples, and runs each one', async () => {
    const page = await open();
    await settled(page);
    await page.locator('#examples').selectOption('types-that-inherit');
    await page.waitForFunction(() => document.querySelector('#output .step[data-kind="read"] td')?.textContent === 'entity:animal:#1' || document.querySelectorAll('#output .step').length >= 3);
    await settled(page);
    const text = await page.locator('#output').innerText();
    expect(text).toContain('Fido');
    expect(text).toContain('Tom');
    await page.locator('#examples').selectOption('counting-and-fetching');
    await settled(page);
    expect(await page.locator('#output pre.documents').count()).toBe(3);
  });

  it('stops at an error, says which line, and goes to it', async () => {
    const page = await open();
    await settled(page);
    const program = `${SCHEMA}\ninsert $a isa person, has name "A";\nend;\ninsert $b isa person, has name "A";\nend;\nmatch $p isa person;`;
    await run(page, program);
    const error = page.locator('#output .step.has-error .error');
    await error.waitFor();
    expect(await error.innerText()).toContain('Line 4:');
    expect(await page.locator('#status').innerText()).toBe('Stopped at an error.');
    // The statement after the error did not run.
    expect(await page.locator('#output .step').count()).toBe(3);
    await error.getByRole('button', { name: 'Go to line' }).click();
    const selected = await page.evaluate(() => {
      const editor = document.getElementById('editor') as HTMLTextAreaElement;
      return editor.value.slice(editor.selectionStart, editor.selectionEnd);
    });
    expect(selected).toBe('insert $b isa person, has name "A";');
  });

  it('names the line of a syntax error, and runs nothing', async () => {
    const page = await open();
    await settled(page);
    await run(page, `${SCHEMA}\nmatch $p isa ;`);
    const problem = page.locator('#output > .error');
    await problem.waitFor();
    expect(await problem.innerText()).toContain('Line 2:');
    expect(await page.locator('#output .step').count()).toBe(0);
  });

  it("shows a program's own text as text: it never becomes an element", async () => {
    const page = await open();
    await settled(page);
    const attack = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    await run(page, `${SCHEMA}\ninsert $a isa person, has name ${JSON.stringify(attack)};\nend;\nmatch $p isa person, has name $n; select $n;`);
    expect(await page.locator('#output img, #output script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // The read step's cell, not the write step's: an insert also shows what it inserted.
    expect(await page.locator('#output .step[data-kind="read"] td').first().innerText()).toBe(attack);
  });

  it('shares a program as a link that reproduces it, and runs it when opened', async () => {
    const first = await open();
    await settled(first);
    const program = `${SCHEMA}\ninsert $a isa person, has name "Zoë 🐶";\nend;\nmatch $p isa person, has name $n; select $n;`;
    await run(first, program);
    await first.locator('#share').click();
    await first.waitForFunction(() => /^(Link copied|The link is in the address bar)/.test(document.getElementById('status')?.textContent ?? ''));
    expect(first.url()).toContain('#code=');
    const second = await open(new URL(first.url()).hash);
    await settled(second);
    expect(await second.locator('#editor').inputValue()).toBe(program);
    expect(await second.locator('#output .step[data-kind="read"] td').first().innerText()).toBe('Zoë 🐶');
  });

  it('says so when a link cannot be read, and opens the first example instead', async () => {
    const page = await open('#code=%%%not-a-program');
    await settled(page);
    expect(await page.locator('#status').innerText()).toMatch(/Ran in/);
    expect(await page.locator('#editor').inputValue()).toContain('people and companies');
  });

  it('starts every run from an empty database, so one run never sees another', async () => {
    const page = await open();
    await settled(page);
    await run(page, `${SCHEMA}\ninsert $a isa person, has name "Ann";`);
    await run(page, `${SCHEMA}\nmatch $p isa person; select $p;`);
    expect(await page.locator('#output .step[data-kind="read"] tbody tr').count()).toBe(0);
    expect(await page.locator('#output').innerText()).toContain('0 candidate');
  });

  it('draws links in the accent colour, so they can be read on a dark page', async () => {
    const page = await open();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const [link, accent] = await page.evaluate(() => [getComputedStyle(document.querySelector('footer a')!).color, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()]);
      const hex = (rgb: string) => '#' + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      expect(hex(link!)).toBe(accent);
    }
  });

  it('switches between its light and dark logos with the browser theme', async () => {
    const page = await open();
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await page.locator('.logo-dark').isVisible()).toBe(true);
    expect(await page.locator('.logo-light').isVisible()).toBe(false);
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await page.locator('.logo-light').isVisible()).toBe(true);
  });

  it('fits a phone: no sideways scrolling, and the buttons are big enough to tap', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 700 } });
    const page = await context.newPage();
    await page.goto(`${site.url}/`);
    await settled(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // A wide table scrolls inside its step instead of being cut off: the page itself must not scroll
    // sideways, so without this the right-hand columns would be unreachable.
    const body = page.locator('#output .step[data-kind="write"] .body');
    const { overflowX, wider } = await body.evaluate((el) => ({ overflowX: getComputedStyle(el).overflowX, wider: el.scrollWidth > el.clientWidth }));
    expect(overflowX).toBe('auto');
    expect(wider).toBe(true);
    for (const id of ['run', 'share', 'examples']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
