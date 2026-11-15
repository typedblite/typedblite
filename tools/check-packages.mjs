// Check what each published package would actually ship: `npm run check-packages`, after a build.
//
// It reads `npm pack --dry-run`, the same file list `npm publish` uses, so it judges the tarball and not the
// manifest's intent. Before this check, `@typedblite/runtime` and `@typedblite/content-revision` had no `files`
// list, so npm fell back to .gitignore, which excludes `out/`: they would have published their TypeScript sources,
// tests and bench, and no JavaScript at all.
//
// Every problem is printed, not just the first, and the exit code is 1 if there was any.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHABLE, REPOSITORY } from './publishable.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

/** Paths that belong in the repository and never in a tarball. */
const NEVER_SHIPPED = [
  [/(^|\/)(test|tests|test-browser|bench|e2e)\//, 'a test or bench directory'],
  [/\.(test|spec)\.[cm]?[jt]s(\.map)?$/, 'a test file'],
  [/\.test\.d\.[cm]?ts(\.map)?$/, 'a test declaration'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'a tsconfig'],
  [/\.tsbuildinfo$/, 'a TypeScript build-info file'],
  [/(^|\/)vitest[^/]*\.[cm]?[jt]s$/, 'a Vitest config'],
  [/(^|\/)project\.json$/, 'an Nx project file'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/(^|\/)\.env/, 'an env file'],
];

/** Every file path a manifest field points at: `main`, `types`, `bin`, and the leaves of `exports` and `imports`. */
function referencedPaths(manifest) {
  const found = [];
  const walk = (value, where) => {
    if (typeof value === 'string') {
      if (value.startsWith('./') || !value.includes(':')) found.push([where, value]);
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${where}.${key}`);
    }
  };
  for (const field of ['main', 'module', 'types', 'typings']) if (manifest[field]) walk(manifest[field], field);
  if (typeof manifest.bin === 'string') walk(manifest.bin, 'bin');
  else if (manifest.bin) walk(manifest.bin, 'bin');
  if (manifest.exports) walk(manifest.exports, 'exports');
  if (manifest.imports) walk(manifest.imports, 'imports');
  return found;
}

function pack(dir) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: join(ROOT, dir),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`npm pack failed in ${dir}:\n${result.stderr}`);
  return JSON.parse(result.stdout)[0];
}

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

const root = readJson('package.json');
const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
const versions = new Map(PUBLISHABLE.map(({ dir }) => [readJson(`${dir}/package.json`).name, readJson(`${dir}/package.json`).version]));

// The release configuration and this list name the same projects, so `nx release` versions what this checks.
const released = readJson('nx.json').release?.projects ?? [];
const listed = PUBLISHABLE.map(({ project }) => project);
if (JSON.stringify([...released].sort()) !== JSON.stringify([...listed].sort())) {
  fail('nx.json', `release.projects is [${released.join(', ')}], but tools/publishable.mjs lists [${listed.join(', ')}]`);
}
// A maintainer's .npmrc may point npm at a mirror or a local proxy (this one's did); a release goes to the public
// registry, and Nx checks there whether the version is already published.
const publishRegistry = readJson('nx.json').targetDefaults?.['nx-release-publish']?.options?.registry;
if (publishRegistry !== 'https://registry.npmjs.org/') {
  fail('nx.json', `targetDefaults.nx-release-publish.options.registry is ${publishRegistry}, expected https://registry.npmjs.org/`);
}

// A workspace package that is never published (the conformance suite, the demos, the extension, which bundles)
// depends on a published one by "*". npm links the workspace copy for "*" whatever its version, prerelease
// included, so a release that bumps the published packages does not leave these asking the registry for the
// old version. An exact version here would.
const publishedDirs = new Set(PUBLISHABLE.map(({ dir }) => dir));
for (const group of ['libs', 'apps']) {
  for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
    const dir = `${group}/${entry.name}`;
    if (!entry.isDirectory() || publishedDirs.has(dir) || !existsSync(join(ROOT, dir, 'package.json'))) continue;
    const manifest = readJson(`${dir}/package.json`);
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (versions.has(dependency) && range !== '*') fail(manifest.name ?? dir, `${field} has ${dependency}@${range}; a workspace package that is not published uses "*"`);
      }
    }
  }
}

