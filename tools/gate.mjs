// The gate, run locally: `npm run gate`. GitHub Actions is off for now, so this is the only check.
//
//   npm run gate               everything below
//   npm run gate -- --quick    the first six steps only: no e2e, WASM, browser or clean-room steps
//
// Every step runs from a CLEAN tree and with Nx's cache off. `build` is `tsc -b`, which is incremental:
// a library whose sources did not change is not re-emitted, so its dependants are judged against stale
// declarations (docs/development/testing.md#the-clean-tree-gate). A cached task would hide the same thing.
//
// Steps stop at the first failure and say which, so a red gate names its cause.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const quick = process.argv.includes('--quick');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--quick');
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: npm run gate [-- --quick]`);
  process.exit(2);
}

/** Delete build output, so that nothing is judged against a stale declaration. */
function clean() {
  const SKIP = new Set(['node_modules', '.git', '.vscode-test']);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsbuildinfo')) rmSync(path);
    }
  };
  for (const group of ['libs', 'apps']) {
    for (const project of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (project.isDirectory()) rmSync(join(ROOT, group, project.name, 'out'), { recursive: true, force: true });
    }
  }
  // The Theme Bridge is a second extension inside apps/vscode, with an `out` of its own.
  rmSync(join(ROOT, 'apps/vscode/theme-bridge/out'), { recursive: true, force: true });
  // Stale coverage would let a project that stopped reporting keep its old numbers.
  rmSync(join(ROOT, 'coverage'), { recursive: true, force: true });
  for (const group of ['libs', 'apps']) walk(join(ROOT, group));
}

/** The e2e launches an Electron VS Code, which needs a display. */
function e2eCommand() {
  const command = 'npm exec nx -- run typeqlite-vscode:e2e';
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return command;
  if (spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0) return `xvfb-run --auto-servernum ${command}`;
  throw new Error('the VS Code e2e needs a display, and there is neither a DISPLAY nor `xvfb-run`. Install xvfb, or run `npm run gate -- --quick`.');
}

/** The browser suite needs Playwright's Chromium, which is a separate download. */
function requireChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === 'win32' ? 'AppData/Local/ms-playwright' : process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (!existsSync(cache) || !readdirSync(cache).some((name) => name.startsWith('chromium'))) {
    throw new Error('the browser suite needs Playwright\'s Chromium. Run `npx playwright-core install chromium`, or `npm run gate -- --quick`.');
  }
}

const steps = [
  { name: 'clean', run: clean },
  { name: 'build', command: 'npm run build' },
  { name: 'typecheck', command: 'npm run typecheck' },
  // What `npm publish` would ship, read from `npm pack --dry-run` (tools/check-packages.mjs).
  { name: 'package contents', command: 'npm run check-packages' },
  // The API reference builds with no warning, and every type the API mentions is exported (tools/check-api.mjs).
  { name: 'API', command: 'npm run check-api' },
  // CI=true switches on the 80% coverage floor (vitest.shared.ts), so this is the blocking gate and the
  // coverage job in one. It includes the conformance report card, which fails below baseline.json.
  { name: 'test (with the coverage floor)', command: 'npm test', env: { CI: 'true' } },
  ...(quick
    ? []
    : [
        { name: 'WASM SQLite suite', command: 'npm exec nx -- run typedblite-runtime:test-wasm' },
        { name: 'browser suite (Chromium, OPFS)', run: requireChromium, command: 'npm exec nx -- run typedblite-runtime:test-browser' },
        { name: 'playground in Chromium', run: requireChromium, command: 'npm exec nx -- run playground:test-browser' },
        { name: 'VS Code e2e', command: () => e2eCommand() },
        // The tarballs installed in an empty directory and used (tools/clean-room.mjs). It installs their
        // dependencies from the configured registry, so it needs the network the first time.
        { name: 'clean-room install', command: 'npm run clean-room' },
        // The five-minute tour run as written, from the tarballs (tools/tour.mjs).
        { name: 'five-minute tour', command: 'npm run tour' },
      ]),
];

console.log(`TypeDBLite gate${quick ? ' (quick)' : ''} on Node ${process.versions.node}, ${process.platform}`);
console.log('CI used to run Node 22.16, 22 and 24 on Linux, and Node 24 on Windows and macOS. This runs the one Node you have.\n');

const results = [];
let failed;
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  console.log(`\n=== ${label}`);
  const started = Date.now();
  let ok = true;
  try {
    step.run?.();
    const command = typeof step.command === 'function' ? step.command() : step.command;
    if (command) {
      const result = spawnSync(command, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, NX_SKIP_NX_CACHE: 'true', ...step.env },
      });
      ok = result.status === 0;
    }
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    ok = false;
  }
  results.push({ name: step.name, ok, seconds: Math.round((Date.now() - started) / 1000) });
  if (!ok) {
    failed = step.name;
    break;
  }
}

console.log('\n=== gate summary');
for (const { name, ok, seconds } of results) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name} (${seconds}s)`);
const notRun = steps.slice(results.length).map((step) => step.name);
if (notRun.length > 0) console.log(`  not run: ${notRun.join(', ')}`);
if (quick) console.log('  (quick: the WASM, browser, e2e and clean-room steps were skipped)');
console.log(failed ? `\nGATE FAILED at: ${failed}` : '\nGATE PASSED');
process.exit(failed ? 1 : 0);
