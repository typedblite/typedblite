import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A CommonJS host `require`s this package, built, through a linked dependency, as a host installs it from a
 * `file:` path. Node loads an ES module from `require`, and the engine is loaded on the first open, from where this
 * package is installed: not from the host's directory, which has no engine of its own.
 *
 * Runs the build output (`out/`), so the `test` target builds first.
 */
describe('a CommonJS host', () => {
  let host: string;

  beforeEach(() => {
    host = mkdtempSync(join(tmpdir(), 'node-host-cjs-'));
    mkdirSync(join(host, 'node_modules', '@typedblite'), { recursive: true });
    symlinkSync(PACKAGE, join(host, 'node_modules', '@typedblite', 'node-host'), 'dir');
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'cjs-host', private: true, type: 'commonjs' }));
  });
  afterEach(() => rmSync(host, { recursive: true, force: true }));

  it('requires the package, opens a store, writes, and reads the row back', () => {
    expect(existsSync(join(PACKAGE, 'out', 'index.js'))).toBe(true);
    // The host has no engine of its own: the package finds the one installed beside it.
    expect(existsSync(join(host, 'node_modules', '@typedblite', 'runtime'))).toBe(false);
    writeFileSync(
      join(host, 'main.cjs'),
      `
const { openSchemaDatabase, requiredRowString, loadTypeDbLiteRuntime } = require('@typedblite/node-host');
(async () => {
  const { database, report } = await openSchemaDatabase(
    { name: 'cjs' },
    'define attribute code, value string; entity item, owns code @key;',
  );
  await database.execute('insert $i isa item, has code "from-commonjs";');
  const { rows } = await database.query('match $i isa item, has code $c; select $c;');
  const runtime = await loadTypeDbLiteRuntime();
  console.log(JSON.stringify({
    code: requiredRowString(rows[0], 'c'),
    diagnostics: Array.isArray(report.diagnostics),
    engine: typeof runtime.SqliteEngine,
  }));
  await database.close();
})().catch((error) => { console.error(error); process.exit(1); });
`,
    );

    const output = execFileSync(process.execPath, [join(host, 'main.cjs')], { cwd: host, encoding: 'utf8' });

    expect(JSON.parse(output.trim())).toEqual({ code: 'from-commonjs', diagnostics: true, engine: 'function' });
  });
});

/**
 * The loader's fallback: the native `import('@typedblite/runtime')` is made to fail by a resolve hook (a stand-in
 * for a build that rewrote it), and the engine must then be found from this module's own directory, as the
 * README promises. Runs the build output in a real Node process, in both module systems, so each branch of
 * `thisModuleDirectory()` (`__dirname`, then `import.meta.url`) is taken. The hook records that it fired, so a
 * pass cannot come from the native import quietly succeeding.
 */
describe('the loader fallback when the native engine import fails', () => {
  let host: string;

  beforeEach(() => {
    host = mkdtempSync(join(tmpdir(), 'node-host-fallback-'));
    mkdirSync(join(host, 'node_modules', '@typedblite'), { recursive: true });
    symlinkSync(PACKAGE, join(host, 'node_modules', '@typedblite', 'node-host'), 'dir');
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'fallback-host', private: true }));
    writeFileSync(
      join(host, 'block.mjs'),
      `
import { writeFileSync } from 'node:fs';
export async function resolve(specifier, context, next) {
  if (specifier === '@typedblite/runtime') {
    writeFileSync(${JSON.stringify(join(host, 'blocked'))}, 'blocked');
    throw new Error('blocked by the test: native import of the engine');
  }
  return next(specifier, context);
}
`,
    );
    writeFileSync(
      join(host, 'register.mjs'),
      `import { register } from 'node:module';\nregister('./block.mjs', import.meta.url);\n`,
    );
  });
  afterEach(() => rmSync(host, { recursive: true, force: true }));

  const body = `
(async () => {
  const { openSchemaDatabase, requiredRowString } = LOAD;
  const { database } = await openSchemaDatabase({ name: 'fb' }, 'define attribute code, value string; entity item, owns code @key;');
  await database.execute('insert $i isa item, has code "via-fallback";');
  const { rows } = await database.query('match $i isa item, has code $c; select $c;');
  console.log(requiredRowString(rows[0], 'c'));
  await database.close();
})().catch((error) => { console.error(error); process.exit(1); });
`;

  it.each([
    ['CommonJS (__dirname)', 'main.cjs', `require('@typedblite/node-host')`],
    ['native ESM (import.meta.url)', 'main.mjs', `await import('@typedblite/node-host')`],
  ])('finds the installed engine from this module\'s directory in %s', (_name, file, load) => {
    writeFileSync(join(host, file), body.replace('LOAD', load));

    const output = execFileSync(process.execPath, ['--import', join(host, 'register.mjs'), join(host, file)], {
      cwd: host,
      encoding: 'utf8',
    });

    expect(output.trim()).toBe('via-fallback');
    expect(existsSync(join(host, 'blocked'))).toBe(true);
  });
});
