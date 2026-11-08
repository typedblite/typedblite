// SPIKE — what request-id idempotency costs per write, and whether the id table stays bounded.
//
//   node spike/browser/run-idempotency.mjs [writesPerRound] [rounds]
//
// Everything runs in the owner Worker on real OPFS in headless Chromium, timed inside the Worker so
// message passing is not part of the number.
import { killBrowser, startHarness, tempProfile } from './harness.mjs';
import { rmSync } from 'node:fs';

const PAGE = `<!doctype html><meta charset="utf-8"><title>idempotency</title><script>
const worker = new Worker('/owner-worker.js', { type: 'module' });
let next = 0; const waiting = new Map();
worker.onmessage = (e) => { const done = waiting.get(e.data.id); waiting.delete(e.data.id); done(e.data); };
window.rpc = (message) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); worker.postMessage({ id, ...message }); });
</script>`;
const SCHEMA =
  'define entity ping, owns created-at; attribute created-at, value string;';
const WRITES = Number(process.argv[2] ?? 1000);
const ROUNDS = Number(process.argv[3] ?? 4);

const harness = await startHarness({
  entries: { 'owner-worker.js': 'owner-worker.ts' },
  pages: { '/p.html': PAGE },
  port: 8772,
});
const profile = tempProfile();
const context = await harness.launch(profile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

let page;
const open = async () => {
  page = await context.newPage();
  await page.goto(`${harness.origin}/p.html`);
};
const rpc = async (message) => {
  const reply = await page.evaluate((m) => window.rpc(m), message);
  if (!reply.ok) throw new Error(`${message.op}: ${reply.error}`);
  return reply;
};
const size = async () => {
  const pages = Number(
    (await rpc({ op: 'pragma', text: 'PRAGMA page_count' })).rows[0].page_count,
  );
  const bytes = Number(
    (await rpc({ op: 'pragma', text: 'PRAGMA page_size' })).rows[0].page_size,
  );
  return pages * bytes;
};
const pingsWithValue = async (value) =>
  (
    await rpc({
      op: 'query',
      text: 'match $p isa ping, has created-at $c; select $c;',
    })
  ).rows.filter((r) => r.c === value).length;

const report = {};
try {
  // ---- cost -------------------------------------------------------------------------------------
  await open();
  await rpc({ op: 'init', wipe: true, schema: SCHEMA });
  const timings = { plain: [], idempotent: [] };
  const growth = { plain: [], idempotent: [] };
  await rpc({ op: 'bench', count: 200, idempotent: false }); // warm-up, discarded
  for (let r = 0; r < ROUNDS; r++) {
    for (const idempotent of r % 2 === 0 ? [false, true] : [true, false]) {
      const before = await size();
      const { perWriteMs } = await rpc({
        op: 'bench',
        count: WRITES,
        idempotent,
      });
      const after = await size();
      const key = idempotent ? 'idempotent' : 'plain';
      timings[key].push(perWriteMs);
      growth[key].push((after - before) / WRITES);
    }
  }
  const plain = median(timings.plain);
  const idem = median(timings.idempotent);
  // Rounds run one after the other on a growing database, so compare WITHIN a round: each round's two
  // measurements are adjacent in time and see nearly the same database.
  const paired = timings.idempotent.map((v, r) => v - timings.plain[r]);
  const pairedPct = timings.idempotent.map(
    (v, r) => ((v - timings.plain[r]) / timings.plain[r]) * 100,
  );
  report.cost = {
    writesPerRound: WRITES,
    rounds: ROUNDS,
    perWriteMs: { plain: round(plain, 3), idempotent: round(idem, 3) },
    extraMsPerWrite: round(idem - plain, 3),
    pairedExtraMsPerWrite: {
      min: round(Math.min(...paired), 3),
      median: round(median(paired), 3),
      max: round(Math.max(...paired), 3),
    },
    pairedExtraPercent: {
      min: round(Math.min(...pairedPct), 1),
      median: round(median(pairedPct), 1),
      max: round(Math.max(...pairedPct), 1),
    },
    roundsWhereIdempotentWasSlower: paired.filter((d) => d > 0).length,
    slowdown: round(idem / plain),
    allRoundsMs: {
      plain: timings.plain.map((v) => round(v, 3)),
      idempotent: timings.idempotent.map((v) => round(v, 3)),
    },
    fileBytesAddedPerWrite: {
      plain: round(median(growth.plain), 1),
      idempotent: round(median(growth.idempotent), 1),
    },
  };

  // ---- a retry inside the retention window is recognised; one after pruning is not ---------------
  await rpc({ op: 'init', wipe: true, schema: SCHEMA });
  const write = (id, tag) =>
    rpc({
      op: 'execute',
      requestId: id,
      text: `insert $p isa ping, has created-at "${tag}";`,
    });
  for (let i = 0; i < 20; i++) await write(`r-${i}`, `r-${i}`);
  const within = await write('r-0', 'r-0');
  await sleep(60);
  const pruned = await rpc({ op: 'prune', olderThanMs: 0 });
  const afterPrune = (await rpc({ op: 'appliedCount' })).count;
  const lateRetry = await write('r-0', 'r-0');
  report.retention = {
    retryWithinRetention:
      within.duplicate === true ? 'recognised as a duplicate' : 'APPLIED AGAIN',
    removedByPrune: pruned.removed,
    idsRemainingAfterPrune: afterPrune,
    retryAfterPrune:
      lateRetry.duplicate === true
        ? 'recognised'
        : 'applied again (protection is lost once an id is pruned)',
    timesValueStored: await pingsWithValue('r-0'),
  };

  // ---- the table stays bounded under a steady write rate -----------------------------------------
  await page.reload();
  await rpc({ op: 'init', wipe: true, schema: SCHEMA, retentionMs: 1000 });
  const counts = [];
  for (let b = 0; b < 6; b++) {
    await rpc({ op: 'bench', count: 500, idempotent: true });
    counts.push((await rpc({ op: 'appliedCount' })).count);
    await sleep(1200); // past the 1 s retention, so the next sweep can remove this batch
  }
  report.boundedGrowth = {
    retentionMs: 1000,
    writesTotal: 3000,
    idsRememberedAfterEachBatchOf500: counts,
    maxRemembered: Math.max(...counts),
  };

  // ---- a new owner clears what expired while nobody owned the database ----------------------------
  await page.reload();
  await rpc({ op: 'init', wipe: true, schema: SCHEMA, retentionMs: 1000 });
  await rpc({ op: 'bench', count: 100, idempotent: true });
  const beforeReopen = (await rpc({ op: 'appliedCount' })).count;
  await sleep(1300);
  await page.reload(); // a different Worker, as after a change of owner
  await rpc({ op: 'init', schema: SCHEMA, retentionMs: 1000 });
  report.sweepOnTakeover = {
    idsBefore: beforeReopen,
    idsAfterNewOwnerOpens: (await rpc({ op: 'appliedCount' })).count,
  };

  // ---- what a big prune costs -------------------------------------------------------------------
  await page.reload();
  await rpc({ op: 'init', wipe: true, schema: SCHEMA, retentionMs: 600_000 });
  await rpc({ op: 'bench', count: 5000, idempotent: true });
  await sleep(60);
  const idsBefore = (await rpc({ op: 'appliedCount' })).count;
  const started = Date.now();
  const removed = (await rpc({ op: 'prune', olderThanMs: 0 })).removed;
  report.pruneCost = { idsBefore, removed, ms: Date.now() - started };

  const c = report.cost;
  report.pass =
    report.retention.retryWithinRetention === 'recognised as a duplicate' &&
    report.retention.timesValueStored === 2 && // the late retry, after pruning, was applied again
    report.boundedGrowth.maxRemembered < 1500 &&
    report.sweepOnTakeover.idsAfterNewOwnerOpens === 0 &&
    report.pruneCost.removed === report.pruneCost.idsBefore &&
    Number.isFinite(c.slowdown);
} catch (error) {
  report.error = String(error.stack ?? error).slice(0, 600);
  report.pass = false;
} finally {
  console.log(JSON.stringify(report, null, 2));
  killBrowser(profile);
  rmSync(profile, { recursive: true, force: true });
  harness.stop();
}
process.exit(report.pass ? 0 : 2);
