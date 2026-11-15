// Install the packages as a user would, from their tarballs, in an empty directory outside this repository,
// and use them: `npm run clean-room`, after a build. `-- --keep` leaves the directory for a look.
//
// Nothing here can see the workspace: no symlinks, no path aliases, no hoisted devDependencies. Dependencies
// come from the registry npm is configured with, so the first run downloads them. It checks:
//   1. the `typedblite` CLI, through its npm `bin` link, keeping data in a file between runs;
//   2. the runtime on `node:sqlite`, with the language and content-revision packages and the TextMate grammar;
//   3. the runtime on WASM SQLite (`@typedblite/runtime/wasm`), in Node;
//   4. the published declarations, type-checked by `tsc` without `skipLibCheck`;
//   5. the `browser` export condition, bundled for a browser, reaching no `node:` module.
//
// This is the Linux leg of the plan's clean-room test; macOS and Windows wait on CI. It does NOT test published
// packages (none exist yet), the README's words, or the VS Code extension.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHABLE } from './publishable.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const keep = process.argv.includes('--keep');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const WINDOWS = process.platform === 'win32';

/**
 * Run a command; return its stdout, or throw with everything it printed.
 *
 * Every command has a time limit. A CLI that has lost its `#!/usr/bin/env node` line is run by a POSIX shell as
 * a shell script, and its first line, `import { … }`, is ImageMagick's screenshot command where that is
 * installed: it waits for a click, forever. Killing `npm exec` would leave that shell and `import` behind, so
 * off Windows the command runs as the leader of its own process group, and a timeout kills the whole group.
 */
function run(command, args, cwd, label = `${command} ${args.join(' ')}`, timeout = 120_000) {
  const quoted = WINDOWS ? args.map((arg) => (/[\s"'<>|&^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)) : args;
  const result = spawnSync(command, quoted, {
    cwd,
    encoding: 'utf8',
    shell: WINDOWS,
    detached: !WINDOWS,
    timeout,
    killSignal: 'SIGKILL',
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.error?.code === 'ETIMEDOUT') {
    if (!WINDOWS && result.pid) {
      try {
        process.kill(-result.pid, 'SIGKILL');
      } catch {
        // The group had already gone.
      }
    }
    throw new Error(`${label} did not finish within ${timeout / 1000}s, and was killed`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited ${result.status}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
  }
  return result.stdout;
}

for (const { dir } of PUBLISHABLE) {
  const manifest = readJson(join(ROOT, dir, 'package.json'));
  if (!existsSync(join(ROOT, dir, manifest.main ?? Object.values(manifest.bin)[0]))) {
    console.error(`${manifest.name} is not built. Run \`npm run build\` first.`);
    process.exit(2);
  }
}

const room = mkdtempSync(join(tmpdir(), 'typedblite-clean-room-'));
const tarballs = join(room, 'tarballs');
const app = join(room, 'app');
mkdirSync(tarballs);
mkdirSync(app);

const checks = [];
let failed = false;
function check(name, work) {
  process.stdout.write(`  ${name} ... `);
  try {
    work();
    console.log('ok');
    checks.push([name, true]);
  } catch (error) {
    console.log('FAILED');
    console.error(error instanceof Error ? error.message : String(error));
    checks.push([name, false]);
    failed = true;
  }
}

try {
  console.log(`clean room: ${room}\n`);

  // Pack, as `npm publish` would, and install the tarballs together, so each internal dependency is met by
  // its tarball and not looked up on the registry.
  const packed = PUBLISHABLE.map(({ dir }) => {
    const [{ filename }] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], join(ROOT, dir)));
    return join(tarballs, filename);
  });
  const rootManifest = readJson(join(ROOT, 'package.json'));
  const runtimeManifest = readJson(join(ROOT, 'libs/runtime/package.json'));
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'clean-room', private: true, type: 'module' }, null, 2)}\n`);
  run(
    'npm',
    [
      'install', '--no-audit', '--no-fund', '--save-exact',
      ...packed,
      // What a user adds alongside: the optional WASM peer, and a TypeScript toolchain.
      `@sqlite.org/sqlite-wasm@${runtimeManifest.devDependencies['@sqlite.org/sqlite-wasm']}`,
      `typescript@${rootManifest.devDependencies.typescript}`,
      `@types/node@${rootManifest.devDependencies['@types/node']}`,
    ],
    app,
    'npm install (the tarballs and their dependencies)',
    600_000,
  );

  check('the typedblite CLI, through its bin link, on a file database', () => {
    const cli = (...args) => run('npm', ['exec', '--offline', '--', 'typedblite', '--database', 'store.db', ...args], app, `typedblite ${args.join(' ')}`, 30_000);
    cli('--exec', 'define entity person, owns name @key; attribute name, value string;');
    cli('--exec', 'insert $p isa person, has name "Alice";');
    const out = cli('--exec', 'match $p isa person, has name $n; select $n;');
    if (!out.includes('n=Alice')) throw new Error(`expected n=Alice, got:\n${out}`);
  });

  check('the runtime on node:sqlite, with the language and content-revision packages', () => {
    writeFileSync(
      join(app, 'node.mjs'),
      `import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { createTypeQLiteServices, validateSync } from '@typedblite/language';
