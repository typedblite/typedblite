// Run docs/guides/five-minute-tour.md as a user would: `npm run tour`, after a build. `-- --keep` leaves the
// directory for a look.
//
// The packages are packed, as `npm publish` would, and installed from their tarballs in empty directories
// outside this repository. The tour's own commands and files are then taken from the guide and run, so the
// guide cannot drift from what the packages do. Three kinds of marker, each an HTML comment on the line before
// a fenced block, say what to do with it; unmarked blocks are prose and are not run:
//
//   <!-- tour:file NAME -->        write the block to NAME in the tour directory
//   <!-- tour:run [exit=N] -->     run the block with bash, expecting exit status N (default 0)
//   <!-- tour:output -->           the block must equal what the previous run block printed (stdout and stderr)
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

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GUIDE = join(ROOT, 'docs/guides/five-minute-tour.md');
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

/** The guide's blocks, in order: { kind: 'file' | 'run' | 'output', arg, body, line }. */
function parseGuide(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const marker = /^<!--\s*tour:(file|run|output)\s*(.*?)\s*-->$/.exec(lines[i]);
    if (!marker) continue;
    const open = lines[i + 1] ?? '';
    if (!/^```/.test(open)) throw new Error(`${GUIDE}:${i + 1}: a tour marker must be followed by a fenced block`);
    const body = [];
    let j = i + 2;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) body.push(lines[j++]);
    if (j >= lines.length) throw new Error(`${GUIDE}:${i + 1}: the fenced block is not closed`);
    blocks.push({ kind: marker[1], arg: marker[2], body: body.join('\n'), line: i + 1 });
    i = j;
  }
  return blocks;
}

const trimEnds = (text) => text.split('\n').map((line) => line.trimEnd()).join('\n').trim();

for (const { dir } of PUBLISHABLE) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  if (!existsSync(join(ROOT, dir, manifest.main ?? Object.values(manifest.bin)[0]))) {
    console.error(`${manifest.name} is not built. Run \`npm run build\` first.`);
    process.exit(2);
  }
}

const blocks = parseGuide(readFileSync(GUIDE, 'utf8'));
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
  for (const block of blocks) {
    const where = `${GUIDE.replace(`${ROOT}/`, '')}:${block.line}`;
    if (block.kind === 'file') {
      writeFileSync(join(project, block.arg), `${block.body}\n`);
      console.log(`  wrote ${block.arg}`);
    } else if (block.kind === 'run') {
      const expected = Number(/exit=(\d+)/.exec(block.arg)?.[1] ?? 0);
      const result = run('bash', ['-c', `{\n${swap(block.body)}\n} 2>&1`], project, env, 600_000);
      const printed = result.stdout ?? '';
      const ok = !result.error && result.status === expected;
      console.log(`  ran ${where} (exit ${result.status}, expected ${expected}) ... ${ok ? 'ok' : 'FAILED'}`);
      if (!ok) {
        console.error(`${block.body}\n--- printed\n${printed}`);
        failed = true;
      }
      previous = { printed, line: block.line };
    } else {
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
