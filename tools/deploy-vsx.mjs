// Publish both extensions' packaged `.vsix` files to Open VSX: `npm run deploy:vsx`, which packages them first.
// The token is read by `ovsx` from OVSX_PAT.
//
//   npm run deploy:vsx                    publish
//   npm run deploy:vsx -- --pre-release   package both again as pre-releases, and publish those
//   npm run deploy:vsx -- --dry-run       print the commands, and run none of them
//
// A version already published is skipped, so a run that stopped halfway can be run again.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(fileURLToPath(new URL('../apps/vscode', import.meta.url)));
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--dry-run' && arg !== '--pre-release');
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(' ')}\nusage: npm run deploy:vsx [-- --pre-release] [--dry-run]`);
const dryRun = args.includes('--dry-run');
const preRelease = args.includes('--pre-release');

// The Theme Bridge first: the extension's README sends remote-window users to it.
const extensions = [join(APP, 'theme-bridge'), APP].map((dir) => {
  const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return { dir, version, vsix: join(APP, 'dist', `${name}-${version}.vsix`) };
});
// Checked before anything is published, so that one extension does not go out without the other.
if (new Set(extensions.map(({ version }) => version)).size > 1) fail('the two extensions do not have the same version');
for (const { vsix } of extensions) if (!existsSync(vsix)) fail(`${vsix} is not there: run \`npm run deploy:vsx\`, which packages first`);

function run(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  if (dryRun) return;
  // `npx` is a .cmd file on Windows, which needs a shell.
  const { status } = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (status !== 0) process.exit(status ?? 1);
}

if (preRelease) {
  for (const { dir } of extensions) run('npx', ['vsce', 'package', '--no-dependencies', '--pre-release', '--out', join(APP, 'dist/')], dir);
}
for (const { vsix } of extensions) run('npx', ['--yes', 'ovsx@1.3.0', 'publish', vsix, '--skip-duplicate'], APP);
