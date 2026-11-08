// SPIKE — several tabs, one database: who may open it, and what happens when the owner goes away.
//
//   node spike/browser/run-tabs.mjs
//
// 0. Control: two Workers that both try to open the OPFS database. Shows the problem an owner solves.
// 1. Three tabs elect one owner and write concurrently through it.
// 2. The owner tab is closed while the other two are writing: ownership moves, no write is lost or doubled.
// 3. The whole browser is restarted: every write is still there.
import { killBrowser, startHarness, tempProfile } from './harness.mjs';
import { rmSync } from 'node:fs';

const DIRECT = `<!doctype html><meta charset="utf-8"><title>direct</title><script>
const worker = new Worker('/owner-worker.js', { type: 'module' });
let next = 0; const waiting = new Map();
worker.onmessage = (e) => { const done = waiting.get(e.data.id); waiting.delete(e.data.id); done(e.data); };
window.rpc = (message) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); worker.postMessage({ id, ...message }); });
</script>`;
const TAB =
  '<!doctype html><meta charset="utf-8"><title>tab</title><script type="module" src="/tab.js"></script>';

const harness = await startHarness({
  entries: { 'owner-worker.js': 'owner-worker.ts', 'tab.js': 'tab.ts' },
  pages: { '/direct.html': DIRECT, '/tab.html': TAB },
  port: 8767,
});
const profile = tempProfile();
const report = {};
const SCHEMA =
  'define entity bookmark, owns bookmark-id @key; attribute bookmark-id, value string;';
const status = (page) => page.evaluate(() => window.tab.status());
const waitFor = async (what, check, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

let context = await harness.launch(profile);
try {
  // 0. Two Workers, no owner.
  {
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto(`${harness.origin}/direct.html`);
    await b.goto(`${harness.origin}/direct.html`);
    const first = await a.evaluate(
      (s) => window.rpc({ op: 'init', wipe: true, schema: s }),
      SCHEMA,
    );
    const second = await b.evaluate(
      (s) => window.rpc({ op: 'init', schema: s }),
      SCHEMA,
    );
    report.control = {
      first: first.ok ? 'opened' : first.error,
      second: second.ok ? 'opened' : second.error,
    };
    await a.close();
    await b.close();
  }

  // 1. Three tabs, one owner.
  const open = async (wipe) => {
    const page = await context.newPage();
    await page.goto(`${harness.origin}/tab.html${wipe ? '?wipe=1' : ''}`);
    return page;
  };
  const tabA = await open(true);
  await waitFor(
    'tab A to own the database',
    async () => (await status(tabA)).ownerReadyAt,
  );
  const tabB = await open(false);
  const tabC = await open(false);
  const roles = await Promise.all([tabA, tabB, tabC].map(status));
  report.election = {
    roles: roles.map((r) => r.role),
    owners: roles.filter((r) => r.role === 'owner').length,
  };

  const write = (page, prefix, n, pause = 0) =>
    page.evaluate(
      ([p, c, ms]) => window.tab.insertMany(p, c, ms),
      [prefix, n, pause],
    );
  const phase1Start = Date.now();
  const [wa, wb, wc] = await Promise.all([
    write(tabA, 'a', 20),
    write(tabB, 'b', 20),
    write(tabC, 'c', 20),
  ]);
  const afterPhase1 = await tabB.evaluate(() => window.tab.ids());
  report.concurrentWrites = {
    ms: Date.now() - phase1Start,
    results: { a: wa, b: wb, c: wc },
    rowsExpected: 60,
    rowsFound: afterPhase1.length,
    distinct: new Set(afterPhase1).size,
  };

  // 2. Close the owner while B and C are mid-write.
  const slowB = write(tabB, 'b2', 40, 15);
  const slowC = write(tabC, 'c2', 40, 15);
  await new Promise((r) => setTimeout(r, 200));
  const closeStarted = Date.now();
  await tabA.close();
  const closeFinished = Date.now();
  const [rb, rc] = await Promise.all([slowB, slowC]);
  const [sb, sc] = await Promise.all([status(tabB), status(tabC)]);
  const newOwner = [sb, sc].filter((s) => s.role === 'owner');
  const afterTakeover = await tabB.evaluate(() => window.tab.ids());
  const expected = 60 + 80;
  report.takeover = {
    ownersAfter: newOwner.length,
    newOwnerReadyMsAfterClose:
      newOwner[0]?.ownerReadyAt === undefined
        ? null
        : newOwner[0].ownerReadyAt - closeFinished,
    closeCallMs: closeFinished - closeStarted,
    poolOpenRetries: newOwner[0]?.initRetries,
    writes: { b2: rb, c2: rc },
    retriedRequests: sb.stats.retried + sc.stats.retried,
    slowestRequestMs: Math.round(
      Math.max(sb.stats.maxLatencyMs, sc.stats.maxLatencyMs),
    ),
    rowsExpected: expected,
    rowsFound: afterTakeover.length,
    distinct: new Set(afterTakeover).size,
  };

  // 3. Restart the whole browser.
  await context.close();
  context = await harness.launch(profile);
  const fresh = await context.newPage();
  await fresh.goto(`${harness.origin}/tab.html`);
  const afterRestart = await fresh.evaluate(() => window.tab.ids());
  report.afterBrowserRestart = {
    rowsExpected: expected,
    rowsFound: afterRestart.length,
    distinct: new Set(afterRestart).size,
  };

  const all = [wa, wb, wc, rb, rc];
  report.pass =
    report.control.second !== 'opened' &&
    report.election.owners === 1 &&
    report.concurrentWrites.rowsFound === 60 &&
    report.takeover.ownersAfter === 1 &&
    report.takeover.rowsFound === expected &&
    report.takeover.distinct === expected &&
    afterRestart.length === expected &&
    new Set(afterRestart).size === expected &&
    all.every((r) => r.failed.length === 0);
} catch (error) {
  report.error = String(error.stack ?? error).slice(0, 800);
  report.pass = false;
} finally {
  console.log(JSON.stringify(report, null, 2));
  killBrowser(profile);
  rmSync(profile, { recursive: true, force: true });
  harness.stop();
}
process.exit(report.pass ? 0 : 2);
