// SPIKE — drive the Worker in a real Chromium and prove OPFS persistence across a browser restart.
//
//   node spike/browser/run.mjs [items] [tags]
//
// Builds the Worker with esbuild, serves it on a fixed localhost origin (OPFS is per-origin), runs
// the write phase, CLOSES the browser, launches a new one on the same profile, and runs the read phase.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const items = Number(process.argv[2] ?? 3000);
const tags = Number(process.argv[3] ?? 25);
const out = mkdtempSync(join(tmpdir(), 'typedblite-browser-'));
const profile = mkdtempSync(join(tmpdir(), 'typedblite-profile-'));
const PORT = 8765;

// The shim must match Node's SHA-256 exactly, or browser revisions would not equal server ones.
{
  const shimOut = join(out, 'shim.mjs');
  await build({
    entryPoints: [join(here, 'node-crypto-shim.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: shimOut,
    logLevel: 'error',
  });
  const { createHash: shim } = await import(shimOut);
  const { createHash: real, randomBytes } = await import('node:crypto');
  let checked = 0;
  for (let length = 0; length < 300; length++) {
    for (const text of [
      randomBytes(length).toString('latin1'),
      'é€😀'.repeat(length % 7) + 'x'.repeat(length),
    ]) {
      const a = shim('sha256')
        .update(text)
        .update('\0')
        .update('parent')
        .digest('hex');
      const b = real('sha256')
        .update(text)
        .update('\0')
        .update('parent')
        .digest('hex');
      if (a !== b)
        throw new Error(
          `SHA-256 shim differs from node:crypto at length ${length}`,
        );
      checked++;
    }
  }
  console.log(
    `sha256 shim matches node:crypto on ${checked} inputs (0..300 bytes, incl. multi-byte UTF-8)`,
  );
}

// Two swaps, the browser's equivalent of vitest.wasm.config.ts, plus the Node-only crypto.
const browserSwaps = {
  name: 'browser-swaps',
  setup(b) {
    b.onResolve({ filter: /^node:crypto$/ }, () => ({
      path: join(here, 'node-crypto-shim.ts'),
    }));
    b.onResolve({ filter: /(^|\/)node-sqlite\.js$/ }, (args) =>
      /[\\/]src[\\/]/.test(args.importer)
        ? { path: join(here, '../wasm-opener.ts') }
        : undefined,
    );
  },
};

await build({
  plugins: [browserSwaps],
  entryPoints: [join(here, 'worker.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(out, 'worker.js'),
  logLevel: 'error',
  // The interpreter reaches `process` only behind a guard; nothing else Node-specific is bundled.
  define: { 'process.env.NODE_ENV': '"production"' },
});
const wasm = join(
  here,
  '../../../../../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm',
);
copyFileSync(wasm, join(out, 'sqlite3.wasm'));
const bundleKb = Math.round(readFileSync(join(out, 'worker.js')).length / 1024);
const wasmKb = Math.round(
  readFileSync(join(out, 'sqlite3.wasm')).length / 1024,
);

const types = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
};
const page = `<!doctype html><meta charset="utf-8"><title>spike</title><script>
window.runPhase = (request) => new Promise((resolve) => {
  const worker = new Worker('/worker.js', { type: 'module' });
  worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
  worker.onerror = (e) => resolve({ ok: false, error: 'worker error: ' + e.message });
  worker.postMessage(request);
});
</script>`;
const server = createServer((req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (path === '/index.html')
    return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  const file = join(out, path);
  if (!existsSync(file)) return res.writeHead(404).end();
  res
    .writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
    })
    .end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const executable = (() => {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  return join(root, dir, 'chrome-linux', 'chrome');
})();

async function session(request) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: executable,
    args: ['--no-sandbox'],
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const response = await page.evaluate((r) => window.runPhase(r), request);
  await context.close(); // the whole browser process: nothing survives except the profile on disk
  return { response, userAgent, logs };
}

// First, isolate flushing from rediscovery: a second page in the SAME browser, before it closes.
{
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: executable,
    args: ['--no-sandbox'],
  });
  const run = async (request) => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const r = await page.evaluate((q) => window.runPhase(q), request);
    await page.close();
    return r;
  };
  const w = await run({ phase: 'write', items: 30, tags: 4 });
  const same = await run({
    phase: 'read',
    items: 30,
    tags: 4,
    expected: w.result?.counts,
  });
  console.log(
    'same-browser reload ->',
    JSON.stringify({
      wrote: w.ok,
      pool: w.pool,
      reloadOk: same.ok,
      matches: same.result?.matchesWhatWasWritten,
      error: same.error,
    }),
  );
  await context.close();
}

const write = await session({ phase: 'write', items, tags });
console.log(
  JSON.stringify(
    {
      bundleKb,
      wasmKb,
      userAgent: write.userAgent,
      write: write.response,
      logs: write.logs.slice(0, 5),
    },
    null,
    2,
  ),
);
// Never let a quiet fallback to memory pass as persistence: the file must be in the OPFS pool.
if (write.response.ok && !write.response.pool?.files?.includes('/reader.db')) {
  console.error(
    'FAIL: /reader.db is not in the OPFS SAH pool; the run was not using OPFS.',
    JSON.stringify(write.response.pool),
  );
  server.close();
  process.exit(3);
}
if (!write.response.ok) {
  server.close();
  process.exit(1);
}

const read = await session({
  phase: 'read',
  items,
  tags,
  expected: write.response.result.counts,
});
console.log(
  JSON.stringify({ read: read.response, logs: read.logs.slice(0, 5) }, null, 2),
);

server.close();
rmSync(out, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
process.exit(
  read.response.ok && read.response.result.matchesWhatWasWritten ? 0 : 2,
);
