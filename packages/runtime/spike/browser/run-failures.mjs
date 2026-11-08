// SPIKE — what happens to the other tabs when the OWNER tab fails in ways other than closing cleanly.
//
//   node spike/browser/run-failures.mjs
//
// Each scenario gets a fresh browser profile and three tabs (A owns). It records what the surviving
// tabs observe; it does not assert a preferred outcome, because the point is to find out.
//   crash   the owner tab's renderer crashes (CDP Page.crash)
//   frozen  the owner tab is frozen, as Chrome freezes background tabs (CDP Page.setWebLifecycleState)
//   hung    the owner's database Worker is stuck in a long synchronous statement
//   zombie  the owner tab is alive and holds the lock, but its database Worker is dead
import { killBrowser, startHarness, tempProfile } from './harness.mjs';
import { rmSync } from 'node:fs';

const TAB =
  '<!doctype html><meta charset="utf-8"><title>tab</title><script type="module" src="/tab.js"></script>';
const harness = await startHarness({
  entries: { 'owner-worker.js': 'owner-worker.ts', 'tab.js': 'tab.ts' },
  pages: { '/tab.html': TAB },
  port: 8768,
});

const status = (page) => page.evaluate(() => window.tab.status());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (what, check, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const PING = (tag) => `insert $p isa ping, has created-at "${tag}";`;
const HEAVY = (n) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${n}) SELECT count(*) AS n FROM c`;
const bookmarks = (page) =>
  page.evaluate(() => window.tab.ids().then((ids) => ids.length));
/** Run a request that may fail, returning how long it took and how it ended. */
const attempt = (page, message, options) =>
  page.evaluate(
    async ([m, o]) => {
      const started = performance.now();
      try {
        const reply = await window.tab.request(m, o);
        return {
          outcome: reply.ok ? 'ok' : `error: ${reply.error}`,
          attempts: reply.attempts,
          ms: Math.round(performance.now() - started),
        };
      } catch (error) {
        return {
          outcome: `threw: ${error.message}`,
          ms: Math.round(performance.now() - started),
        };
      }
    },
    [message, options],
  );

async function withTabs(options, body) {
  const profile = tempProfile();
  const context = await harness.launch(profile);
  try {
    const query = (wipe) =>
      `?${wipe ? 'wipe=1&' : ''}watchdog=${options.watchdog}&idempotent=${options.idempotent ? 1 : 0}`;
    const open = async (wipe) => {
      const page = await context.newPage();
      await page.goto(`${harness.origin}/tab.html${query(wipe)}`);
      return page;
    };
    const A = await open(true);
    await waitFor(
      'A to own the database',
      async () => (await status(A)).ownerReadyAt,
    );
    const B = await open(false);
    const C = await open(false);
    await A.evaluate(() => window.tab.insertMany('base', 10));
    await A.evaluate(() => window.tab.insertPings('base', 3));
    return await body({ context, A, B, C });
  } finally {
    killBrowser(profile);
    rmSync(profile, { recursive: true, force: true });
  }
}

// Production would use a longer watchdog (default 8 s); these are short so the run stays quick.
const BASELINE = { label: 'baseline', watchdog: 86_400_000, idempotent: false };
const MITIGATED = {
  label: 'watchdog+idempotency',
  watchdog: 3000,
  idempotent: true,
};
const count = (values, tag) => values.filter((v) => v === tag).length;

const scenarios = {
  crash: {
    modes: [MITIGATED],
    run: ({ context, A, B, C }) =>
      (async () => {
        const cdp = await context.newCDPSession(A);
        const crashedAt = Date.now();
        // Never resolves: its target is the thing that dies. Fire and forget.
        void cdp.send('Page.crash').catch(() => undefined);
        const owner = await waitFor(
          'a new owner after the crash',
          async () =>
            (await Promise.all([status(B), status(C)])).find(
              (s) => s.role === 'owner' && s.ownerReadyAt !== undefined,
            ),
          20000,
        ).catch(() => undefined);
        const writes = owner
          ? await B.evaluate(() => window.tab.insertMany('after', 20))
          : 'skipped: no owner emerged';
        return {
          newOwnerReadyMsAfterCrash: owner
            ? owner.ownerReadyAt - crashedAt
            : null,
          writes,
          rows: owner ? await bookmarks(B) : null,
          rowsExpected: 30,
        };
      })(),
  },

  frozen: {
    modes: [MITIGATED],
    run: ({ context, A, B, C }) =>
      (async () => {
        const cdp = await context.newCDPSession(A);
        await cdp.send('Page.enable');
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        await sleep(1500);
        // Did it actually freeze? A frozen page cannot answer an evaluate.
        const stillResponsive = await Promise.race([
          A.evaluate(() => true),
          sleep(2000).then(() => false),
        ]);
        if (stillResponsive) {
          return {
            valid: false,
            reason:
              'the command succeeded but the page kept running: headless Chromium reports every tab visible, and visible pages are not freeze-eligible. NOT TESTED.',
            visibility: await A.evaluate(() => document.visibilityState),
          };
        }
        const whileFrozen = await attempt(
          B,
          { op: 'execute', text: PING('while-frozen') },
          { attempts: 8, timeoutMs: 1000 },
        );
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        return {
          valid: true,
          whileFrozen,
          rolesWhileFrozen: {
            B: (await status(B)).role,
            C: (await status(C)).role,
          },
        };
      })(),
  },

  zombie: {
    modes: [BASELINE, MITIGATED],
    run: ({ A, B, C }) =>
      (async () => {
        await A.evaluate(() => window.tab.killWorker());
        const started = Date.now();
        const write = await attempt(
          B,
          { op: 'execute', text: PING('zombie') },
          { attempts: 12, timeoutMs: 1000 },
        );
        const [sa, sb, sc] = await Promise.all([
          status(A),
          status(B),
          status(C),
        ]);
        return {
          write,
          waitedMs: Date.now() - started,
          roles: { A: sa.role, B: sb.role, C: sc.role },
          abandoned: sa.abandoned,
          // A read after the write; with no owner it fails too, which is itself the result.
          pingsApplied: await B.evaluate(() =>
            window.tab
              .request(
                {
                  op: 'query',
                  text: 'match $p isa ping, has created-at $c; select $c;',
                },
                { attempts: 3, timeoutMs: 1000 },
              )
              .then((r) => r.rows.filter((row) => row.c === 'zombie').length),
          ).catch(() => 'unreachable: no owner answered'),
        };
      })(),
  },

  hung: {
    modes: [
      BASELINE,
      { label: 'idempotency only', watchdog: 86_400_000, idempotent: true },
    ],
    run: ({ A, B, C }) =>
      (async () => {
        // Calibrate so the hang lasts about five seconds on this machine.
        const probe = 2_000_000; // small: it must finish well inside the watchdog
        const probeMs = (
          await attempt(
            A,
            { op: 'pragma', text: HEAVY(probe) },
            { attempts: 1 },
          )
        ).ms;
        const n = Math.round((probe * 5000) / probeMs);
        const hang = attempt(
          C,
          { op: 'pragma', text: HEAVY(n) },
          { attempts: 1, timeoutMs: 60000 },
        );
        await sleep(400);
        // ONE unkeyed write while the owner is stuck. The client times out and retries every second.
        const write = await attempt(
          B,
          { op: 'execute', text: PING('during-hang') },
          {},
        );
        const hangMs = (await hang).ms;
        await sleep(300);
        return {
          hangMs,
          write,
          timesTheOneWriteWasApplied: count(
            await B.evaluate(() => window.tab.pingValues()),
            'during-hang',
          ),
        };
      })(),
  },

  'hung-past-watchdog': {
    modes: [MITIGATED],
    run: ({ A, B, C }) =>
      (async () => {
        const probe = 2_000_000; // small: it must finish well inside the watchdog
        const probeMs = (
          await attempt(
            A,
            { op: 'pragma', text: HEAVY(probe) },
            { attempts: 1 },
          )
        ).ms;
        const n = Math.round((probe * 8000) / probeMs); // about eight seconds, longer than the 3 s watchdog
        void attempt(
          C,
          { op: 'pragma', text: HEAVY(n) },
          { attempts: 1, timeoutMs: 20000 },
        ).catch(() => undefined);
        await sleep(400);
        const write = await attempt(
          B,
          { op: 'execute', text: PING('during-hang') },
          {},
        );
        const [sa, sb, sc] = await Promise.all([
          status(A),
          status(B),
          status(C),
        ]);
        return {
          write,
          abandonedByTab: { A: sa.abandoned, B: sb.abandoned, C: sc.abandoned },
          roles: { A: sa.role, B: sb.role, C: sc.role },
          timesTheOneWriteWasApplied: count(
            await B.evaluate(() => window.tab.pingValues()),
            'during-hang',
          ),
        };
      })(),
  },

  'owner-dies-after-apply': {
    modes: [
      { label: 'watchdog only', watchdog: 3000, idempotent: false },
      MITIGATED,
    ],
    run: ({ A, B, C }) =>
      (async () => {
        await A.evaluate(() => window.tab.armDie());
        // The owner applies this write, then its Worker exits before replying.
        const write = await attempt(
          B,
          { op: 'execute', text: PING('dies') },
          { attempts: 20, timeoutMs: 1000 },
        );
        const [sa, sb, sc] = await Promise.all([
          status(A),
          status(B),
          status(C),
        ]);
        return {
          write,
          roles: { A: sa.role, B: sb.role, C: sc.role },
          timesTheOneWriteWasApplied: count(
            await B.evaluate(() => window.tab.pingValues()),
            'dies',
          ),
        };
      })(),
  },

  'takeover-unkeyed': {
    modes: [{ ...BASELINE, watchdog: 3000 }, MITIGATED],
    run: ({ A, B, C }) =>
      (async () => {
        const slowB = B.evaluate(() => window.tab.insertPings('b', 40, 15));
        const slowC = C.evaluate(() => window.tab.insertPings('c', 40, 15));
        await sleep(200);
        await A.close();
        const [rb, rc] = await Promise.all([slowB, slowC]);
        const values = await B.evaluate(() => window.tab.pingValues());
        return {
          applied: rb.applied + rc.applied,
          duplicateRepliesSeen: rb.duplicateReplies + rc.duplicateReplies,
          failed: [...rb.failed, ...rc.failed],
          pingEntitiesStored: values.length,
          distinctValues: new Set(values).size,
          expected: 3 + 80,
        };
      })(),
  },
};

const only = process.argv[2];
const SCENARIO_MS = 120_000;
for (const [name, { modes, run }] of Object.entries(scenarios)) {
  if (only && only !== name) continue;
  for (const mode of modes) {
    let result;
    try {
      result = await Promise.race([
        withTabs(mode, run),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`scenario exceeded ${SCENARIO_MS} ms`)),
            SCENARIO_MS,
          ),
        ),
      ]);
    } catch (error) {
      result = { error: String(error.stack ?? error).slice(0, 500) };
    }
    console.log(
      JSON.stringify({ scenario: name, mode: mode.label, ...result }),
    );
  }
}
harness.stop();
process.exit(0);