import * as revision from '@typedblite/content-revision';
import grammar from '@typedblite/language/typeqlite.tmLanguage.json' with { type: 'json' };
import { EmptyFileSystem } from 'langium';

const db = new TypeDBLiteInterpreter(':memory:');
db.define('define entity person, owns name @key; attribute name, value string;');
db.execute('insert $p isa person, has name "Alice";');
const { rows } = db.query('match $p isa person, has name $n; select $n;');
assert.equal(rows[0]?.n.asString(), 'Alice');
assert.ok(db.changeLog.since().length > 0, 'the change log recorded the insert');

const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);
const parsed = TypeQLite.parser.LangiumParser.parse('define entity person, owns name; attribute name, value string;');
assert.deepEqual([...parsed.lexerErrors, ...parsed.parserErrors], []);
assert.deepEqual(validateSync(TypeQLite, parsed.value), []);

assert.ok(Object.keys(revision).length > 0, 'content-revision exports something');
assert.equal(grammar.scopeName, 'source.typeqlite', 'the TextMate grammar is exported');
`,
    );
    run('node', ['--no-warnings', 'node.mjs'], app);
  });

  check('the runtime on WASM SQLite, in Node', () => {
    writeFileSync(
      join(app, 'wasm.mjs'),
      `import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';

await initWasmSqlite();
const db = new TypeDBLiteInterpreter('/clean-room.db', undefined, { openDatabase: openWasmSqlite });
db.define('define entity person, owns name @key; attribute name, value string;');
db.execute('insert $p isa person, has name "Alice";');
const { rows } = db.query('match $p isa person, has name $n; select $n;');
assert.equal(rows[0]?.n.asString(), 'Alice');
`,
    );
    run('node', ['--no-warnings', 'wasm.mjs'], app);
  });

  check('the declarations, type-checked by tsc without skipLibCheck', () => {
    writeFileSync(
      join(app, 'tsconfig.json'),
      `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] }, files: ['typed.ts'] }, null, 2)}\n`,
    );
    writeFileSync(
      join(app, 'typed.ts'),
      `import { TypeDBLiteInterpreter, DiagnosticCode, type SqliteDatabase } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';
import { createTypeQLiteServices, validateSync, type TypeQLiteFile } from '@typedblite/language';
import * as revision from '@typedblite/content-revision';

const db: TypeDBLiteInterpreter = new TypeDBLiteInterpreter(':memory:', undefined, { openDatabase: openWasmSqlite });
const name: string | undefined = db.query('match $p isa person, has name $n; select $n;').rows[0]?.n.asString();
const binding: SqliteDatabase | undefined = undefined;
const services = createTypeQLiteServices;
const file: TypeQLiteFile | undefined = undefined;
export { name, binding, services, file, validateSync, initWasmSqlite, DiagnosticCode, revision };
`,
    );
    run('node', [join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], app, 'tsc');
  });

  check('the browser export condition reaches no node: module', () => {
    // The repository's esbuild bundles, but every import resolves from the clean room's node_modules.
    const esbuild = createRequire(join(ROOT, 'package.json'))('esbuild');
    writeFileSync(join(app, 'browser.mjs'), `export { TypeDBLiteInterpreter } from '@typedblite/runtime';\nexport { openWasmSqlite } from '@typedblite/runtime/wasm';\n`);
    // A `node:` import a browser cannot meet fails the build here ("Could not resolve"), and one esbuild
    // leaves external would still be named in the output, which the match below catches.
    const { outputFiles } = esbuild.buildSync({
      absWorkingDir: app,
      entryPoints: ['browser.mjs'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const bundle = outputFiles[0].text;
    const reached = bundle.match(/["']node:[a-z_/]+["']/g);
    if (reached) throw new Error(`the browser bundle names ${[...new Set(reached)].join(', ')}`);
  });
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  failed = true;
} finally {
  if (keep) console.log(`\nkept: ${room}`);
  else rmSync(room, { recursive: true, force: true });
}

console.log(`\n${checks.filter(([, ok]) => ok).length} of ${checks.length} checks passed${failed ? '; CLEAN ROOM FAILED' : ''}`);
process.exit(failed ? 1 : 0);
