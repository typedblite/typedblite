// Write the licence notices of the third-party code inside a bundle:
// `node tools/third-party-notices.mjs <out> <esbuild metafile>...`, run from the folder the bundles ship from.
//
// The list comes from the metafiles, so it is what esbuild put in the bundles and not what a manifest declares.
// A metafile's paths are relative to the folder esbuild ran in: the metafile's parent's parent (`<app>/dist/meta.json`).
// A package with no licence field or file stops the build.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [out, ...metafiles] = process.argv.slice(2);
if (!out || metafiles.length === 0) {
  console.error('usage: node tools/third-party-notices.mjs <out> <metafile>...');
  process.exit(1);
}

/** The folder of every package under `node_modules` that contributed bytes to an output. */
const folders = new Set();
for (const metafile of metafiles) {
  const base = dirname(dirname(resolve(metafile)));
  for (const output of Object.values(JSON.parse(readFileSync(metafile, 'utf8')).outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (match && bytesInOutput > 0) folders.add(resolve(base, match[1]));
    }
  }
}

const packages = new Map();
const problems = [];
for (const folder of folders) {
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  const { name, version, repository } = manifest;
  // `licenses` is the old form of the field, which a few packages still use.
  const license = manifest.license ?? manifest.licenses?.map(({ type }) => type).join(' OR ');
  const texts = readdirSync(folder)
    .filter((file) => /^(licen[cs]e|copying|notice|thirdpartynotice)/i.test(file))
    .sort()
    .map((file) => readFileSync(join(folder, file), 'utf8').replace(/\r\n/g, '\n').trim());
  if (!license && texts.length === 0) problems.push(`${name}@${version}: no licence field and no licence file`);
  const url = typeof repository === 'string' ? repository : repository?.url;
  const source = url
    ?.replace(/^git\+/, '')
    .replace(/^(git:\/\/|ssh:\/\/git@|git@github\.com:)/, (prefix) => (prefix === 'git@github.com:' ? 'https://github.com/' : 'https://'))
    .replace(/^(github:)?([\w.-]+\/[\w.-]+)$/, 'https://github.com/$2')
    .replace(/\.git$/, '');
  packages.set(`${name}@${version}`, { license, source, texts });
}
if (problems.length > 0 || packages.size === 0) {
  console.error(problems.join('\n') || `no third-party package found in ${metafiles.join(', ')}`);
  process.exit(1);
}

const rule = '-'.repeat(80);
const sections = [...packages.keys()].sort().map((id) => {
  const { license, source, texts } = packages.get(id);
  const head = [id, `License: ${license ?? 'see below'}`, ...(source ? [`Source: ${source}`] : [])];
  return [rule, ...head, '', ...(texts.length > 0 ? texts : ['(The package ships no licence file.)'])].join('\n');
});
const intro = [
  'THIRD-PARTY NOTICES',
  '',
  'This extension includes the code of the packages below, bundled and minified. Each stays under its own licence.',
  'The source of each package, including those under the Mozilla Public License 2.0, is at the address given for it,',
  'and its published form is on https://www.npmjs.com.',
].join('\n');
writeFileSync(out, `${[intro, ...sections].join('\n\n')}\n`);
const bare = [...packages].filter(([, { texts }]) => texts.length === 0).map(([id]) => id);
console.log(`${out}: ${packages.size} packages${bare.length ? `; no licence file in ${bare.join(', ')}` : ''}`);
