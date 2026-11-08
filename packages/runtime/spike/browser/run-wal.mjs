// SPIKE — does WAL work on WASM SQLite? Probes each storage option, with and without cross-origin isolation.
//
//   node spike/browser/run-wal.mjs
import { killBrowser, startHarness, tempProfile } from './harness.mjs';
import { rmSync } from 'node:fs';

const PAGE = `<!doctype html><meta charset="utf-8"><title>wal</title><script>
window.probe = () => new Promise((resolve) => {
  const worker = new Worker('/wal-probe-worker.js', { type: 'module' });
  worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
  worker.onerror = (e) => resolve({ error: 'worker error: ' + e.message });
});
</script>`;
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

for (const [label, headers, port] of [
  ['no COOP/COEP headers', {}, 8793],
  ['with COOP/COEP headers', ISOLATION, 8794],
]) {
  const harness = await startHarness({
    entries: { 'wal-probe-worker.js': 'wal-probe-worker.ts' },
    pages: { '/p.html': PAGE },
    port,
    headers,
  });
  const profile = tempProfile();
  const context = await harness.launch(profile);
  try {
    const page = await context.newPage();
    await page.goto(`${harness.origin}/p.html`);
    const out = await Promise.race([
      page.evaluate(() => window.probe()),
      new Promise((r) =>
        setTimeout(() => r({ error: 'probe timed out after 30 s' }), 30000),
      ),
    ]);
    console.log(`\n== ${label} ==`);
    if (out.error) console.log('ERROR', out.error);
    else {
      console.log('facts:', JSON.stringify(out.facts));
      for (const r of out.results)
        console.log(
          ' -',
          r.label.padEnd(42),
          r.error
            ? `ERROR ${r.error}`
            : `before=${r.journalModeBefore}  askedForWAL -> ${r.afterAskingForWal}  accepted=${r.walAccepted}`,
        );
    }
  } finally {
    killBrowser(profile);
    rmSync(profile, { recursive: true, force: true });
    harness.stop();
  }
}
process.exit(0);