for (const { dir } of PUBLISHABLE) {
  const manifest = readJson(`${dir}/package.json`);
  const where = manifest.name ?? dir;
  const tarball = pack(dir);
  const files = new Set(tarball.files.map((file) => file.path));

  // What the manifest promises is in the tarball.
  for (const [field, path] of referencedPaths(manifest)) {
    const normal = posix.normalize(path);
    if (!files.has(normal)) fail(where, `${field} points at ${path}, which is not in the tarball (has the project been built?)`);
  }
  if (!manifest.files) fail(where, 'has no `files` allowlist, so npm falls back to .gitignore, which excludes build output');

  // A `bin` without its interpreter line is run by a POSIX shell as a shell script.
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const bin of bins) {
    const path = join(ROOT, dir, bin);
    const first = files.has(posix.normalize(bin)) ? readFileSync(path, 'utf8').split('\n', 1)[0] : undefined;
    if (first !== undefined && first !== '#!/usr/bin/env node') fail(where, `bin ${bin} starts "${first}", not "#!/usr/bin/env node"`);
  }

  // Nothing that belongs only in the repository.
  for (const file of files) {
    for (const [pattern, what] of NEVER_SHIPPED) if (pattern.test(file)) fail(where, `ships ${what}: ${file}`);
  }

  // A source map points at its source, and a declaration map at its declaration's source; ship what they name.
  for (const file of files) {
    if (!file.endsWith('.map')) continue;
    const map = JSON.parse(readFileSync(join(ROOT, dir, file), 'utf8'));
    for (const source of map.sources ?? []) {
      const target = posix.normalize(posix.join(posix.dirname(file), source));
      if (!files.has(target)) fail(where, `${file} names ${target}, which is not in the tarball`);
    }
  }

  // The files a user and a lawyer look for.
  if (!files.has('README.md')) fail(where, 'has no README.md');
  if (!files.has('LICENSE')) fail(where, 'has no LICENSE');
  else if (readFileSync(join(ROOT, dir, 'LICENSE'), 'utf8') !== license) fail(where, 'LICENSE differs from the repository root LICENSE');

  // Metadata.
  if (manifest.license !== root.license) fail(where, `license is ${manifest.license}, the repository's is ${root.license}`);
  if (manifest.engines?.node !== root.engines.node) fail(where, `engines.node is ${manifest.engines?.node}, the repository's is ${root.engines.node}`);
  if (!manifest.description) fail(where, 'has no description');
  if (!manifest.keywords?.length) fail(where, 'has no keywords');
  if (manifest.repository?.url !== `git+${REPOSITORY}.git`) fail(where, `repository.url is ${manifest.repository?.url}, expected git+${REPOSITORY}.git`);
  if (manifest.repository?.directory !== dir) fail(where, `repository.directory is ${manifest.repository?.directory}, expected ${dir}`);
  if (manifest.bugs?.url !== `${REPOSITORY}/issues`) fail(where, `bugs.url is ${manifest.bugs?.url}`);
  if (!manifest.homepage?.startsWith(REPOSITORY)) fail(where, `homepage is ${manifest.homepage}`);
  if (manifest.name.startsWith('@') && manifest.publishConfig?.access !== 'public') {
    fail(where, 'is scoped, so it needs publishConfig.access "public", or npm publishes it as restricted');
  }
  // Nx release sets the registry (below, from nx.json). One in the manifest would override `--registry`, and Nx's
  // "is this version already published?" check ignores it, so it would look in one registry and publish to another.
  if (manifest.publishConfig?.registry) fail(where, 'sets publishConfig.registry; the registry belongs on nx-release-publish in nx.json');

  // The packages are released together, at one version, and depend on each other exactly.
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!versions.has(dependency)) continue;
    if (range !== versions.get(dependency)) fail(where, `depends on ${dependency}@${range}, but that package is at ${versions.get(dependency)}`);
  }
  if (manifest.version !== versions.values().next().value) fail(where, `is at ${manifest.version}, the others at ${versions.values().next().value}`);

  console.log(`  ${where}@${manifest.version}: ${files.size} files, ${(tarball.size / 1024).toFixed(1)} kB packed`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log('\nEvery package ships what it should.');
