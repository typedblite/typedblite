// SPIKE — serve a page that puts the TypeDBLite interpreter behind `window.typedblite`, for your own browser.
//
//   node spike/browser/serve-console.mjs [port]
//
// Open the printed URL in Chrome, open DevTools (F12), and use the Console:
//
//   typedblite.help()
//   await typedblite.define('define attribute title, value string; entity doc, owns title;')
//   await typedblite.execute('insert $d isa doc, has title "hello";')
//   await typedblite.table('match $d isa doc, has title $t; select $t;')
//
// Data lives in YOUR browser profile's OPFS for this exact origin, so it survives reloads and restarts.
// Add ?wipe=1 to start from an empty database. It only takes effect if this tab is the first to open the
// database (no other tab owns it), and the page removes it from the address bar, so a reload cannot repeat it.
import { startHarness } from './harness.mjs';

const port = Number(process.argv[2] ?? 8795);
const PAGE =
  '<!doctype html><meta charset="utf-8"><title>TypeDBLite console</title>' +
  '<body style="font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem">' +
  '<h1>TypeDBLite</h1><p>Open DevTools (F12) and use the Console. Start with <code>typedblite.help()</code>.</p>' +
  '<script type="module" src="/tab.js"></script>';
const harness = await startHarness({
  entries: { 'owner-worker.js': 'owner-worker.ts', 'tab.js': 'tab.ts' },
  pages: { '/': PAGE, '/tab.html': PAGE },
  port,
});
console.log(
  `\nTypeDBLite console page:  ${harness.origin}/\n(add ?wipe=1 to start from an empty database; it only applies if no other tab has the database open; Ctrl-C to stop)\n`,
);
process.on('SIGINT', () => {
  harness.stop();
  process.exit(0);
});
