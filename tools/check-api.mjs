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
//
// 3. Every name the API exports has a doc comment, and so has every member a class or interface declares itself
//    (one it inherits is described where it is declared). The reference shows the first line of that comment beside the
//    name, so a missing one is a gap in what a reader sees. The generated syntax tree (`src/generated/`) is documented
//    by libs/language/scripts/document-generated.mts, and is checked like the rest.
//
// 4. No doc comment shows a `🔴` or `⚠️` note. Those mark a maintainer's note (why something is as it is, how it was
//    found), and belong under `@privateRemarks`, which the reference leaves out.
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

  // 3. A doc comment on every export, and on every member declared in this repository.
  const api = JSON.parse(readFileSync(json, 'utf8'));
  const REFERENCE = 4194304; // TypeDoc's ReflectionKind.Reference: a re-export, described where it is declared
  const described = (reflection) => {
    const comment =
      reflection.comment ??
      reflection.signatures?.[0]?.comment ??
      reflection.getSignature?.comment ??
      reflection.setSignature?.comment ??
      reflection.type?.declaration?.comment;
    return (comment?.summary ?? []).some((part) => (part.text ?? '').trim() !== '');
  };
  const visibleText = (reflection) => {
    const comments = [reflection.comment, ...(reflection.signatures ?? []).map((s) => s.comment), reflection.getSignature?.comment, reflection.type?.declaration?.comment];
    return comments
      .flatMap((comment) => [...(comment?.summary ?? []), ...(comment?.blockTags ?? []).filter((tag) => tag.tag !== '@privateRemarks').flatMap((tag) => tag.content ?? [])])
      .map((part) => part.text ?? '')
      .join('');
  };
  const noted = [];
  const undocumented = [];
  for (const module of api.children ?? []) {
    for (const exported of module.children ?? []) {
      if (exported.kind !== REFERENCE && !described(exported)) undocumented.push(`${module.name}: ${exported.name}`);
      if (/🔴|⚠️/.test(visibleText(exported))) noted.push(`${module.name}: ${exported.name}`);
      for (const member of exported.children ?? []) {
        const inherited = member.inheritedFrom ?? member.signatures?.[0]?.inheritedFrom;
        if (!inherited && member.sources && !described(member)) undocumented.push(`${module.name}: ${exported.name}.${member.name}`);
        if (!inherited && /🔴|⚠️/.test(visibleText(member))) noted.push(`${module.name}: ${exported.name}.${member.name}`);
      }
    }
  }
  if (undocumented.length > 0) {
    console.error(`\n${undocumented.length} name(s) in the API have no doc comment:`);
    for (const name of undocumented.slice(0, 40)) console.error(`  - ${name}`);
    if (undocumented.length > 40) console.error(`  … and ${undocumented.length - 40} more`);
    console.error('\nAdd a doc comment (its first sentence is what the reference shows), or mark it `@internal`.');
    process.exit(1);
  }
  if (noted.length > 0) {
    console.error(`\n${noted.length} doc comment(s) show a 🔴 or ⚠️ note in the API reference:`);
    for (const name of noted.slice(0, 40)) console.error(`  - ${name}`);
    console.error('\nMove the note under `@privateRemarks`, which the reference leaves out.');
    process.exit(1);
  }
  console.log('\nThe API reference builds cleanly, every type it mentions is exported, every name has a doc comment, and none shows a maintainer note.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
