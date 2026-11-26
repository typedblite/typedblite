// Run docs/guides/five-minute-tour.tql.md as a user would: `npm run tour`, after a build. `-- --keep` leaves the
// directory for a look.
//
// The packages are packed, as `npm publish` would, and installed from their tarballs in empty directories
// outside this repository. The tour's own commands and files are then taken from the guide and run, so the
// guide cannot drift from what the packages do. The guide is a notebook (ADR-012) with shell and Node steps between its
// cells, and `tools/tour-doc.mjs` reads it. What this run does with each kind of block:
//
//   <!-- tour:file NAME -->        write the block to NAME in the tour directory
//   <!-- tour:run [exit=N] -->     run the block with bash, expecting exit status N (default 0)
//   <!-- tour:output -->           the block must equal what the previous run block printed (stdout and stderr)
//   <!-- tour:store FILE -->       the reader chooses FILE as the notebook's store and runs the cells again
//   a ```typeql cell               before the store: nothing (the notebook keeps them in memory). From the store on: run on
//                                  the file by the packed CLI, as the notebook would, so the commands that follow see its data
//   <!-- tour:expect -->           skipped here. `apps/vscode/test/tour-journey.test.ts` holds every printed answer to what runs
//                                  on the notebook's own engine, and the VS Code e2e does it in the editor
//
// Two commands are swapped, because nothing is on npm yet: `npx typedblite` runs the CLI installed from its
// tarball, and `npm install @typedblite/runtime` installs the tarballs of the runtime and what it needs. Once
// the packages are published, the first swap can go; the second is what the registry does.
//
// It needs bash, so it does not run on Windows. It does NOT test published packages, or macOS.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHABLE } from './publishable.mjs';
import { parseTour, withoutSqliteWarning } from './tour-doc.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GUIDE = join(ROOT, 'docs/guides/five-minute-tour.tql.md');
const keep = process.argv.includes('--keep');

if (process.platform === 'win32') {
  console.log('tour: skipped on Windows (it runs the guide\'s bash commands)');
  process.exit(0);
}

function run(command, args, cwd, env = {}, timeout = 300_000) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false', ...env },
  });
}

function must(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (${result.error?.message ?? `exit ${result.status}`})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const trimEnds = (text) => text.split('\n').map((line) => line.trimEnd()).join('\n').trim();

for (const { dir } of PUBLISHABLE) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  if (!existsSync(join(ROOT, dir, manifest.main ?? Object.values(manifest.bin)[0]))) {
    console.error(`${manifest.name} is not built. Run \`npm run build\` first.`);
    process.exit(2);
  }
}

const { steps: blocks, problems } = parseTour(readFileSync(GUIDE, 'utf8'));
if (problems.length > 0) throw new Error(`the guide is not marked up correctly:\n${problems.join('\n')}`);
if (!blocks.some((block) => block.kind === 'run')) throw new Error('the guide has no tour:run block');

const room = mkdtempSync(join(tmpdir(), 'typedblite-tour-'));
const tarballs = join(room, 'tarballs');
const tool = join(room, 'tool');
const project = join(room, 'readlist');
for (const dir of [tarballs, tool, project]) mkdirSync(dir);

let failed = false;
try {
  console.log(`tour: ${room}\n`);
  const packed = Object.fromEntries(
    PUBLISHABLE.map(({ project: name, dir }) => {
      const [{ filename }] = JSON.parse(must(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], join(ROOT, dir)), `npm pack ${dir}`));
      return [name, join(tarballs, filename)];
    }),
  );
  const libraries = [packed['content-revision'], packed['typeqlite-language'], packed['typedblite-runtime'], packed['typedblite-session']];

  // `npx typedblite` stands for the CLI installed from its tarball, found on PATH.
  writeFileSync(join(tool, 'package.json'), '{"name":"tour-tool","private":true}\n');
  must(run('npm', ['install', '--no-audit', '--no-fund', ...libraries, packed.typedblite], tool, {}, 600_000), 'npm install (the CLI)');
  const env = { PATH: `${join(tool, 'node_modules/.bin')}${delimiter}${process.env.PATH}` };

  const quote = (path) => `'${path.replace(/'/g, `'\\''`)}'`;
  const swap = (command) =>
    command
      .replace(/\bnpx typedblite\b/g, 'typedblite')
      .replace(/\bnpm install @typedblite\/runtime\b/g, `npm install --no-audit --no-fund ${libraries.map(quote).join(' ')}`);

  let previous; // { stdout, line } of the last run block, for the output block after it
  let store; // the file the notebook was told to use, once the tour says so
  const cells = [];
  /** A cell, run on the notebook's file by the packed CLI, as the notebook would. A refusal is the notebook's answer, not a failure. */
  const runCell = (source, where) => {
    const result = run(join(tool, 'node_modules/.bin/typedblite'), ['--database', store, '--exec', source], project, env, 600_000);
    console.log(`  cell ${where} on ${store.split('/').pop()} (exit ${result.status})`);
  };
  for (const block of blocks) {
    const where = `${GUIDE.replace(`${ROOT}/`, '')}:${block.line}`;
    if (block.kind === 'cell') {
      cells.push(block);
      // In memory until the reader chooses a file: nothing on disk for the commands to see.
      if (store) runCell(block.source, where);
    } else if (block.kind === 'expect') {
      // The answer under a cell: held to what runs by tour-journey.test.ts, on the notebook's own engine.
    } else if (block.kind === 'store') {
      store = join(project, block.file);
      console.log(`  store ${block.file}: the notebook starts again on it, and runs the ${cells.length} cells above`);
      for (const cell of cells) runCell(cell.source, `${GUIDE.replace(`${ROOT}/`, '')}:${cell.line}`);
    } else if (block.kind === 'file') {
      writeFileSync(join(project, block.name), `${block.body}\n`);
      console.log(`  wrote ${block.name}`);
    } else if (block.kind === 'run') {
      const expected = block.exit;
      const result = run('bash', ['-c', `{\n${swap(block.body)}\n} 2>&1`], project, env, 600_000);
      const printed = withoutSqliteWarning(result.stdout ?? '');
      const ok = !result.error && result.status === expected;
      console.log(`  ran ${where} (exit ${result.status}, expected ${expected}) ... ${ok ? 'ok' : 'FAILED'}`);
      if (!ok) {
        console.error(`${block.body}\n--- printed\n${printed}`);
        failed = true;
      }
      previous = { printed, line: block.line };
    } else if (block.kind === 'output') {
      if (!previous) throw new Error(`${where}: a tour:output block must follow a tour:run block`);
      const same = trimEnds(previous.printed) === trimEnds(block.body);
      console.log(`  output ${where} ... ${same ? 'ok' : 'FAILED'}`);
      if (!same) {
        console.error(`--- the guide says\n${block.body}\n--- the command printed\n${previous.printed}`);
        failed = true;
      }
      previous = undefined;
    }
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  failed = true;
} finally {
  if (keep) console.log(`\nkept: ${room}`);
  else rmSync(room, { recursive: true, force: true });
}

console.log(failed ? '\nTOUR FAILED' : '\nthe tour runs as written');
process.exit(failed ? 1 : 0);
