/**
 * SPIKE check: drives the single page headlessly and prints what happened. Run:
 *   node build-spike.mjs --serve 4400 &   then   node spike-check.mjs [chromium|firefox|webkit]
 */
import { chromium, firefox, webkit } from 'playwright-core';

const engine = { chromium, firefox, webkit }[process.argv[2] ?? 'chromium'];
const url = process.env.SPIKE_URL ?? 'http://127.0.0.1:4400/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};

const browser = await engine.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`  [console ${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
await page.goto(`${url}?${Date.now()}`);
await page.evaluate(() => navigator.storage.getDirectory().then(async (d) => { for await (const [n] of d.entries()) await d.removeEntry(n, { recursive: true }); }));
await page.reload();

const dev = (n) => page.frames().find((f) => f.url().includes(`device=${n}`));
const state = (n) => dev(n)?.evaluate(() => window.typedbliteDemo.state());
const hub = () => page.evaluate(() => window.spike.state());

check('all three devices online', await until(async () => (await Promise.all(['a', 'b', 'c'].map(state))).every((s) => s?.online === true)));
check('hub store opened in a dedicated Worker (OPFS)', await until(async () => (await hub()).info?.opfs === true));

await dev('a').evaluate(() => window.typedbliteDemo.add('from A'));
check('A → hub → B and C', await until(async () => (await Promise.all(['b', 'c'].map(state))).every((s) => s?.tasks.some((t) => t.title === 'from A'))));
check('hub holds it', (await hub()).tasks.some((t) => t.title === 'from A'));

await page.evaluate(() => window.spike.down());
check('hub down: devices go offline', await until(async () => (await Promise.all(['a', 'b', 'c'].map(state))).every((s) => s?.online === false), 20000));
await dev('b').evaluate(() => window.typedbliteDemo.add('written offline on B'));
await dev('c').evaluate(() => window.typedbliteDemo.add('written offline on C'));
check('offline writes are queued', await until(async () => (await state('b')).pending >= 1));

await page.evaluate(() => window.spike.down()); // the same button brings it back up
check('hub back up: devices online again', await until(async () => (await Promise.all(['a', 'b', 'c'].map(state))).every((s) => s?.online === true), 30000));
check('offline writes converge on every device', await until(async () => (await Promise.all(['a', 'b', 'c'].map(state))).every((s) => ['from A', 'written offline on B', 'written offline on C'].every((t) => s.tasks.some((x) => x.title === t))), 20000));
const h1 = await hub();
check('hub reopened its store with data intact', h1.tasks.length === 3, `${h1.tasks.length} tasks, ${h1.info?.openAttempts} open attempt(s)`);

// The whole page closes and reopens: every worker dies, OPFS stays.
await page.reload();
check('after a reload the hub still has all 3', await until(async () => (await hub()).tasks.length === 3));
check('after a reload devices resume with their data', await until(async () => (await Promise.all(['a', 'b', 'c'].map(state))).every((s) => s?.tasks.length === 3 && s.online === true)));

// A second tab owns its own hub worker, and the store allows one connection: what does it do?
const second = await context.newPage();
await second.goto(`${url}?${Date.now()}`);
await new Promise((r) => setTimeout(r, 13000));
const other = await second.evaluate(() => window.spike.state());
console.log(`  second tab's hub: opfs=${other.info?.opfs} attempts=${other.info?.openAttempts} error=${other.info?.lastOpenError || '(none)'}`);
console.log(`  hub info: ${JSON.stringify((await hub()).info)}`);

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
