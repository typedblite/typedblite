// SPIKE — type real expressions into a page's DevTools console and check what comes back.
//
//   node spike/browser/run-console.mjs
//
// Uses the DevTools protocol's Runtime.evaluate with replMode (top-level await, as the Console allows),
// so these are the same expressions a person would type. Also checks a second tab and a browser restart.
import { killBrowser, startHarness, tempProfile } from './harness.mjs';
import { rmSync } from 'node:fs';

const TAB =
  '<!doctype html><meta charset="utf-8"><title>tab</title><script type="module" src="/tab.js"></script>';
const harness = await startHarness({
  entries: { 'owner-worker.js': 'owner-worker.ts', 'tab.js': 'tab.ts' },
  pages: { '/tab.html': TAB },
  port: 8796,
});
const profile = tempProfile();
let context = await harness.launch(profile);
const transcript = [];
const logs = new WeakMap(); // page -> console messages
let failures = 0;

/** Evaluate `expression` as the Console would. */
async function type(page, expression, expectation) {
  const cdp = await page.context().newCDPSession(page);
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    replMode: true,
    returnByValue: true,
    userGesture: true,
  });
  await cdp.detach();
  const shown = r.exceptionDetails
    ? `Uncaught ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`.split(
        '\n',
      )[0]
    : JSON.stringify(r.result.value);
  const ok = expectation(r);
  if (!ok) failures++;
  transcript.push(`${ok ? '  ok' : 'FAIL'}  > ${expression}\n        ${shown}`);
  return r;
}
const value = (r) => r.result?.value;

try {
  const open = async (wipe) => {
    const page = await context.newPage();
    logs.set(page, []);
    page.on('console', (m) => logs.get(page).push(m.text()));
    await page.goto(`${harness.origin}/tab.html${wipe ? '?wipe=1' : ''}`);
    await page.waitForFunction(() => window.typedblite, null, {
      timeout: 15000,
    });
    return page;
  };
  const A = await open(true);
  await new Promise((r) => setTimeout(r, 800));

  await type(A, 'typedblite.help().split("\\n")[0]', (r) =>
    String(value(r)).startsWith('typedblite.query'),
  );
  await type(
    A,
    `await typedblite.define('define attribute title, value string; entity doc, owns title;')`,
    (r) => value(r) === 'ok',
  );
  await type(
    A,
    `await typedblite.execute('insert $d isa doc, has title "hello from the console";')`,
    (r) => value(r) === 'ok',
  );
  await type(
    A,
    `await typedblite.query('match $d isa doc, has title $t; select $t;')`,
    (r) => JSON.stringify(value(r)) === '[{"t":"hello from the console"}]',
  );
  await type(
    A,
    `await typedblite.query('match $d isa doc; select $d;')`,
    (r) => value(r)?.[0]?.d?.kind === 'entity' && value(r)[0].d.type === 'doc',
  );
  await type(
    A,
    `await typedblite.query('match $x isa nothing-defined; select $x;')`,
    (r) => Boolean(r.exceptionDetails),
  );
  await type(A, 'typedblite.status().role', (r) => value(r) === 'owner');

  // A second tab shares the database through the owner.
  const B = await open(false);
  await type(B, 'typedblite.status().role', (r) => value(r) === 'candidate');
  await type(
    B,
    `await typedblite.query('match $d isa doc, has title $t; select $t;')`,
    (r) => JSON.stringify(value(r)) === '[{"t":"hello from the console"}]',
  );
  await type(
    B,
    `await typedblite.execute('insert $d isa doc, has title "written from the second tab";')`,
    (r) => value(r) === 'ok',
  );
  await type(
    A,
    `(await typedblite.query('match $d isa doc, has title $t; select $t;')).length`,
    (r) => value(r) === 2,
  );

  // The wipe flag must not destroy a database that is in use.
  // 1. Reloading a page that was opened with ?wipe=1 must not wipe again.
  const W = await open(true); // ?wipe=1 while A and B already exist: another tab owns the database
  await new Promise((r) => setTimeout(r, 800));
  await type(
    W,
    'new URL(location.href).searchParams.has("wipe")',
    (r) => value(r) === false,
  );
  // ...and it says so, rather than silently ignoring the request.
  await type(W, '"console message about the ignored wipe"', () =>
    logs.get(W).some((m) => m.includes('?wipe=1 was ignored')),
  );
  await type(
    W,
    `(await typedblite.query('match $d isa doc, has title $t; select $t;')).length`,
    (r) => value(r) === 2,
  );
  // 2. A tab that was opened with ?wipe=1 while another tab owned the database must not wipe it when it
  //    later takes over ownership.
  await A.close();
  await B.close();
  await new Promise((r) => setTimeout(r, 1500)); // W is the only tab left, so it becomes owner
  await type(W, 'typedblite.status().role', (r) => value(r) === 'owner');
  await type(
    W,
    `(await typedblite.query('match $d isa doc, has title $t; select $t;')).length`,
    (r) => value(r) === 2,
  );
  // 3. Reloading the (former ?wipe=1) tab keeps the data.
  await W.reload();
  await W.waitForFunction(() => window.typedblite, null, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1000));
  await type(
    W,
    `(await typedblite.query('match $d isa doc, has title $t; select $t;')).length`,
    (r) => value(r) === 2,
  );

  // A full browser restart.
  await context.close();
  context = await harness.launch(profile);
  const C = await open(false);
  await new Promise((r) => setTimeout(r, 800));
  await type(
    C,
    `(await typedblite.query('match $d isa doc, has title $t; select $t;')).map(r => r.t).sort()`,
    (r) =>
      JSON.stringify(value(r)) ===
      '["hello from the console","written from the second tab"]',
  );

  // Control: a ?wipe=1 tab that IS first (nobody owns the database) still wipes, which is what it is for.
  await C.close();
  await new Promise((r) => setTimeout(r, 1500));
  const D = await open(true);
  await new Promise((r) => setTimeout(r, 800));
  await type(
    D,
    `await typedblite.query('match $d isa doc, has title $t; select $t;')`,
    (r) => Boolean(r.exceptionDetails),
  );
  await type(
    D,
    'new URL(location.href).searchParams.has("wipe")',
    (r) => value(r) === false,
  );
} catch (error) {
  failures++;
  transcript.push(`FAIL  ${String(error.stack ?? error).slice(0, 400)}`);
} finally {
  console.log(transcript.join('\n'));
  console.log(
    failures === 0
      ? '\nall console expressions behaved as expected'
      : `\n${failures} failure(s)`,
  );
  killBrowser(profile);
  rmSync(profile, { recursive: true, force: true });
  harness.stop();
}
process.exit(failures === 0 ? 0 : 2);
