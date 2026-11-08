// SPIKE — shared plumbing for the browser drivers: bundle the entries with esbuild, serve them on a
// fixed localhost origin (OPFS is per-origin), and launch / kill a real Chromium on a given profile.
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
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));

/** The two swaps vitest.wasm.config.ts makes, plus the Node-only crypto, for a browser bundle. */
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

const types = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
};

/**
 * @param {{ entries: Record<string, string>, pages: Record<string, string>, port?: number, headers?: Record<string, string> }} options
 *   `entries` maps an output file name to a source file beside this one; `pages` maps a URL path to HTML; `headers` are added to every response
 *   (for example COOP/COEP, to make the page cross-origin isolated).
 */
export async function startHarness({
  entries,
  pages,
  port = 8765,
  headers = {},
}) {
  const out = mkdtempSync(join(tmpdir(), 'typedblite-browser-'));
  for (const [outName, source] of Object.entries(entries)) {
    await build({
      plugins: [browserSwaps],
      entryPoints: [join(here, source)],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outfile: join(out, outName),
      logLevel: 'error',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  }
  copyFileSync(
    join(
      here,
      '../../../../../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm',
    ),
    join(out, 'sqlite3.wasm'),
  );

  // The stock 'opfs' and 'opfs-wl' VFSes run SQLite's I/O through a second Worker, which the module
  // looks for beside the script that loaded it.
  copyFileSync(
    join(
      here,
      '../../../../../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-opfs-async-proxy.js',
    ),
    join(out, 'sqlite3-opfs-async-proxy.js'),
  );

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (pages[path] !== undefined)
      return res
        .writeHead(200, { 'content-type': 'text/html', ...headers })
        .end(pages[path]);
    // The request path is attacker-shaped (a raw `..` is not normalised away before it reaches here),
    // so resolve it and refuse anything that lands outside the directory being served.
    const file = resolve(out, `.${path}`);
    if (!file.startsWith(out + sep)) return res.writeHead(403).end();
    if (!existsSync(file)) return res.writeHead(404).end();
    res
      .writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        ...headers,
      })
      .end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const executable = join(root, dir, 'chrome-linux', 'chrome');
  const bundleKb = Object.fromEntries(
    Object.keys(entries).map((name) => [
      name,
      Math.round(readFileSync(join(out, name)).length / 1024),
    ]),
  );

  return {
    origin: `http://127.0.0.1:${port}`,
    bundleKb,
    wasmKb: Math.round(readFileSync(join(out, 'sqlite3.wasm')).length / 1024),
    /** A real, persistent Chromium on `profile` — the profile directory is the only thing a restart keeps. */
    launch: (profile, extraArgs = []) =>
      chromium.launchPersistentContext(profile, {
        headless: true,
        executablePath: executable,
        args: ['--no-sandbox', ...extraArgs],
      }),
    stop() {
      server.close();
      rmSync(out, { recursive: true, force: true });
    },
  };
}

/** SIGKILL every process whose command line names `profile`: the browser and its renderers/workers die at once. */
export function killBrowser(profile) {
  let killed = 0;
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmdline.includes(profile) && Number(pid) !== process.pid) {
        process.kill(Number(pid), 'SIGKILL');
        killed++;
      }
    } catch {
      // The process exited between listing and reading; nothing to kill.
    }
  }
  return killed;
}

export const tempProfile = () =>
  mkdtempSync(join(tmpdir(), 'typedblite-profile-'));
