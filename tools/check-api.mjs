// Check the published packages' API: `npm run check-api`, after a build (the language package's generated AST).
//
// 1. TypeDoc runs over the four entry points (typedoc.json) with every warning an error: a broken link or a
//    relative path that is not a file in a doc comment fails it.
// 2. Every type the API mentions must be exported. A public method that takes or returns a type the package
//    does not export is a type a user cannot name; `db.changeLog` was one, typed `ChangeLog`, which nothing
//    exported. TypeDoc's own `notExported` check did not report it (0.28.20), so this reads TypeDoc's JSON:
//    a reference to a symbol in a `@typedblite/*` package that has no page in the reference is one.
//
// An export or member marked `@internal` is left out of the reference (`excludeInternal`), and what it mentions
// is not checked. `npm run docs:api` writes the HTML reference to dist/api.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'typedblite-api-'));
const json = join(scratch, 'api.json');

try {
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/typedoc/bin/typedoc'), '--json', json], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error('\nTypeDoc failed: fix the warnings above.');
    process.exit(1);
  }

  const missing = new Map();
  const walk = (node, owner) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, owner);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const here = node.kind !== undefined && typeof node.name === 'string' ? (owner ? `${owner}.${node.name}` : node.name) : owner;
    const target = node.type === 'reference' ? node.target : undefined;
    if (target && typeof target === 'object' && /^@typedblite\//.test(target.packageName)) {
      const key = `${target.qualifiedName} (${target.packageName}, ${target.packagePath})`;
      if (!missing.has(key)) missing.set(key, new Set());
      missing.get(key).add(owner);
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'target') walk(value, here);
  };
  walk(JSON.parse(readFileSync(json, 'utf8')), '');

  if (missing.size > 0) {
    console.error(`\n${missing.size} type(s) the API mentions but does not export:`);
    for (const [type, owners] of missing) console.error(`  - ${type}, in ${[...owners].slice(0, 3).join(', ')}${owners.size > 3 ? ` and ${owners.size - 3} more` : ''}`);
    console.error('\nExport each from its package entry point, or mark what mentions it `@internal`.');
    process.exit(1);
  }
  console.log('\nThe API reference builds cleanly, and every type it mentions is exported.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
